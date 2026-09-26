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
 * Cost. `levels` / `total` need the whole downline walk (measured on Postgres 17 by the
 * coordinator: ~200 ms for a 21k-person, 15-level team; 5 ms for 100 people; a 10,000-deep upline
 * 9 ms). Because as_of is pinned and the data is append-only, that walk runs ONCE per (user, as_of):
 * later pages reuse it from a small in-process cache and run only the keyset page query, whose walk
 * stops at the deepest level the page can reach. Do NOT replace this with a closure table
 * (ancestor x descendant pairs): depth is user-controlled (sock-puppet chains, use-code), and a
 * 10k chain alone expanded to 51M pairs.
 */
const prisma = require('../utils/prisma');
const { runVettedRawRead } = require('../utils/prismaReadOnly');
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

// The downline walk, shared by the two queries below. Carries the path; a row whose node is already
// on its path is the ring closing (`cycle`) and is not expanded. `maxDepth` bounds the walk.
// (Prisma.sql fragments would be tidier; the duplication keeps each query a single tagged template.)

/**
 * Levels of the WHOLE downline snapshot, plus the paths of any ring rows (ids joined by ',').
 * Rows: { depth, count, cycle_paths }. Computed once per (user, as_of) — see aggregateCache.
 */
async function loadDownlineAggregate(userId, asOf) {
  return prisma.$queryRaw`
    WITH RECURSIVE down AS (
      SELECT r."inviteeId" AS sub, 1 AS depth,
             ARRAY[${userId}::text, r."inviteeId"] AS path,
             (r."inviteeId" = ${userId}::text) AS cycle
      FROM "Referral" r
      WHERE r."inviterId" = ${userId}::text AND r."createdAt" <= (${asOf.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      UNION ALL
      SELECT r."inviteeId", down.depth + 1,
             down.path || r."inviteeId",
             (r."inviteeId" = ANY(down.path))
      FROM down JOIN "Referral" r ON r."inviterId" = down.sub
      WHERE NOT down.cycle AND r."createdAt" <= (${asOf.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    )
    SELECT depth,
           (count(*) FILTER (WHERE NOT cycle AND sub <> ${userId}::text))::int AS count,
           coalesce(array_agg(array_to_string(path, ',')) FILTER (WHERE cycle), ARRAY[]::text[]) AS cycle_paths
    FROM down GROUP BY depth ORDER BY depth`;
}

/**
 * One keyset page of downline nodes after `after` ({ depth, invitedAt, sub } or null), in
 * (depth, invited_at, sub COLLATE "C") order. The walk stops at `maxDepth`, which the caller derives
 * from the cached levels, so an early page never walks the deep part of a large team.
 */
async function loadDownlinePage(userId, asOf, { after, limit, maxDepth }) {
  const d = after ? after.depth : 0;
  const t = after ? after.invitedAt : '1970-01-01T00:00:00.000Z';
  const s = after ? after.sub : '';
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
      WHERE NOT down.cycle AND down.depth < ${maxDepth}::int
        AND r."createdAt" <= (${asOf.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    )
    SELECT sub, inviter_sub, invited_at, depth FROM down
    WHERE NOT cycle AND sub <> ${userId}::text
      AND (depth, invited_at, sub COLLATE "C") > (${d}::int, (${t}::timestamptz AT TIME ZONE 'UTC'), ${s}::text COLLATE "C")
    ORDER BY depth, invited_at, sub COLLATE "C"
    LIMIT ${limit}::int`;
}

/** The SQL is replaceable only for tests that exercise the assembly without Postgres. */
// The partner routes run inside the G14 read-only scope, which refuses raw SQL by default; these three
// fixed, parameterised SELECT CTEs are the vetted exception (runVettedRawRead allows queryRaw only).
const vetted = (name, fn) => (...args) => runVettedRawRead(`referralNetwork.${name}`, () => fn(...args));
const source = {
  loadUpline: vetted('upline', loadUpline),
  loadDownlineAggregate: vetted('downlineAggregate', loadDownlineAggregate),
  loadDownlinePage: vetted('downlinePage', loadDownlinePage),
};

/** `n` = nodes emitted through this page: with the pinned snapshot it maps a position to a depth. */
function encodeCursor({ userId, asOf, row, emitted }) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION, u: userId, a: asOf.toISOString(), d: row.depth, t: row.invited_at, s: row.sub, n: emitted,
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
      || !Number.isInteger(c.n) || c.n < 0
      || Number.isNaN(asOf.getTime()) || Number.isNaN(new Date(c.t).getTime())) {
    throw new NetworkRequestError('cursor is invalid.');
  }
  if (c.u !== userId) throw new NetworkRequestError('cursor belongs to another user.');
  return { asOf, depth: c.d, invitedAt: c.t, sub: c.s, emitted: c.n };
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

/** Warn-level record of a ring (ids only). `cycleLog.write` is replaceable for tests. */
const cycleLog = { write: (entry) => logger.warn('partner.referral_cycle', entry) };

function reportCycle(userId, direction, path, closedBy) {
  const repeated = path[path.length - 1];
  cycleLog.write({
    userId,
    direction,
    repeatedId: repeated,
    closedBy: closedBy || null,
    cycleIds: path.slice(path.indexOf(repeated)),
  });
}

/**
 * levels / total / downline-ring flag per (user, as_of). The snapshot is pinned and Referral rows
 * are append-only, so a value never changes once computed: the first page computes it, later pages
 * (which carry as_of in the cursor) reuse it and only run the keyset page query. Small, in-process,
 * TTL'd; a miss (restart, eviction) just recomputes — correctness never depends on it.
 */
const AGGREGATE_TTL_MS = 10 * 60 * 1000;
const AGGREGATE_MAX_ENTRIES = 500;
const aggregateCache = new Map();

function cacheGet(key) {
  const hit = aggregateCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    aggregateCache.delete(key);
    return null;
  }
  aggregateCache.delete(key); // refresh LRU position
  aggregateCache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  aggregateCache.set(key, { value, expiresAt: Date.now() + AGGREGATE_TTL_MS });
  while (aggregateCache.size > AGGREGATE_MAX_ENTRIES) aggregateCache.delete(aggregateCache.keys().next().value);
}

function clearAggregateCache() {
  aggregateCache.clear();
}

async function downlineAggregate(userId, asOf) {
  const key = `${userId}|${asOf.toISOString()}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const rows = await source.loadDownlineAggregate(userId, asOf);
  const levels = rows
    .map((r) => ({ depth: Number(r.depth), count: Number(r.count) }))
    .filter((l) => l.count > 0)
    .sort((a, b) => a.depth - b.depth);
  const cyclePaths = rows.flatMap((r) => (Array.isArray(r.cycle_paths) ? r.cycle_paths : [])).map((p) => String(p).split(','));
  for (const path of cyclePaths) reportCycle(userId, 'downline', path, path[path.length - 2]);
  const value = { levels, total: levels.reduce((n, l) => n + l.count, 0), cycle: cyclePaths.length > 0 };
  cacheSet(key, value);
  return value;
}

/**
 * Deepest level the page can reach. Nodes are ordered depth first, so with the snapshot's levels the
 * last position this page needs (already emitted + rows wanted) falls in a known level. A tampered
 * `emitted` only changes how much of the caller's OWN network is walked, never what is visible.
 */
function pageMaxDepth(levels, emitted, rowsWanted) {
  if (!levels.length) return 0;
  const lastPosition = emitted + rowsWanted;
  let cumulative = 0;
  for (const l of levels) {
    cumulative += l.count;
    if (cumulative >= lastPosition) return l.depth;
  }
  return levels[levels.length - 1].depth;
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

  const [upRows, agg] = await Promise.all([source.loadUpline(userId, asOf), downlineAggregate(userId, asOf)]);
  const upCycle = upRows.find((r) => r.cycle);
  // Log an upline ring only when the snapshot is first computed, not on every page.
  if (upCycle && !after) {
    const path = Array.isArray(upCycle.path) ? upCycle.path.map(String) : [];
    reportCycle(userId, 'upline', path, path[path.length - 2]);
  }

  const upline = upRows
    .filter((r) => !r.cycle && String(r.sub) !== userId)
    .map((r) => ({ sub: String(r.sub), depth: Number(r.depth), invited_at: iso(r.invited_at) }));

  // limit + 1 rows tell whether another page exists.
  const emittedBefore = after ? after.emitted : 0;
  const rows = agg.total
    ? await source.loadDownlinePage(userId, asOf, { after, limit: limit + 1, maxDepth: pageMaxDepth(agg.levels, emittedBefore, limit + 1) })
    : [];
  // Built field by field: a node is exactly these four facts, whatever the query selects.
  const nodes = rows.slice(0, limit).map((r) => ({
    sub: String(r.sub),
    inviter_sub: String(r.inviter_sub),
    depth: Number(r.depth),
    invited_at: iso(r.invited_at),
  }));
  const more = rows.length > limit;

  const body = {
    sub: userId,
    as_of: asOf.toISOString(),
    cache_max_age: 60,
    upline,
    downline: {
      total: agg.total,
      levels: agg.levels,
      nodes,
      next_cursor: more ? encodeCursor({ userId, asOf, row: nodes[nodes.length - 1], emitted: emittedBefore + nodes.length }) : null,
    },
  };
  if (upCycle || agg.cycle) body.anomalies = ['cycle'];
  return body;
}

module.exports = {
  buildReferralNetwork,
  NetworkRequestError,
  source,
  cycleLog,
  clearAggregateCache,
  NODE_FIELDS,
  UPLINE_FIELDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
