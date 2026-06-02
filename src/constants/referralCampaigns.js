/**
 * Referral campaigns with distinct economics from standard referrals.
 *
 * Mother's Day 2026 — RETIRED (May 8–10 2026 PT). Old share links still work as
 * standard referral only (campaign query ignored); API may still expose read-only metadata.
 */

const MOTHERS_DAY_2026_SLUG = 'mothers-day-2026';

/** Once true, mothers-day-2026 is not accepted as an active campaign; normalize drops it. */
const MOTHERS_DAY_2026_RETIRED = true;

/** Campaign window (UTC instant equivalents for PT civil times). Kept for historical payloads / stats. */
const MOTHERS_DAY_2026 = {
  slug: MOTHERS_DAY_2026_SLUG,
  startUtc: new Date('2026-05-08T07:00:00.000Z'),
  endUtc: new Date('2026-05-11T06:59:59.999Z'),
  inviterPoints: 300,
  inviteePoints: 200,
  timezone: 'America/Los_Angeles',
};

function nowOrProvided(now) {
  return now instanceof Date ? now : new Date();
}

function isMothersDay2026Active(now) {
  if (MOTHERS_DAY_2026_RETIRED) return false;
  const t = nowOrProvided(now);
  return t >= MOTHERS_DAY_2026.startUtc && t <= MOTHERS_DAY_2026.endUtc;
}

/**
 * @param {string|null|undefined} raw
 * @returns {string|null} normalized slug or null if omitted
 */
function normalizeReferralCampaignInput(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return null;
  if (s === MOTHERS_DAY_2026_SLUG) {
    if (MOTHERS_DAY_2026_RETIRED) return null;
    return MOTHERS_DAY_2026_SLUG;
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
  if (MOTHERS_DAY_2026_RETIRED && slug === MOTHERS_DAY_2026_SLUG) {
    const err = new Error("Mother's Day Bonus has ended.");
    err.code = 'CAMPAIGN_INACTIVE';
    throw err;
  }
  if (slug === MOTHERS_DAY_2026_SLUG) {
    if (!isMothersDay2026Active(t)) {
      const err = new Error("Mother's Day Bonus campaign is not active.");
      err.code = 'CAMPAIGN_INACTIVE';
      throw err;
    }
    return;
  }
  const err = new Error(`Unknown referral campaign: ${slug}`);
  err.code = 'INVALID_CAMPAIGN';
  throw err;
}

function formatDatePt(dateUtc) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: MOTHERS_DAY_2026.timezone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(dateUtc);
}

function formatTimePt(dateUtc) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: MOTHERS_DAY_2026.timezone,
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

module.exports = {
  MOTHERS_DAY_2026_SLUG,
  MOTHERS_DAY_2026,
  MOTHERS_DAY_2026_RETIRED,
  isMothersDay2026Active,
  normalizeReferralCampaignInput,
  assertCampaignActive,
  getMothersDay2026PublicPayload,
};
