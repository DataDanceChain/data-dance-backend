const {
  SUMMER_TRAVEL_2026,
  isSummerTravel2026Active,
} = require('../constants/referralCampaigns');
const { rewardEligibleUploadWhere } = require('./firstValidUpload');
const prisma = require('./prisma');

const TRAVEL_SOURCES = new Set(['airbnb', 'booking']);

const INVALID_STAY_STATUSES = new Set([
  'cancelled',
  'canceled',
  'failed',
  'declined',
  'rejected',
  'refunded',
  'no_show',
  'noshow',
]);

/**
 * Normalize payload stay date to YYYY-MM-DD (or null).
 * Airbnb: startDate; Booking: checkIn. Also accept nested variants.
 */
function extractStayDate(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw =
    payload.checkIn ||
    payload.startDate ||
    payload.check_in ||
    payload.start_date ||
    null;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // ISO datetime → date portion
  if (s.includes('T')) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function isEligibleSummerStayDate(dateStr) {
  if (!dateStr) return false;
  return (
    dateStr >= SUMMER_TRAVEL_2026.stayStartDate &&
    dateStr <= SUMMER_TRAVEL_2026.stayEndDate
  );
}

function isTravelSource(source) {
  return TRAVEL_SOURCES.has(String(source || '').toLowerCase());
}

/**
 * Soft status gate: reject clearly cancelled/failed; accept missing status.
 * Booking "paid" is not always present in crawler payloads.
 */
function isStayStatusEligible(payload) {
  const status = payload?.status ?? payload?.bookingStatus ?? payload?.reservationStatus;
  if (status == null || status === '') return true;
  const normalized = String(status).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return !INVALID_STAY_STATUSES.has(normalized);
}

/**
 * Whether a crawler item qualifies for Summer Travel Task 1 bonus / referral gate.
 */
function isSummerTravelEligibleItem(item, now = new Date()) {
  if (!isSummerTravel2026Active(now)) return false;
  if (!item || !isTravelSource(item.source)) return false;
  const payload = item.payload || {};
  if (!isStayStatusEligible(payload)) return false;
  const stayDate = extractStayDate(payload);
  return isEligibleSummerStayDate(stayDate);
}

function countSummerBonusItems(items, now = new Date()) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let n = 0;
  for (const item of items) {
    if (isSummerTravelEligibleItem(item, now)) n += 1;
  }
  return n;
}

function rowLooksLikeSummerStay(row) {
  if (!row || !isTravelSource(row.source)) return false;
  const payload = row.payload || {};
  if (!isStayStatusEligible(payload)) return false;
  return isEligibleSummerStayDate(extractStayDate(payload));
}

/**
 * Count reward-eligible Booking/Airbnb rows with summer stay dates for a user.
 * Stay-date filter is applied in JS (JSON payload fields vary by crawler).
 * When duringCampaignOnly=true, only rows uploaded inside the campaign window count
 * (matches “connect & recognize during the campaign”).
 */
async function countUserSummerStayOrders(
  userId,
  db = prisma,
  { duringCampaignOnly = true } = {},
) {
  const where = rewardEligibleUploadWhere({
    userId,
    source: { in: ['airbnb', 'booking'] },
  });
  if (duringCampaignOnly) {
    where.createdAt = {
      gte: SUMMER_TRAVEL_2026.startUtc,
      lte: SUMMER_TRAVEL_2026.endUtc,
    };
  }
  const rows = await db.crawlerData.findMany({
    where,
    select: { id: true, source: true, payload: true },
  });
  return rows.filter(rowLooksLikeSummerStay).length;
}

async function hasCompletedFirstValidSummerOrder(userId, db = prisma) {
  const count = await countUserSummerStayOrders(userId, db, {
    duringCampaignOnly: true,
  });
  return count > 0;
}

module.exports = {
  TRAVEL_SOURCES,
  extractStayDate,
  isEligibleSummerStayDate,
  isTravelSource,
  isStayStatusEligible,
  isSummerTravelEligibleItem,
  countSummerBonusItems,
  countUserSummerStayOrders,
  hasCompletedFirstValidSummerOrder,
  rowLooksLikeSummerStay,
};
