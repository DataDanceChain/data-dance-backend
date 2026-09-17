const { extractStayDate } = require('./summerTravelEligibility');
const { findCityInText } = require('../constants/cityCoordinates');

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function flattenStayPayload(payload) {
  const row = asRecord(payload);
  const trip = asRecord(row.trip);
  const detail = asRecord(row.detail);
  const listing = asRecord(row.listing);
  return { ...detail, ...trip, ...listing, ...row };
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function extractPlaceFromTitle(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2) return '';
  const known = findCityInText(text);
  if (known) return known.label;
  const inLatin = text.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z .'-]{1,48})$/i);
  if (inLatin) return inLatin[1].replace(/[.,;]+$/, '').trim();
  const inCn = text.match(/(?:在|於|于)\s*([\u4e00-\u9fffA-Za-z][^\s，,]{1,20})/);
  if (inCn) return inCn[1].replace(/[的里內内]$/, '').trim();
  return '';
}

function asCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isListingName(value, row) {
  const text = String(value || '').trim();
  if (!text) return false;
  return [row.title, row.listingTitle, row.bookingName]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .includes(text);
}

function coordsFromGps(value) {
  const parts = String(value || '')
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return parts.length >= 2 ? { lat: parts[0], lng: parts[1] } : null;
}

/** Prefer a real location on the stay: coordinates, street address, then a city name. Never guess from a listing nickname. */
function queryStayPlace(payload, metadata) {
  const row = flattenStayPayload(payload);
  const meta = asRecord(metadata);
  const listing = asRecord(row.listing);
  const coord = asRecord(row.coordinate || row.coordinates || listing.coordinate || listing.coordinates);
  const gps = coordsFromGps(row.gpsCoordinates || meta.gpsCoordinates);
  const lat = asCoord(row.lat ?? row.latitude ?? coord.lat ?? coord.latitude ?? gps?.lat ?? meta.lat);
  const lng = asCoord(row.lng ?? row.longitude ?? row.lon ?? coord.lng ?? coord.longitude ?? gps?.lng ?? meta.lng);
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { kind: 'coords', lat, lng, query: `${lng},${lat}` };
  }
  const address = firstText(
    row.publicAddress,
    row.p3_summary_address,
    row.address,
    row.formattedAddress,
    row.street,
    listing.publicAddress,
    listing.p3_summary_address,
    listing.address,
    meta.address,
  );
  if (address) return { kind: 'address', query: address };
  const named = firstText(
    row.city,
    row.localizedCity,
    row.hotelCity,
    row.tripLocation,
    row.location,
    row.destination,
    row.region,
    row.area,
    meta.city,
    meta.location,
  );
  if (named) {
    const parsed = extractPlaceFromTitle(named);
    if (parsed) return { kind: 'name', query: parsed };
    if (!isListingName(named, row) || findCityInText(named)) return { kind: 'name', query: named };
  }
  const fromTitle = firstText(
    extractPlaceFromTitle(row.listingTitle),
    extractPlaceFromTitle(row.title),
    extractPlaceFromTitle(row.bookingName),
  );
  if (fromTitle) return { kind: 'name', query: fromTitle };
  return null;
}

function placeFromStayPayload(payload, metadata) {
  return queryStayPlace(payload, metadata)?.query || '';
}

function parseYmd(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.includes('T')) return text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return null;
}

function nightsFromStayPayload(payload) {
  const row = flattenStayPayload(payload);
  const listed = Number(row.nights);
  if (Number.isFinite(listed) && listed > 0 && listed < 120) return Math.round(listed);
  const start =
    parseYmd(row.checkIn) ||
    parseYmd(row.startDate) ||
    parseYmd(row.tripStartDate) ||
    parseYmd(row.check_in) ||
    extractStayDate(row);
  const end =
    parseYmd(row.checkOut) ||
    parseYmd(row.endDate) ||
    parseYmd(row.tripEndDate) ||
    parseYmd(row.check_out);
  if (!start || !end) return 1;
  const ms = new Date(`${end}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime();
  const nights = Math.round(ms / 86400000);
  if (!Number.isFinite(nights) || nights <= 0 || nights > 120) return 1;
  return nights;
}

module.exports = {
  flattenStayPayload,
  extractPlaceFromTitle,
  queryStayPlace,
  placeFromStayPayload,
  nightsFromStayPayload,
};
