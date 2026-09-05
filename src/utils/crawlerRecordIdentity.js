/**
 * Connect Earn identity after the Wallet client extracts and cleans rows.
 * Catalog uploads (shop / social / travel / life) are title-first (order
 * id optional). Core Luma / Airbnb / Booking keep official ids when present;
 * client-smoothed generic fallbacks may use a title: key. Amazon stays
 * official-id only.
 */

const { isCatalogCrawlerSource } = require('../constants/crawlerSources');

const TITLE_BACKED_PREFIX = 'title:';

/** Core hosts that may fall back to title: when the client sent a smoothed row. */
const TITLE_BACKED_SMOOTHED_CORE = new Set(['luma', 'airbnb', 'booking']);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function payloadTitle(payload) {
  const row = asRecord(payload);
  return normalizeText(
    row.productTitle ||
      row.title ||
      row.name ||
      row.bookingName ||
      row.hotelName ||
      row.listingTitle ||
      row.eventName ||
      row.caption ||
      row.text ||
      row.handle ||
      '',
  );
}

function payloadDate(payload) {
  const row = asRecord(payload);
  return normalizeText(
    row.date || row.orderDate || row.startDate || row.checkIn || row.dueDate || '',
  );
}

function hostFromMetadata(metadata) {
  const row = asRecord(metadata);
  const explicit = normalizeText(row.host).replace(/^www\./, '');
  if (explicit) return explicit;
  const url = String(row.sourceUrl || '');
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function isClientSmoothedRecord(item) {
  if (!item) return false;
  if (isCatalogCrawlerSource(item.source)) return true;
  const metadata = asRecord(item.metadata);
  return metadata.extract === 'generic' || metadata.cleaned === true;
}

function officialRecordId(source, payload) {
  const row = asRecord(payload);
  if (source === 'amazon') return String(row.orderid || row.orderId || '').trim() || null;
  if (source === 'luma') return String(row.eventId || row.taskId || row.id || '').trim() || null;
  if (source === 'airbnb') return String(row.tripId || row.id || '').trim() || null;
  if (source === 'booking') return String(row.bookingId || row.id || '').trim() || null;
  if (isCatalogCrawlerSource(source)) {
    return (
      String(row.orderId || row.orderid || row.id || row.bookingId || row.tripId || '').trim() ||
      null
    );
  }
  return null;
}

function isTitleBackedSourceId(sourceId) {
  return typeof sourceId === 'string' && sourceId.startsWith(TITLE_BACKED_PREFIX);
}

function sourceIdentityKey(source, sourceId) {
  if (!sourceId) return '';
  return `${source}:${sourceId}`;
}

function allowsTitleBackedIdentity(source, metadata = {}) {
  if (isCatalogCrawlerSource(source)) return true;
  if (!TITLE_BACKED_SMOOTHED_CORE.has(source)) return false;
  return isClientSmoothedRecord({ source, metadata });
}

/**
 * Dedup key matching the client after clean: host + orderId / title / date.
 * Official ids stay unprefixed so already-stored Amazon (and other core)
 * sourceId values keep matching. Title-only catalog rows and smoothed
 * Luma / Airbnb / Booking generic fallbacks use a title: key unique per
 * host (not collapsed into amazon).
 */
function extractSourceId(source, payload, metadata = {}) {
  const official = officialRecordId(source, payload);
  if (official) return official;

  if (!allowsTitleBackedIdentity(source, metadata)) return null;

  const title = payloadTitle(payload);
  if (!title) return null;
  const date = payloadDate(payload);
  const host = hostFromMetadata(metadata) || source;
  return `${TITLE_BACKED_PREFIX}${host}:${title}:${date}`.slice(0, 190);
}

function hasRecordIdentity(source, payload) {
  return Boolean(officialRecordId(source, payload) || payloadTitle(payload));
}

function calculateDataQuality(item) {
  const payload = asRecord(item?.payload);
  const metadata = asRecord(item?.metadata);
  const source = item?.source;
  const smoothed = isClientSmoothedRecord(item);
  let score = 0;
  const details = {
    hasOfficialId: false,
    hasMetadata: false,
    hasStandardFields: false,
    formatCompliance: false,
    clientSmoothed: smoothed,
  };

  const official = officialRecordId(source, payload);
  const title = payloadTitle(payload);
  if (official) {
    score += 40;
    details.hasOfficialId = true;
  } else if (smoothed && title) {
    // Client already dropped dirty chrome; title is the Earn identity.
    score += 40;
    details.hasOfficialId = true;
  }

  if (metadata.sourceUrl || metadata.host) score += 15;
  if (metadata.category) score += 10;
  details.hasMetadata = score >= 15;

  if (source === 'amazon' && item.type === 'product') {
    if (payload.title && payload.price) score += 15;
    if (payload.currency) score += 10;
    details.hasStandardFields = Boolean(payload.title && payload.price);
  } else if (source === 'luma') {
    if (payload.title) score += 15;
    if (payload.date || payload.dueDate) score += 10;
    details.hasStandardFields = Boolean(payload.title);
  } else if (source === 'airbnb' || source === 'booking' || isCatalogCrawlerSource(source)) {
    if (title || payload.listingTitle) score += 15;
    if (
      payload.date ||
      payload.orderDate ||
      payload.startDate ||
      payload.checkIn ||
      payload.price
    ) {
      score += 10;
    }
    details.hasStandardFields = Boolean(title);
  }

  try {
    if (item?.timestamp && new Date(item.timestamp).toISOString()) {
      score += 10;
      details.formatCompliance = true;
    }
  } catch {
    // Invalid timestamp format
  }

  return { score, details };
}

module.exports = {
  TITLE_BACKED_PREFIX,
  asRecord,
  normalizeText,
  payloadTitle,
  payloadDate,
  hostFromMetadata,
  isClientSmoothedRecord,
  officialRecordId,
  isTitleBackedSourceId,
  sourceIdentityKey,
  extractSourceId,
  hasRecordIdentity,
  calculateDataQuality,
};
