/**
 * Ops roles, permissions and audit actions (admin issue #2). Roles are stored as UserRoleGrant
 * rows and checked on the server on every request; the browser only hides what it cannot use.
 *
 *   ddc_admin  everything below
 *   operator   day-to-day ops: ops.read, ops.write, ops.support. Defined now, assigned to nobody yet.
 *   developer  console only: may register SSO clients while public self-serve registration is
 *              closed. It gives no ops access.
 *
 * Two session kinds are not roles a user can hold:
 *   shared  the emergency shared login (OPS_SHARED_LOGIN=on): ops.read, ops.write
 *   demo    the read-only demo login: ops.read
 *
 * Staff = ddc_admin or operator. A user who has both acts as ddc_admin.
 */

const ROLES = Object.freeze(['ddc_admin', 'operator', 'developer']);
const STAFF_ROLES = Object.freeze(['ddc_admin', 'operator']);

const PERMISSIONS = Object.freeze(['ops.read', 'ops.write', 'ops.support', 'ops.payouts', 'ops.admin']);

const ROLE_PERMISSIONS = Object.freeze({
  ddc_admin: Object.freeze([...PERMISSIONS]),
  operator: Object.freeze(['ops.read', 'ops.write', 'ops.support']),
  shared: Object.freeze(['ops.read', 'ops.write']),
  demo: Object.freeze(['ops.read']),
});

/** The closed list of audit actions (OpsAuditLog.action). */
const AUDIT_ACTIONS = Object.freeze([
  'auth.sign_in',
  'auth.shared_sign_in',
  'role.grant',
  'role.revoke',
  'account.disable',
  'account.enable',
  'points.adjust',
  'sso.planet_manager.assign',
  'console.staff_unlock',
  'console.client_register',
  // Money and balance routes: the row is written in the transaction of the change.
  'payment.confirm',
  'payment.reject',
  'merchant.credit',
  'order.attest',
  'disbursement.process',
  'disbursement.disburse',
  'demand.fulfill',
  'raffle.draw',
  'ops.write',
]);

const ACTOR_KINDS = Object.freeze(['user', 'shared', 'system']);
const SURFACES = Object.freeze(['ops', 'console', 'script']);

/** A reason is trimmed and must then be 3..200 characters. */
const REASON_MIN = 3;
const REASON_MAX = 200;

function isRole(value) {
  return typeof value === 'string' && ROLES.includes(value);
}

function isPermission(value) {
  return typeof value === 'string' && PERMISSIONS.includes(value);
}

/** The staff role a set of grants acts as: ddc_admin wins over operator; null when neither. */
function staffRole(roles) {
  const list = Array.isArray(roles) ? roles : [];
  if (list.includes('ddc_admin')) return 'ddc_admin';
  if (list.includes('operator')) return 'operator';
  return null;
}

/** Permissions of an ops session role (ddc_admin | operator | shared | demo); [] for anything else. */
function permissionsFor(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role) ? [...ROLE_PERMISSIONS[role]] : [];
}

function can(role, permission) {
  return permissionsFor(role).includes(permission);
}

/** The trimmed reason, or null when it is missing or outside 3..200 characters. */
function cleanReason(value) {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) return null;
  return reason;
}

module.exports = {
  ROLES,
  STAFF_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  AUDIT_ACTIONS,
  ACTOR_KINDS,
  SURFACES,
  REASON_MIN,
  REASON_MAX,
  isRole,
  isPermission,
  staffRole,
  permissionsFor,
  can,
  cleanReason,
};
