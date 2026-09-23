/**
 * Referral network for the partner (scope `tge:referral_network`, GET /partner/tge/referral-network).
 *
 * Decision (Sloan, 2026-09-23): the partner may read a user's COMPLETE referral network — every
 * upline and every downline, at any depth. This reverses the earlier "never a downline list, never
 * a multi-level total". Each node carries exactly four facts — sub, inviter_sub, depth, invited_at —
 * and never another user's e-mail, name, wallet, points, status, orders, portrait or raw records.
 *
 * Graph: `Referral(inviterId → inviteeId)`, `inviteeId` UNIQUE — every user has at most one inviter,
 * so the upline is a chain and the downline is a tree … unless the data contains a cycle. It can:
 * POST /api/referrals/use-code lets a registered user bind ANY other user's code later, with no
 * ancestry check, so A invites B and then A binds B's code gives A→B→A (longer rings likewise).
 * Both walks therefore run as recursive CTEs that carry the path and STOP at the first repeated
 * node; the requesting user is never listed in their own network; a hit adds `anomalies: ["cycle"]`
 * so the partner can exclude that user from payouts, and is logged at warn with the ids involved.
 *
 * Snapshot semantics. Business code only ever CREATES Referral rows (four create sites, no update
 * or delete in src/), so the network "as of T" is exactly the edges with createdAt <= T. The first
 * page pins `as_of` (server now, or `?as_of=` from the caller, never in the future); the cursor
 * carries it; every page and every `levels` / `total` is computed over that snapshot. Nobody who
 * signs up mid-pagination is skipped or double-counted. If Referral rows ever become mutable or
 * deletable, snapshots stop being exact — see the contract.
 *
 * Cost: O(downline) per page (the whole snapshot is walked for `levels` / `total` and the keyset
 * position). Fine at today's scale; at ~10^5 descendants for one user, or chains thousands deep
 * (the path array is O(depth) per row), move to a materialised closure table.
 */
const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');

const logger = createLogger('referralNetwork');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const CURSOR_VERSION = 1;
const NODE_FIELDS = Object.freeze(['sub', 'inviter_sub', 'depth', 'invited_at']);
const UPLINE_FIELDS = Object.freeze(['sub', 'depth', 'invited_at']);

class NetworkRequestError extends Error {
  constructor(description) {
    super(description);
    this.name = 'NetworkRequestError';
    this.status = 400;
    this.error = 'invalid_request';
    this.description = description;
  }
}

const iso = (d) => new Date(d).toISOString();
// `createdAt` is `timestamp(3)` WITHOUT time zone, written by Prisma in UTC. The snapshot bound is
// passed as an ISO string and converted explicitly, so the database session's TimeZone never shifts it.

/** Upline, nearest first. Rows: { sub, invited_at, depth, cycle, path }. */
async function loadUpline(userId, asOf) {
  return prisma.$queryRaw`
    WITH RECURSIVE up AS (
      SELECT r."inviterId" AS sub, r."createdAt" AS invited_at, 1 AS depth,
             ARRAY[${userId}::text, r."inviterId"] AS path,
             (r."inviterId" = ${userId}::text) AS cycle
      FROM "Referral" r
      WHERE r."inviteeId" = ${userId}::text AND r."createdAt" <= (${asOf.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      UNION ALL
      SELECT r."inviterId", r."createdAt", up.depth + 1,
             up.path || r."inviterId",
             (r."inviterId" = ANY(up.path))
      FROM up JOIN "Referral" r ON r."inviteeId" = up.sub
      WHERE NOT up.cycle AND r."createdAt" <= (${asOf.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    )
    SELECT sub, invited_at, depth, cycle, path FROM up ORDER BY depth`;
}

/** Whole downline snapshot. Rows: { sub, inviter_sub, invited_at, depth, cycle, path }. */
async function loadDownline(userId, asOf) {
  return prisma.$queryRaw`
    WITH RECURSIVE down AS (
      SELECT r."inviteeId" AS sub, r."inviterId" AS inviter_sub, r."createdAt" AS invited_at, 1 AS depth,
             ARRAY[${userId}::text, r."inviteeId"] AS path,
             (r."inviteeId" = ${userId}::text) AS cycle
      FROM "Referral" r
      WHERE r."inviterId" = ${userId}::text AND r."createdAt" <= (${asOf.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      UNION ALL
      SELECT r."inviteeId", r."inviterId", r."createdAt", down.depth + 1,
             down.path || r."inviteeId",
             (r."inviteeId" = ANY(down.path))
      FROM down JOIN "Referral" r ON r."inviterId" = down.sub
      WHERE NOT down.cycle AND r."createdAt" <= (${asOf.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    )
    SELECT sub, inviter_sub, invited_at, depth, cycle, path FROM down`;
}

/** The SQL is replaceable only for tests that exercise the assembly without Postgres. */
const source = { loadUpline, loadDownline };

function encodeCursor({ userId, asOf, row }) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION, u: userId, a: asOf.toISOString(), d: row.depth, t: row.invited_at, s: row.sub,
  })).toString('base64url');
}

function decodeCursor(raw, userId) {
  let c;
  try {
    c = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    throw new NetworkRequestError('cursor is invalid.');
  }
  const asOf = new Date(c && c.a);
  if (!c || c.v !== CURSOR_VERSION || typeof c.s !== 'string' || !Number.isInteger(c.d) || typeof c.t !== 'string'
      || Number.isNaN(asOf.getTime()) || Number.isNaN(new Date(c.t).getTime())) {
    throw new NetworkRequestError('cursor is invalid.');
  }
  if (c.u !== userId) throw new NetworkRequestError('cursor belongs to another user.');
  return { asOf, depth: c.d, invitedAt: c.t, sub: c.s };
}

function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw)) || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new NetworkRequestError(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return n;
}

function parseAsOf(raw, now) {
  if (raw === undefined) return now;
  const d = new Date(String(raw));
  if (!String(raw).trim() || Number.isNaN(d.getTime())) throw new NetworkRequestError('as_of must be an ISO-8601 timestamp.');
  if (d.getTime() > now.getTime()) throw new NetworkRequestError('as_of must not be in the future.');
  return d;
}

/** Keyset order: (depth, invited_at, sub). */
function compareKey(a, b) {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.invited_at !== b.invited_at) return a.invited_at < b.invited_at ? -1 : 1;
  if (a.sub === b.sub) return 0;
  return a.sub < b.sub ? -1 : 1;
}

/** Warn-level record of a ring (ids only). `cycleLog.write` is replaceable for tests. */
const cycleLog = { write: (entry) => logger.warn('partner.referral_cycle', entry) };

function reportCycles(userId, direction, rows) {
  for (const row of rows.filter((r) => r.cycle)) {
    const path = Array.isArray(row.path) ? row.path.map(String) : [];
    const repeated = String(row.sub);
    cycleLog.write({
      userId,
      direction,
      repeatedId: repeated,
      closedBy: direction === 'downline' ? String(row.inviter_sub) : path[path.length - 2] || null,
      cycleIds: path.slice(path.indexOf(repeated)),
    });
  }
}

/**
 * One page of the network. `query`: { cursor?, limit?, as_of? }. Throws NetworkRequestError (400).
 */
async function buildReferralNetwork(userId, query = {}, { now = new Date() } = {}) {
  const limit = parseLimit(query.limit);
  let asOf;
  let after = null;
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, userId);
    asOf = after.asOf;
    if (query.as_of !== undefined && parseAsOf(query.as_of, now).getTime() !== asOf.getTime()) {
      throw new NetworkRequestError('as_of cannot change between pages; it is carried by the cursor.');
    }
  } else {
    asOf = parseAsOf(query.as_of, now);
  }

  const [upRows, downRows] = await Promise.all([source.loadUpline(userId, asOf), source.loadDownline(userId, asOf)]);
  const anomalies = new Set();
  if (upRows.some((r) => r.cycle) || downRows.some((r) => r.cycle)) anomalies.add('cycle');
  reportCycles(userId, 'upline', upRows);
  reportCycles(userId, 'downline', downRows);

  const upline = upRows
    .filter((r) => !r.cycle && String(r.sub) !== userId)
    .map((r) => ({ sub: String(r.sub), depth: Number(r.depth), invited_at: iso(r.invited_at) }));

  // Defensive: one row per user (inviteeId is unique, so only corrupt data could repeat one).
  const seen = new Set([userId]);
  const nodes = [];
  for (const r of [...downRows].sort((x, y) => Number(x.depth) - Number(y.depth))) {
    const sub = String(r.sub);
    if (r.cycle || seen.has(sub)) continue;
    seen.add(sub);
    nodes.push({ sub, inviter_sub: String(r.inviter_sub), depth: Number(r.depth), invited_at: iso(r.invited_at) });
  }
  nodes.sort(compareKey);

  const counts = new Map();
  for (const n of nodes) counts.set(n.depth, (counts.get(n.depth) || 0) + 1);
  const levels = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([depth, count]) => ({ depth, count }));

  const start = after
    ? nodes.findIndex((n) => compareKey(n, { depth: after.depth, invited_at: after.invitedAt, sub: after.sub }) > 0)
    : 0;
  const from = start === -1 ? nodes.length : start;
  const page = nodes.slice(from, from + limit);
  const more = from + limit < nodes.length;

  const body = {
    sub: userId,
    as_of: asOf.toISOString(),
    cache_max_age: 60,
    upline,
    downline: {
      total: nodes.length,
      levels,
      nodes: page,
      next_cursor: more ? encodeCursor({ userId, asOf, row: page[page.length - 1] }) : null,
    },
  };
  if (anomalies.size) body.anomalies = [...anomalies];
  return body;
}

module.exports = {
  buildReferralNetwork,
  NetworkRequestError,
  source,
  cycleLog,
  NODE_FIELDS,
  UPLINE_FIELDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
