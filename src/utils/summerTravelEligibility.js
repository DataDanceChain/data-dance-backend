const { rewardEligibleUploadWhere } = require('./firstValidUpload');
const prisma = require('./prisma');
const { normalizeCrawlerSource } = require('../constants/crawlerSources');
const { resolveStayBonusRules } = require('./stayBonus');

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
  if (s.includes('T')) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function isEligibleStayDate(dateStr, rules) {
  if (!dateStr || !rules) return false;
  return dateStr >= rules.stayStartDate && dateStr <= rules.stayEndDate;
}

function isStaySource(source, rules) {
  const site = normalizeCrawlerSource(source);
  return Array.isArray(rules?.sites) && rules.sites.includes(site);
}

function isStayStatusEligible(payload) {
  const status = payload?.status ?? payload?.bookingStatus ?? payload?.reservationStatus;
  if (status == null || status === '') return true;
  const normalized = String(status).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return !INVALID_STAY_STATUSES.has(normalized);
}

function isStayBonusEligibleItem(item, rules) {
  if (!rules?.isActive) return false;
  if (!item || !isStaySource(item.source, rules)) return false;
  const payload = item.payload || {};
  if (!isStayStatusEligible(payload)) return false;
  return isEligibleStayDate(extractStayDate(payload), rules);
}

function countStayBonusItems(items, rules) {
  if (!Array.isArray(items) || items.length === 0 || !rules) return 0;
  let n = 0;
  for (const item of items) {
    if (isStayBonusEligibleItem(item, rules)) n += 1;
  }
  return n;
}

function rowLooksLikeStay(row, rules) {
  return isStayBonusEligibleItem(row, rules);
}

async function countUserSummerStayOrders(
  userId,
  db = prisma,
  { duringCampaignOnly = true, rules } = {},
) {
  const active = rules || (await resolveStayBonusRules());
  if (!active?.sites?.length) return 0;
  const where = rewardEligibleUploadWhere({
    userId,
    source: { in: active.sites },
  });
  if (duringCampaignOnly) {
    where.createdAt = {
      gte: active.startUtc,
      lte: active.endUtc,
    };
  }
  const rows = await db.crawlerData.findMany({
    where,
    select: { id: true, source: true, payload: true },
  });
  return rows.filter((row) => rowLooksLikeStay(row, active)).length;
}

async function hasCompletedFirstValidSummerOrder(userId, db = prisma) {
  const count = await countUserSummerStayOrders(userId, db, {
    duringCampaignOnly: true,
  });
  return count > 0;
}

module.exports = {
  extractStayDate,
  isEligibleStayDate,
  isStaySource,
  isStayStatusEligible,
  isStayBonusEligibleItem,
  countStayBonusItems,
  countUserSummerStayOrders,
  hasCompletedFirstValidSummerOrder,
  rowLooksLikeStay,
  isSummerTravelEligibleItem: (item, rules) => isStayBonusEligibleItem(item, rules),
  countSummerBonusItems: countStayBonusItems,
};
