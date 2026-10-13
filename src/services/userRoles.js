/**
 * User roles (UserRoleGrant), shared by the ops API, the developer console and
 * scripts/opsRoles.js. See src/constants/opsRoles.js for what each role allows.
 *
 * Grant and revoke write their audit row in the same transaction as the change. Anything that can
 * lower the number of enabled ddc_admin accounts (revoke, disable), and a re-enable, takes one
 * transaction-scoped advisory lock first; revoke and disable then read the accounts again under
 * the lock and refuse with LAST_ADMIN when no enabled ddc_admin would be left.
 */
const prisma = require('../utils/prisma');
const { ROLES, isRole, staffRole, cleanReason } = require('../constants/opsRoles');
const { OpsError, writeAudit, isoOrNull } = require('./opsAudit');

function byRoleOrder(a, b) {
  return ROLES.indexOf(a) - ROLES.indexOf(b);
}

/** The roles a user holds now, in ROLES order. */
async function activeRoles(userId, db = prisma) {
  if (typeof userId !== 'string' || !userId) return [];
  const rows = await db.userRoleGrant.findMany({ where: { userId }, select: { role: true } });
  return [...new Set(rows.map((row) => row.role).filter(isRole))].sort(byRoleOrder);
}

/** Whether the user holds `role` (or any of `roles`). */
async function hasRole(userId, roles, db = prisma) {
  const wanted = Array.isArray(roles) ? roles : [roles];
  const held = await activeRoles(userId, db);
  return held.some((role) => wanted.includes(role));
}

/**
 * One query: the user ({ id, email, name, disabledAt, sessionsResetAt }) with their roles and the
 * staff role they act as (ddc_admin over operator; null when neither). null when there is no such
 * user.
 */
async function loadUserWithRoles(userId, db = prisma) {
  if (typeof userId !== 'string' || !userId) return null;
  const row = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      disabledAt: true,
      sessionsResetAt: true,
      roleGrants: { select: { role: true } },
    },
  });
  if (!row) return null;
  const roles = [...new Set((row.roleGrants || []).map((grant) => grant.role).filter(isRole))].sort(byRoleOrder);
  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name || null,
      disabledAt: row.disabledAt || null,
      sessionsResetAt: row.sessionsResetAt || null,
    },
    roles,
    role: staffRole(roles),
  };
}

/** Serialises every change that can lower the number of enabled ddc_admin accounts. */
async function lockAdmins(tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ddc:ops-admins'))`;
}

/** Enabled ddc_admin accounts other than `excludeUserId`. */
async function otherEnabledAdmins(tx, excludeUserId) {
  const grants = await tx.userRoleGrant.findMany({
    where: { role: 'ddc_admin' },
    include: { user: { select: { id: true, disabledAt: true } } },
  });
  return grants.filter((grant) => grant.userId !== excludeUserId && grant.user && !grant.user.disabledAt).length;
}

function requireRole(value) {
  if (!isRole(value)) throw new OpsError(400, 'INVALID_ROLE', `role must be one of ${ROLES.join(', ')}.`);
  return value;
}

function requireReason(value) {
  const reason = cleanReason(value);
  if (!reason) throw new OpsError(400, 'REASON_REQUIRED', 'A reason of 3 to 200 characters is required.');
  return reason;
}

async function findTarget(db, userId) {
  if (typeof userId !== 'string' || !userId) throw new OpsError(404, 'USER_NOT_FOUND', 'User not found.');
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, isOrganization: true, userType: true, disabledAt: true },
  });
  if (!user) throw new OpsError(404, 'USER_NOT_FOUND', 'User not found.');
  return user;
}

function presentGrant(grant) {
  return {
    userId: grant.userId,
    role: grant.role,
    grantedAt: grant.grantedAt,
    grantedBy: grant.grantedBy,
    reason: grant.reason,
  };
}

/** GET /api/ops/roles?role= : the active grants, with the account's e-mail, name and status. */
async function listGrants({ role } = {}, db = prisma) {
  const where = {};
  if (role !== undefined && role !== '') where.role = requireRole(role);
  const rows = await db.userRoleGrant.findMany({
    where,
    include: { user: { select: { id: true, email: true, name: true, disabledAt: true } } },
    orderBy: [{ role: 'asc' }, { grantedAt: 'asc' }],
  });
  return rows.map((row) => ({
    userId: row.userId,
    email: row.user ? row.user.email : null,
    name: row.user ? row.user.name || null : null,
    role: row.role,
    grantedAt: row.grantedAt,
    grantedBy: row.grantedBy,
    reason: row.reason,
    disabledAt: row.user ? row.user.disabledAt || null : null,
  }));
}

/**
 * Grant `role` to `userId`. Refuses a disabled account (409 ACCOUNT_DISABLED), an organization
 * account (409 ORG_NOT_ALLOWED) and a role it already holds (409 ALREADY_GRANTED).
 * `actor` is an audit actor (opsAudit.actorFromOps / SCRIPT_ACTOR).
 */
async function grantRole({ userId, role, reason, actor, surface = 'ops', requestId = null }, db = prisma) {
  const wanted = requireRole(role);
  const why = requireReason(reason);
  const target = await findTarget(db, userId);
  if (target.disabledAt) throw new OpsError(409, 'ACCOUNT_DISABLED', 'This account is disabled.');
  if (target.isOrganization || target.userType === 'organization') {
    throw new OpsError(409, 'ORG_NOT_ALLOWED', 'Organization accounts cannot hold a role.');
  }
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.userRoleGrant.findUnique({
        where: { userId_role: { userId: target.id, role: wanted } },
      });
      if (existing) throw new OpsError(409, 'ALREADY_GRANTED', 'This account already has that role.');
      const grant = await tx.userRoleGrant.create({
        data: {
          userId: target.id,
          role: wanted,
          grantedByUserId: actor.userId || null,
          grantedBy: String(actor.label),
          reason: why,
        },
      });
      const audit = await writeAudit(tx, {
        actor,
        action: 'role.grant',
        target: { type: 'user', id: target.id, label: target.email },
        reason: why,
        detail: { role: wanted },
        surface,
        requestId,
      });
      return { grant: presentGrant(grant), auditId: audit.id };
    });
  } catch (error) {
    if (error && error.code === 'P2002') throw new OpsError(409, 'ALREADY_GRANTED', 'This account already has that role.');
    throw error;
  }
}

/**
 * Revoke `role` from `userId`. Refuses a role it does not hold (404 NOT_GRANTED), the actor's own
 * ddc_admin (409 SELF_CHANGE) and anything that would leave no enabled ddc_admin (409 LAST_ADMIN).
 */
async function revokeRole({ userId, role, reason, actor, surface = 'ops', requestId = null }, db = prisma) {
  const wanted = requireRole(role);
  const why = requireReason(reason);
  const target = await findTarget(db, userId);
  if (wanted === 'ddc_admin' && actor.userId && actor.userId === target.id) {
    throw new OpsError(409, 'SELF_CHANGE', 'You cannot remove your own ddc_admin role.');
  }
  return db.$transaction(async (tx) => {
    if (wanted === 'ddc_admin') await lockAdmins(tx);
    const grant = await tx.userRoleGrant.findUnique({
      where: { userId_role: { userId: target.id, role: wanted } },
    });
    if (!grant) throw new OpsError(404, 'NOT_GRANTED', 'This account does not have that role.');
    if (wanted === 'ddc_admin') {
      // Whether the target counts as an enabled admin is read again under the lock: the read in
      // findTarget came before it, and a re-enable in between would otherwise go unseen.
      const current = await tx.user.findUnique({ where: { id: target.id }, select: { disabledAt: true } });
      if (!current) throw new OpsError(404, 'USER_NOT_FOUND', 'User not found.');
      if (!current.disabledAt && (await otherEnabledAdmins(tx, target.id)) === 0) {
        throw new OpsError(409, 'LAST_ADMIN', 'At least one enabled ddc_admin must remain.');
      }
    }
    await tx.userRoleGrant.delete({ where: { userId_role: { userId: target.id, role: wanted } } });
    const audit = await writeAudit(tx, {
      actor,
      action: 'role.revoke',
      target: { type: 'user', id: target.id, label: target.email },
      reason: why,
      detail: { role: wanted, grantedAt: isoOrNull(grant.grantedAt), grantedBy: grant.grantedBy },
      surface,
      requestId,
    });
    return { revoked: { userId: target.id, role: wanted }, auditId: audit.id };
  });
}

module.exports = {
  activeRoles,
  hasRole,
  loadUserWithRoles,
  listGrants,
  grantRole,
  revokeRole,
  lockAdmins,
  otherEnabledAdmins,
  requireRole,
  requireReason,
  findTarget,
};
