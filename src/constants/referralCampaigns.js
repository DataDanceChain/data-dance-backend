/**
 * Referral campaigns with distinct economics from standard referrals.
 * Mother's Day 2026: May 8 12:00 AM PT – May 10 11:59 PM PT (America/Los_Angeles).
 * Stored boundaries as UTC instants equivalent to those wall-clock times (May uses PDT, UTC-7).
 */

const MOTHERS_DAY_2026_SLUG = 'mothers-day-2026';

/** Campaign window (UTC instant equivalents for PT civil times above). */
const MOTHERS_DAY_2026 = {
  slug: MOTHERS_DAY_2026_SLUG,
  /** May 8, 2026 00:00 America/Los_Angeles → UTC */
  startUtc: new Date('2026-05-08T07:00:00.000Z'),
  /** May 10, 2026 23:59:59.999 America/Los_Angeles → UTC */
  endUtc: new Date('2026-05-11T06:59:59.999Z'),
  inviterPoints: 300,
  inviteePoints: 200,
  timezone: 'America/Los_Angeles',
};

function nowOrProvided(now) {
  return now instanceof Date ? now : new Date();
}

function isMothersDay2026Active(now) {
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
  if (s === MOTHERS_DAY_2026_SLUG) return MOTHERS_DAY_2026_SLUG;
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
  const t = nowOrProvided(now);
  const active = isMothersDay2026Active(t);
  return {
    slug: MOTHERS_DAY_2026.slug,
    title: "Mother's Day Bonus",
    subtitle: 'For those who give. Earn 300, gift 200.',
    isActive: active,
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
  isMothersDay2026Active,
  normalizeReferralCampaignInput,
  assertCampaignActive,
  getMothersDay2026PublicPayload,
};
