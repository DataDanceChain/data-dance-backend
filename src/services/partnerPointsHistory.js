/**
 * Points history for the partner (scope `sso:points`, GET /partner/tge/points/history).
 *
 * The same grant that shows the balance on /status. One page of the token's own user's `Point`
 * ledger, newest first, plus the balance exactly as /status reports it. Each item is exactly
 * four facts: an opaque stable id, the signed amount, a short neutral `kind` and the creation time.
 * `Point.sourceId` (task ids, other users' ids, staff labels on manual adjustments, order or
 * redemption references) never leaves DataDance, and neither does the raw `source` string: the
 * partner sees only the category it maps to through the explicit allow-list below.
 *
 * Pagination: keyset over (createdAt DESC, id DESC) — a total order, so rows that share a
 * millisecond are neither skipped nor repeated. The cursor carries the last row's position, the
 * user it was issued for, and the optional since/until window, and is signed:
 *
 *   <base64url(JSON {v, u, t, i, s, e})>.<base64url(HMAC-SHA256(key, "pph1." + payload)[0..16])>
 *
 * Key: derived from SSO_SESSION_SECRET over a fixed label (the referralBindConfirm.js pattern; the
 * boot check already refuses the partner API without that secret). Any edit, truncation or a
 * cursor minted elsewhere fails the tag check → 400 invalid_request; a genuine cursor of another
 * user → 400 as well. It is still NOT a capability: the user always comes from the access token.
 * Rows written while the partner pages land before the first page's top row and are never mixed
 * into later pages. Rotating the secret invalidates outstanding cursors: the partner restarts at
 * page one.
 *
 * Balance: `User.totalPoints`, the value /status returns, read with the token's user. The ledger
 * and that total are written in the same transactions, so for an account whose every balance
 * change has a ledger row the items sum to the balance; `balance` is the authoritative figure.
 */
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { PARTNER_POINTS_CACHE_MAX_AGE_SEC } = require('../constants/partnerClient');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 1024;
const CURSOR_TAG_PREFIX = 'pph1';
const CURSOR_KEY_LABEL = 'ddc:partner-points-history-cursor:v1';
const CURSOR_TAG_BYTES = 16;
const ITEM_FIELDS = Object.freeze(['amount', 'created_at', 'id', 'kind']);
const POINT_KINDS = Object.freeze(['upload', 'referral', 'task', 'campaign', 'adjustment', 'redemption', 'other']);

/**
 * `Point.source` → partner-visible kind. An ALLOW-LIST: a source that is not listed here reads as
 * `other`, so a new ledger source never shows up under a misleading category by accident, and its
 * raw name never reaches a partner. test/unit/partnerPointsHistory.test.js scans every
 * `point.create` site in src/ and fails when one writes a source this table does not name.
 */
const SOURCE_KIND = Object.freeze({
  // Data contributions.
  crawler: 'upload',
  // Task rewards.
  TASK_CLAIM: 'task',
  // Referral rewards: the direct bonus, level rewards, the older claim name, campaign-period
  // referral rewards (they replace the standard one), and the upline share of a task reward.
  REFERRAL_DIRECT: 'referral',
  REFERRAL_CLAIM: 'referral',
  REFERRAL_CAMPAIGN_MOTHERS_DAY_INVITER: 'referral',
  REFERRAL_CAMPAIGN_MOTHERS_DAY_INVITEE: 'referral',
  REFERRAL_CAMPAIGN_SUMMER_TRAVEL_INVITER: 'referral',
  REFERRAL_CAMPAIGN_SUMMER_TRAVEL_INVITEE: 'referral',
  upline_reward: 'referral',
  // Campaign and event grants, including boosts paid on top of a standard reward.
  BADGE_CLAIM: 'campaign',
  CHRISTMAS_WELCOME_BONUS: 'campaign',
  CRAWLER_SUMMER_TRAVEL_BONUS: 'campaign',
  CAMPAIGN_CONNECT_BOOST: 'campaign',
  CAMPAIGN_REFERRAL_BOOST: 'campaign',
  CAMPAIGN_FIRST_ACTION: 'campaign',
  CAMPAIGN_RAFFLE: 'campaign',
  // Operator corrections, either sign.
  OPS_ADJUSTMENT: 'adjustment',
  MANUAL_ADJUSTMENT: 'adjustment',
  // Points spent on a reward.
  REWARD_REDEMPTION: 'redemption',
});
/** `REFERRAL_LEVEL_2`, `REFERRAL_LEVEL_3`, … written by claimReferralRewards. */
const REFERRAL_LEVEL_SOURCE = /^REFERRAL_LEVEL_[1-9][0-9]{0,2}$/;

function pointKind(source) {
  const value = typeof source === 'string' ? source : '';
  if (Object.prototype.hasOwnProperty.call(SOURCE_KIND, value)) return SOURCE_KIND[value];
  if (REFERRAL_LEVEL_SOURCE.test(value)) return 'referral';
  return 'other';
}

class PointsHistoryRequestError extends Error {
  constructor(description) {
    super(description);
    this.name = 'PointsHistoryRequestError';
    this.status = 400;
    this.error = 'invalid_request';
    this.description = description;
  }
}

// A date (`2026-10-01`, read as UTC midnight) or a date-time WITH a zone designator. A local time
// without a zone would be read in the server's zone, so it is refused rather than guessed.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}))?$/;

function single(name, raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new PointsHistoryRequestError(`${name} must be given once.`);
  return raw;
}

function parseLimit(raw) {
  const value = single('limit', raw);
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!/^\d{1,4}$/.test(value) || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new PointsHistoryRequestError(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return n;
}

function parseInstant(name, raw) {
  const value = single(name, raw);
  if (value === undefined) return null;
  const date = new Date(value);
  if (!ISO_INSTANT.test(value) || Number.isNaN(date.getTime())) {
    throw new PointsHistoryRequestError(`${name} must be an ISO-8601 date, or a date-time with a time zone.`);
  }
  return date;
}

const isoOrNull = (date) => (date ? date.toISOString() : null);

function cursorKey() {
  const secret = String(process.env.SSO_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SSO_SESSION_SECRET is not configured');
  return crypto.createHmac('sha256', secret).update(CURSOR_KEY_LABEL).digest();
}

function cursorTag(payload) {
  return crypto.createHmac('sha256', cursorKey()).update(`${CURSOR_TAG_PREFIX}.${payload}`).digest()
    .subarray(0, CURSOR_TAG_BYTES);
}

function encodeCursor({ userId, row, since, until }) {
  const payload = Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    u: userId,
    t: new Date(row.createdAt).toISOString(),
    i: String(row.id),
    s: isoOrNull(since),
    e: isoOrNull(until),
  })).toString('base64url');
  return `${payload}.${cursorTag(payload).toString('base64url')}`;
}

function cursorDate(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function decodeCursor(raw, userId) {
  const value = single('cursor', raw);
  const match = typeof value === 'string' && value.length <= MAX_CURSOR_LENGTH
    ? /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value)
    : null;
  if (!match) throw new PointsHistoryRequestError('cursor is invalid.');
  // The tag first: nothing in an unsigned or edited cursor is parsed, let alone queried.
  const given = Buffer.from(match[2], 'base64url');
  const expected = cursorTag(match[1]);
  // Canonical encoding only, so one cursor has exactly one spelling.
  if (given.toString('base64url') !== match[2]
      || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new PointsHistoryRequestError('cursor is invalid.');
  }
  let c;
  try {
    c = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw new PointsHistoryRequestError('cursor is invalid.');
  }
  if (!c || typeof c !== 'object' || Array.isArray(c) || c.v !== CURSOR_VERSION || typeof c.u !== 'string') {
    throw new PointsHistoryRequestError('cursor is invalid.');
  }
  const createdAt = cursorDate(c.t);
  const since = cursorDate(c.s === undefined ? null : c.s);
  const until = cursorDate(c.e === undefined ? null : c.e);
  if (!createdAt || since === undefined || until === undefined
      || typeof c.i !== 'string' || !c.i || c.i.length > 128) {
    throw new PointsHistoryRequestError('cursor is invalid.');
  }
  if (c.u !== userId) throw new PointsHistoryRequestError('cursor belongs to another user.');
  return { createdAt, id: c.i, since, until };
}

const sameInstant = (a, b) => (a ? a.getTime() : null) === (b ? b.getTime() : null);

/**
 * The page's WHERE clause. Always the token's user first; the window and the keyset are only
 * ever narrowed from there. Built without undefined keys so the shape is the same in Prisma and
 * in the unit tests' in-memory stand-in.
 */
function pageWhere(userId, { after, since, until }) {
  const where = { userId };
  const createdAt = {};
  if (since) createdAt.gte = since;
  if (until) createdAt.lt = until;
  if (Object.keys(createdAt).length) where.createdAt = createdAt;
  if (after) {
    where.OR = [
      { createdAt: { lt: after.createdAt } },
      { createdAt: after.createdAt, id: { lt: after.id } },
    ];
  }
  return where;
}

/** The query is replaceable only for tests; it never selects sourceId or anything else. */
const source = {
  loadPage(userId, { after, since, until, take }) {
    return prisma.point.findMany({
      where: pageWhere(userId, { after, since, until }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, amount: true, source: true, createdAt: true },
    });
  },
};

/** Built field by field: an item is exactly these four facts, whatever the query returns. */
function toItem(row) {
  return {
    id: String(row.id),
    amount: Number(row.amount),
    kind: pointKind(row.source),
    created_at: new Date(row.createdAt).toISOString(),
  };
}

/**
 * One page. `user`: { id, totalPoints } — the token's user, as loaded by requirePartnerToken.
 * `query`: { cursor?, limit?, since?, until? } straight from the request. Throws
 * PointsHistoryRequestError (400 invalid_request) on bad input.
 */
async function buildPointsHistory(user, query = {}, { now = new Date() } = {}) {
  const userId = String(user.id);
  const limit = parseLimit(query.limit);
  let since = parseInstant('since', query.since);
  let until = parseInstant('until', query.until);
  let after = null;
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, userId);
    if ((query.since !== undefined && !sameInstant(since, after.since))
        || (query.until !== undefined && !sameInstant(until, after.until))) {
      throw new PointsHistoryRequestError('since and until cannot change between pages; they are carried by the cursor.');
    }
    ({ since, until } = after);
  }
  if (since && until && since.getTime() >= until.getTime()) {
    throw new PointsHistoryRequestError('since must be earlier than until.');
  }

  const asOf = now.toISOString();
  // limit + 1 rows tell whether another page exists.
  const rows = await source.loadPage(userId, { after, since, until, take: limit + 1 });
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  return {
    sub: userId,
    balance: Number(user.totalPoints) || 0,
    as_of: asOf,
    cache_max_age: PARTNER_POINTS_CACHE_MAX_AGE_SEC,
    items: page.map(toItem),
    next_cursor: more ? encodeCursor({ userId, row: page[page.length - 1], since, until }) : null,
  };
}

module.exports = {
  buildPointsHistory,
  pointKind,
  pageWhere,
  source,
  PointsHistoryRequestError,
  SOURCE_KIND,
  POINT_KINDS,
  ITEM_FIELDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
