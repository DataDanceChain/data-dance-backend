/**
 * Shop, travel, and life rows must be the signed-in account's own order,
 * trip, or booking. Public product, brand, and search pages are not records.
 */

const {
  isLifeCrawlerSource,
  isShopCrawlerSource,
  isTravelCrawlerSource,
  normalizeCrawlerSource,
  SHOP_SOURCE_DEFS,
  TRAVEL_SOURCE_DEFS,
  LIFE_SOURCE_DEFS,
} = require('../constants/crawlerSources');

const CORE_RECORD_SOURCES = new Set(['amazon', 'airbnb', 'booking', 'luma']);

const PERSONAL_RECORDS_URL =
  /\/orders(?:\/|$|\?)|your-orders|order-history|purchase-history|\/p\/order|order\/index|shop\/order|\/order\/list|mytrips|past-trips|\/trips(?:\/|$|\?)|account\/orders|account\/bookings|user\/order|user\/purchase|user\/orders|your\/purchases|\/purchases(?:\/|$|\?)|my_orders|mye\/myebay\/purchase|myb\/purchasehistory|bgt_order|\/(?:orders?|purchase)\.html|\/payments(?:\/|$|\?)|purchasehistory|myaccount\/orders|\/mypage|profile\/myaccount|orderlookup|readytobook|bookinglist|tripadvisor\.com\/trips|riders\.uber|myeventlist|ticketmaster\.com\/user|meetup\.com\/?(?:$|\?)/i;

const SOURCE_DEFS = [...SHOP_SOURCE_DEFS, ...TRAVEL_SOURCE_DEFS, ...LIFE_SOURCE_DEFS];

function requiresOwnAccountRecord(source) {
  const canonical = normalizeCrawlerSource(source);
  return (
    CORE_RECORD_SOURCES.has(canonical) ||
    isShopCrawlerSource(canonical) ||
    isTravelCrawlerSource(canonical) ||
    isLifeCrawlerSource(canonical)
  );
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function looksLikeProductSlug(value) {
  const parts = String(value || '').split('-');
  return parts.length >= 4 && parts.every((part) => /^[a-z0-9]+$/i.test(part));
}

function ownAccountRecordId(payload) {
  const row = asRecord(payload);
  for (const value of [row.orderId, row.orderid, row.bookingId, row.tripId, row.confirmationCode, row.id]) {
    const text = String(value || '').trim();
    if (!text || text.length < 6 || text.length > 80) continue;
    if (/^https?:/i.test(text)) continue;
    if (!/\d/.test(text)) continue;
    if (looksLikeProductSlug(text)) continue;
    return text;
  }
  return '';
}

function pageOf(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return {
      host: url.hostname.toLowerCase().replace(/\.+$/, '').replace(/^(?:www|m|mobile)\./, ''),
      href: url.href,
    };
  } catch {
    return null;
  }
}

function sameSite(expectedHost, pageHost) {
  const root = (host) => String(host || '').replace(/^(?:www|m|mobile)\./, '');
  const expected = root(expectedHost);
  const page = root(pageHost);
  if (!expected || !page) return false;
  return expected === page || expected.endsWith(`.${page}`) || page.endsWith(`.${expected}`);
}

function sourceHost(source) {
  const def = SOURCE_DEFS.find((row) => row.source === source);
  if (!def || !def.origin) return '';
  const page = pageOf(def.origin);
  return page ? page.host : '';
}

function isPersonalRecordsUrl(href) {
  return PERSONAL_RECORDS_URL.test(String(href || ''));
}

function normalizedTitle(payload) {
  return String(payload.title || payload.productTitle || payload.listingTitle || payload.name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isCoreAccountRecord(source, payload, page) {
  const title = normalizedTitle(payload);
  const href = page ? page.href : '';
  const host = page ? page.host : '';
  if (source === 'amazon') {
    const orderId = String(payload.orderid || payload.orderId || '').trim();
    return (
      /^\d{3}-\d{7}-\d{7}$/.test(orderId) &&
      /amazon\./.test(host) &&
      /your-orders|order-history|order-details/.test(href)
    );
  }
  if (source === 'airbnb') {
    const tripId = String(payload.confirmationCode || payload.tripId || '').trim();
    return (
      /^[A-Z0-9]{5,16}$/i.test(tripId) &&
      tripId.toLowerCase() !== title &&
      /airbnb\./.test(host) &&
      /\/trips|past-trips/.test(href)
    );
  }
  if (source === 'booking') {
    const bookingId = String(payload.bookingId || '').trim();
    const borrowed = title && bookingId.toLowerCase().startsWith(title);
    return (
      /^[A-Z0-9]{6,24}$/i.test(bookingId) &&
      !borrowed &&
      /booking\./.test(host) &&
      /mytrips|\/bookings/.test(href)
    );
  }
  if (source === 'luma') {
    const eventId = String(payload.eventId || payload.id || '').trim();
    return (
      /^[A-Za-z0-9-]{6,40}$/.test(eventId) &&
      !/^https?:/i.test(eventId) &&
      !looksLikeProductSlug(eventId) &&
      /(^|\.)lu\.ma$|(^|\.)luma\.com$/.test(host) &&
      /\/home|period=past/.test(href)
    );
  }
  return false;
}

/**
 * A row is the account's own record when it carries a real order, trip, or
 * booking id and the page it came from is that account's records page.
 * A title, a product card, or an invented id on a public page is not.
 */
function isOwnAccountRecord(item) {
  if (!item || !requiresOwnAccountRecord(item.source)) return true;
  const source = normalizeCrawlerSource(item.source);
  const payload = asRecord(item.payload);
  const metadata = asRecord(item.metadata);
  const page = pageOf(metadata.sourceUrl || metadata.url || '');
  if (CORE_RECORD_SOURCES.has(source)) return isCoreAccountRecord(source, payload, page);
  const recordId = ownAccountRecordId(payload);
  if (!recordId || !page || !isPersonalRecordsUrl(page.href)) return false;
  const expected = sourceHost(source);
  if (expected && !sameSite(expected, page.host)) return false;
  return true;
}

module.exports = {
  isOwnAccountRecord,
  isPersonalRecordsUrl,
  ownAccountRecordId,
  requiresOwnAccountRecord,
};
