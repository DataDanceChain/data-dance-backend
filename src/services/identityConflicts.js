/**
 * Sign-ins web3authIdentity.resolveUser refused with IDENTITY_CONFLICT, kept for support
 * (GET /api/ops/identity-conflicts). They used to be log lines only.
 *
 * A row holds the reason, the route (network_rebind | backfill | create), how the candidate account
 * was found, its id and the Web3Auth connection name. Never an e-mail, a verifierId or a wallet
 * address: the candidate's e-mail is joined when the list is read.
 *
 * Recording never changes the sign-in: it is not awaited, and a failed write is logged as
 * `identity_conflict_record_failed` with the error's name only.
 */
const { createLogger } = require('../utils/logger');

// web3authIdentity loads this module at boot and takes its database from the caller, so the
// Prisma client and the ops helpers are required only by the list functions below.
function defaultDb() {
  return require('../utils/prisma');
}

function opsHelpers() {
  return require('./opsAudit');
}

const logger = createLogger('identityConflicts');

const ROUTES = Object.freeze(['network_rebind', 'backfill', 'create']);

/** Where a failed record is reported. Replaceable for tests. */
const recordLog = {
  error: (event, entry) => logger.error(event, entry),
};

function short(value, limit = 128) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, limit);
}

/** Fire and forget; resolves either way (the returned promise is only for tests). */
function recordIdentityConflict(db, { reason, route, candidateBy, candidateUserId, verifier }) {
  return Promise.resolve()
    .then(() => {
      if (!ROUTES.includes(route)) throw new TypeError('Unknown identity conflict route');
      return db.identityConflict.create({
        data: {
          reason: short(reason) || 'unknown',
          route,
          candidateBy: short(candidateBy, 32),
          candidateUserId: short(candidateUserId),
          verifier: short(verifier) || 'unknown',
        },
      });
    })
    .then(() => undefined)
    .catch((error) => {
      try {
        recordLog.error('identity_conflict_record_failed', { errorName: (error && error.name) || 'Error' });
      } catch (_) {
        // The logger itself failed: there is nowhere left to write.
      }
    });
}

/** GET /api/ops/identity-conflicts: filters, newest first, paged, with counts by reason. */
async function listIdentityConflicts(query = {}, db = defaultDb()) {
  const { parsePaging, createdAtRange, filterValue } = opsHelpers();
  const base = {};
  const userId = filterValue(query, 'userId');
  if (userId) base.candidateUserId = userId;
  const range = createdAtRange(query);
  if (range) base.createdAt = range;
  const where = { ...base };
  const reason = filterValue(query, 'reason');
  if (reason) where.reason = reason;
  const { limit, offset } = parsePaging(query);

  const [total, rows, grouped] = await Promise.all([
    db.identityConflict.count({ where }),
    db.identityConflict.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
    }),
    db.identityConflict.groupBy({ by: ['reason'], where: base, _count: { _all: true } }),
  ]);

  const ids = [...new Set(rows.map((row) => row.candidateUserId).filter(Boolean))];
  const [users, rebinds] = ids.length
    ? await Promise.all([
        db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }),
        db.web3AuthNetworkRebind.findMany({
          where: { userId: { in: ids } },
          select: { userId: true, status: true, walletPolicy: true },
        }),
      ])
    : [[], []];
  const emailById = new Map(users.map((user) => [user.id, user.email]));
  const rebindById = new Map(rebinds.map((row) => [row.userId, row]));

  return {
    total,
    limit,
    offset,
    byReason: grouped
      .map((row) => ({ reason: row.reason, count: row._count._all }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    items: rows.map((row) => {
      const rebind = row.candidateUserId ? rebindById.get(row.candidateUserId) : null;
      return {
        id: row.id,
        createdAt: row.createdAt,
        reason: row.reason,
        route: row.route,
        candidateBy: row.candidateBy || null,
        candidateUserId: row.candidateUserId || null,
        candidateEmail: row.candidateUserId ? emailById.get(row.candidateUserId) || null : null,
        verifier: row.verifier,
        rebind: rebind ? { status: rebind.status, walletPolicy: rebind.walletPolicy } : null,
      };
    }),
  };
}

/** The newest conflicts naming one account (the user view's Sign-in issues section). */
async function conflictsForUser(userId, { take = 10 } = {}, db = defaultDb()) {
  const rows = await db.identityConflict.findMany({
    where: { candidateUserId: userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    reason: row.reason,
    route: row.route,
    verifier: row.verifier,
  }));
}

module.exports = {
  ROUTES,
  recordIdentityConflict,
  listIdentityConflicts,
  conflictsForUser,
  recordLog,
};
