/**
 * Second gate for shop, travel, and life uploads. Structural checks already
 * dropped public pages. Gemini still has to accept each remaining row before
 * it is written. A missing or failed review accepts nothing.
 */

const { callGeminiJson, defaultGeminiModel } = require('./lifeContextGemini');
const { requiresOwnAccountRecord } = require('../utils/ownOrderRecord');

const CHUNK_SIZE = 20;

function clean(value, max) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function pagePath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}`.slice(0, 160);
  } catch {
    return '';
  }
}

function briefRow(item, reviewId) {
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  return {
    id: reviewId,
    source: clean(item.source, 40),
    type: clean(item.type, 20),
    title: clean(payload.productTitle || payload.title || payload.name || '', 120),
    orderId: clean(payload.orderId || payload.orderid || payload.bookingId || payload.tripId || payload.id || '', 80),
    date: clean(payload.orderDate || payload.date || payload.startDate || payload.checkIn || '', 40),
    status: clean(payload.status || payload.orderStatus || '', 40),
    price: clean(payload.price || '', 24),
    page: pagePath(metadata.sourceUrl || ''),
    href: pagePath(payload.href || ''),
  };
}

function qualityPrompt(rows) {
  return [
    'Decide whether each crawled row is the signed-in account\'s own order, purchase, booking, or trip.',
    'Accept a row only when it is that person\'s own past record: it has an order, booking, or trip id, and it came from an account orders, purchases, or trips page.',
    'Reject product listings, recommendations, brand pages, category pages, search results, and rows whose id is a product name or product slug.',
    'A price and a product title are not an order. A product link on an orders page is not an order unless the row itself is one purchase.',
    'Do not invent order ids, dates, or statuses.',
    'Return JSON only: { "accept": ["id"], "reject": [{ "id": "id", "reason": "short reason" }] }',
    'Every input id must appear in exactly one of accept or reject. If unsure, reject it.',
    '',
    JSON.stringify(rows),
  ].join('\n');
}

function acceptedIds(parsed) {
  const ids = new Set();
  for (const id of parsed?.accept || []) {
    if (id) ids.add(String(id));
  }
  return ids;
}

/**
 * @param {Array} items rows that already passed structural validation
 * @param {(prompt: string, model: string) => Promise<object>} [ask]
 */
async function reviewAccountRecords(items, ask = callGeminiJson) {
  const accepted = [];
  const rejected = [];
  const gated = [];
  items.forEach((item, index) => {
    if (!requiresOwnAccountRecord(item.source)) {
      accepted.push(item);
      return;
    }
    gated.push({ item, reviewId: `r${index}` });
  });
  if (!gated.length) return { accepted, rejected };

  const model = defaultGeminiModel();
  const allowed = new Set();
  const reasons = new Map();
  for (let i = 0; i < gated.length; i += CHUNK_SIZE) {
    const chunk = gated.slice(i, i + CHUNK_SIZE);
    try {
      const parsed = await ask(qualityPrompt(chunk.map((row) => briefRow(row.item, row.reviewId))), model);
      const chunkAllowed = acceptedIds(parsed);
      for (const row of chunk) {
        if (chunkAllowed.has(row.reviewId)) allowed.add(row.reviewId);
        else {
          const reason = (parsed?.reject || []).find((entry) => String(entry?.id || '') === row.reviewId);
          reasons.set(row.reviewId, clean(reason?.reason || 'not an own record', 160));
        }
      }
    } catch {
      for (const row of chunk) reasons.set(row.reviewId, 'quality check unavailable');
    }
  }

  for (const row of gated) {
    if (allowed.has(row.reviewId)) accepted.push(row.item);
    else {
      rejected.push({
        item: row.item,
        reason: reasons.get(row.reviewId) || 'not an own record',
      });
    }
  }
  return { accepted, rejected };
}

module.exports = {
  reviewAccountRecords,
};
