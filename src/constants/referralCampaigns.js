/**
 * Referral campaigns with distinct economics from standard referrals.
 *
 * Mother's Day 2026 — RETIRED (May 8–10 2026 PT).
 * Summer Travel 2026 — Aug 20 – Sep 30 2026 PT; settle on first valid summer stay upload.
 */

const MOTHERS_DAY_2026_SLUG = 'mothers-day-2026';
const SUMMER_TRAVEL_2026_SLUG = 'summer-travel-2026';

/** Once true, mothers-day-2026 is not accepted as an active campaign; normalize drops it. */
const MOTHERS_DAY_2026_RETIRED = true;

/** Once true, summer-travel-2026 is not accepted; normalize drops it to standard referral. */
const SUMMER_TRAVEL_2026_RETIRED = false;

/** Campaign window (UTC instant equivalents for PT civil times). Kept for historical payloads / stats. */
const MOTHERS_DAY_2026 = {
  slug: MOTHERS_DAY_2026_SLUG,
  startUtc: new Date('2026-05-08T07:00:00.000Z'),
  endUtc: new Date('2026-05-11T06:59:59.999Z'),
  inviterPoints: 300,
  inviteePoints: 200,
  timezone: 'America/Los_Angeles',
};

/**
 * Summer Travel 2026
 * - Campaign participation window: TEMP preview from Aug 4 – Sep 30 2026 (America/Los_Angeles)
 *   TODO: restore official start to Aug 20 00:00 PT → 2026-08-20T07:00:00.000Z after internal QA
 * - Eligible stay check-in/startDate: Jun 1 – Aug 31 2026
 * - Inviter 300 / invitee 100 after invitee logs ≥1 valid summer stay during the campaign window
 * - Upload bonus: +10 per eligible stay on top of base 10 crawler points
 */
const SUMMER_TRAVEL_2026 = {
  slug: SUMMER_TRAVEL_2026_SLUG,
  // TEMP for internal QA — restore to 2026-08-20T07:00:00.000Z before public launch
  // Aug 3 00:00 PT so the campaign is already live during Asia-day Aug 4 internal review
  startUtc: new Date('2026-08-03T07:00:00.000Z'),
  endUtc: new Date('2026-10-01T06:59:59.999Z'),
  inviterPoints: 300,
  inviteePoints: 100,
  timezone: 'America/Los_Angeles',
  stayStartDate: '2026-06-01',
  stayEndDate: '2026-08-31',
  uploadBonusPerItem: 10,
  pointsPerOrderDisplay: 20, // base 10 + bonus 10
};

const POINT_SOURCE_SUMMER_TRAVEL_BONUS = 'CRAWLER_SUMMER_TRAVEL_BONUS';
const POINT_SOURCE_SUMMER_TRAVEL_INVITER = 'REFERRAL_CAMPAIGN_SUMMER_TRAVEL_INVITER';
const POINT_SOURCE_SUMMER_TRAVEL_INVITEE = 'REFERRAL_CAMPAIGN_SUMMER_TRAVEL_INVITEE';

function nowOrProvided(now) {
  return now instanceof Date ? now : new Date();
}

function isMothersDay2026Active(now) {
  if (MOTHERS_DAY_2026_RETIRED) return false;
  const t = nowOrProvided(now);
  return t >= MOTHERS_DAY_2026.startUtc && t <= MOTHERS_DAY_2026.endUtc;
}

function isSummerTravel2026Active(now) {
  if (SUMMER_TRAVEL_2026_RETIRED) return false;
  const t = nowOrProvided(now);
  return t >= SUMMER_TRAVEL_2026.startUtc && t <= SUMMER_TRAVEL_2026.endUtc;
}

/**
 * @param {string|null|undefined} raw
 * @returns {string|null} normalized slug or null if omitted / retired
 */
function normalizeReferralCampaignInput(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return null;
  if (s === MOTHERS_DAY_2026_SLUG) {
    if (MOTHERS_DAY_2026_RETIRED) return null;
    return MOTHERS_DAY_2026_SLUG;
  }
  if (s === SUMMER_TRAVEL_2026_SLUG) {
    if (SUMMER_TRAVEL_2026_RETIRED) return null;
    return SUMMER_TRAVEL_2026_SLUG;
  }
  const err = new Error(`Unknown referral campaign: ${raw}`);
  err.code = 'INVALID_CAMPAIGN';
  throw err;
}

/**
 * Ensures a campaign slug is only used while the campaign is active.
 * @param {string|null} slug
 * @param {Date} [now]
 */
function assertCampaignActive(slug, now) {
  if (!slug) return;
  const t = nowOrProvided(now);
  if (slug === MOTHERS_DAY_2026_SLUG) {
    if (MOTHERS_DAY_2026_RETIRED || !isMothersDay2026Active(t)) {
      const err = new Error("Mother's Day Bonus campaign is not active.");
      err.code = 'CAMPAIGN_INACTIVE';
      throw err;
    }
    return;
  }
  if (slug === SUMMER_TRAVEL_2026_SLUG) {
    if (SUMMER_TRAVEL_2026_RETIRED || !isSummerTravel2026Active(t)) {
      const err = new Error('Summer Travel Bonus campaign is not active.');
      err.code = 'CAMPAIGN_INACTIVE';
      throw err;
    }
    return;
  }
  const err = new Error(`Unknown referral campaign: ${slug}`);
  err.code = 'INVALID_CAMPAIGN';
  throw err;
}

function formatDatePt(dateUtc, timezone = MOTHERS_DAY_2026.timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(dateUtc);
}

function formatTimePt(dateUtc, timezone = MOTHERS_DAY_2026.timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(dateUtc);
}

function getMothersDay2026PublicPayload(now) {
  if (MOTHERS_DAY_2026_RETIRED) {
    return {
      slug: MOTHERS_DAY_2026.slug,
      title: "Mother's Day Bonus",
      subtitle: 'This campaign has ended.',
      isActive: false,
      retired: true,
      timezone: MOTHERS_DAY_2026.timezone,
      startsAt: MOTHERS_DAY_2026.startUtc.toISOString(),
      endsAt: MOTHERS_DAY_2026.endUtc.toISOString(),
      startsAtDisplayPt: `${formatDatePt(MOTHERS_DAY_2026.startUtc)} ${formatTimePt(MOTHERS_DAY_2026.startUtc)}`,
      endsAtDisplayPt: `${formatDatePt(MOTHERS_DAY_2026.endUtc)} ${formatTimePt(MOTHERS_DAY_2026.endUtc)}`,
      endsOnShortLabel: formatDatePt(MOTHERS_DAY_2026.endUtc),
      inviterPoints: MOTHERS_DAY_2026.inviterPoints,
      inviteePoints: MOTHERS_DAY_2026.inviteePoints,
      shareLinkPath: '/referral-redirect',
    };
  }
  const t = nowOrProvided(now);
  const active = isMothersDay2026Active(t);
  return {
    slug: MOTHERS_DAY_2026.slug,
    title: "Mother's Day Bonus",
    subtitle: 'For those who give. Earn 300, gift 200.',
    isActive: active,
    retired: false,
    timezone: MOTHERS_DAY_2026.timezone,
    startsAt: MOTHERS_DAY_2026.startUtc.toISOString(),
    endsAt: MOTHERS_DAY_2026.endUtc.toISOString(),
    startsAtDisplayPt: `${formatDatePt(MOTHERS_DAY_2026.startUtc)} ${formatTimePt(MOTHERS_DAY_2026.startUtc)}`,
    endsAtDisplayPt: `${formatDatePt(MOTHERS_DAY_2026.endUtc)} ${formatTimePt(MOTHERS_DAY_2026.endUtc)}`,
    endsOnShortLabel: formatDatePt(MOTHERS_DAY_2026.endUtc),
    inviterPoints: MOTHERS_DAY_2026.inviterPoints,
    inviteePoints: MOTHERS_DAY_2026.inviteePoints,
    shareLinkPath: '/referral-redirect',
  };
}

function getSummerTravel2026PublicPayload(now) {
  const t = nowOrProvided(now);
  const active = isSummerTravel2026Active(t);
  const tz = SUMMER_TRAVEL_2026.timezone;
  return {
    slug: SUMMER_TRAVEL_2026.slug,
    title: 'Summer Travel Bonus',
    subtitle: 'Connect Booking or Airbnb and earn double points on 2026 summer stays.',
    isActive: active,
    retired: SUMMER_TRAVEL_2026_RETIRED,
    timezone: tz,
    startsAt: SUMMER_TRAVEL_2026.startUtc.toISOString(),
    endsAt: SUMMER_TRAVEL_2026.endUtc.toISOString(),
    startsAtDisplayPt: `${formatDatePt(SUMMER_TRAVEL_2026.startUtc, tz)} ${formatTimePt(SUMMER_TRAVEL_2026.startUtc, tz)}`,
    endsAtDisplayPt: `${formatDatePt(SUMMER_TRAVEL_2026.endUtc, tz)} ${formatTimePt(SUMMER_TRAVEL_2026.endUtc, tz)}`,
    endsOnShortLabel: formatDatePt(SUMMER_TRAVEL_2026.endUtc, tz),
    stayStartDate: SUMMER_TRAVEL_2026.stayStartDate,
    stayEndDate: SUMMER_TRAVEL_2026.stayEndDate,
    pointsPerOrder: SUMMER_TRAVEL_2026.pointsPerOrderDisplay,
    uploadBonusPerItem: SUMMER_TRAVEL_2026.uploadBonusPerItem,
    inviterPoints: SUMMER_TRAVEL_2026.inviterPoints,
    inviteePoints: SUMMER_TRAVEL_2026.inviteePoints,
    ugcSharePoints: 50,
    shareLinkPath: '/referral-redirect',
    xProfileUrl: 'https://x.com/DataDanceChain',
  };
}

module.exports = {
  MOTHERS_DAY_2026_SLUG,
  MOTHERS_DAY_2026,
  MOTHERS_DAY_2026_RETIRED,
  isMothersDay2026Active,
  normalizeReferralCampaignInput,
  assertCampaignActive,
  getMothersDay2026PublicPayload,
  SUMMER_TRAVEL_2026_SLUG,
  SUMMER_TRAVEL_2026,
  SUMMER_TRAVEL_2026_RETIRED,
  isSummerTravel2026Active,
  getSummerTravel2026PublicPayload,
  POINT_SOURCE_SUMMER_TRAVEL_BONUS,
  POINT_SOURCE_SUMMER_TRAVEL_INVITER,
  POINT_SOURCE_SUMMER_TRAVEL_INVITEE,
};
