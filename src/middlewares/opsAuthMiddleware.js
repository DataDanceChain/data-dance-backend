const jwt = require('jsonwebtoken');
const { createLogger } = require('../utils/logger');
const { permissionsFor, isPermission } = require('../constants/opsRoles');
const { OPS_TOKEN_TYPE, sharedLoginOn } = require('../services/opsSignIn');
const { loadUserWithRoles } = require('../services/userRoles');
const { issuedBeforeReset } = require('../services/staffSession');
const { staffRecordLabel } = require('../services/opsAudit');
const { classifyAuthError, sendDatabaseUnavailable } = require('./authErrors');

const logger = createLogger('opsAuth');

function refuse(res, status, code, message) {
  return res.status(status).json({ status: 'fail', code, message });
}

function sessionInvalid(res, status = 401) {
  return refuse(res, status, 'OPS_SESSION_INVALID', 'Invalid ops session. Please sign in again.');
}

/**
 * Every /api/ops route except /auth/login, /auth/code and /auth/exchange.
 *
 *   - Bearer token, verified with JWT_SECRET, type 'ops_admin'. Missing or not verifiable: 401
 *     OPS_SESSION_INVALID; expired: 401 OPS_SESSION_EXPIRED; another kind of token (a wallet JWT):
 *     403 OPS_SESSION_INVALID.
 *   - kind 'user' (personal session): the account is loaded with its roles on every request. No
 *     such account: 401 OPS_SESSION_INVALID; disabled: 403 ACCOUNT_DISABLED; issued before the
 *     account's last disable / enable (User.sessionsResetAt): 401 OPS_SESSION_INVALID; neither
 *     ddc_admin nor operator: 403 NOT_STAFF. So a role revoked mid-session stops the next call,
 *     and a re-enabled account signs in again.
 *   - role 'demo': unchanged (read-only, see restrictDemo).
 *   - kind 'shared', or a legacy token with role 'admin' (issued by the shared login before
 *     personal sign-in): accepted unless OPS_SHARED_LOGIN=off.
 *
 * req.opsAdmin = { kind, userId, username, role, roles }. `username` fills the existing "by"
 * fields (a point's source id, resolvedBy, kycReviewedBy, ledger metadata, campaign createdBy /
 * updatedBy / publishedBy and events, data request events), which users, merchants and the demo
 * login can read. A personal session's is therefore its record label (opsAudit.staffRecordLabel),
 * never its e-mail or id; the person is kept only in OpsAuditLog (actorUserId, actorLabel).
 */
async function protectOps(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return sessionInvalid(res);
  const token = header.slice('Bearer '.length).trim();
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ status: 'error', message: 'JWT_SECRET is not configured' });
  }
  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch (error) {
    if (error && error.name === 'TokenExpiredError') {
      return refuse(res, 401, 'OPS_SESSION_EXPIRED', 'Ops session expired. Please sign in again.');
    }
    return sessionInvalid(res);
  }
  if (!decoded || decoded.type !== OPS_TOKEN_TYPE) return sessionInvalid(res, 403);

  if (decoded.kind === 'user') {
    if (typeof decoded.sub !== 'string' || !decoded.sub) return sessionInvalid(res);
    let staff;
    try {
      staff = await loadUserWithRoles(decoded.sub);
    } catch (error) {
      logger.error('Ops session lookup failed', {
        reqId: req.reqId || null,
        errorName: error && error.name,
        errorCode: error && error.code,
      });
      if (classifyAuthError(error) === 'db_unavailable') {
        return sendDatabaseUnavailable(res, 'Service temporarily unavailable. Please try again shortly.');
      }
      return res.status(500).json({ status: 'error', message: 'Server error' });
    }
    if (!staff) return sessionInvalid(res);
    if (staff.user.disabledAt) return refuse(res, 403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
    if (issuedBeforeReset(decoded, staff.user.sessionsResetAt)) return sessionInvalid(res);
    if (!staff.role) return refuse(res, 403, 'NOT_STAFF', 'This account has no operations access.');
    req.opsAdmin = {
      kind: 'user',
      userId: staff.user.id,
      username: staffRecordLabel(staff.user.id),
      email: staff.user.email,
      name: staff.user.name,
      role: staff.role,
      roles: staff.roles,
    };
    return next();
  }

  if (decoded.role === 'demo') {
    req.opsAdmin = { kind: 'demo', userId: null, username: decoded.sub, role: 'demo', roles: [] };
    return next();
  }

  if (decoded.kind === 'shared' || decoded.role === 'admin') {
    if (!sharedLoginOn()) return sessionInvalid(res);
    req.opsAdmin = { kind: 'shared', userId: null, username: 'shared', role: 'shared', roles: [] };
    return next();
  }

  return sessionInvalid(res);
}

/** External demo sessions can read every ops page and cannot change anything. */
function restrictDemo(req, res, next) {
  if (req.opsAdmin?.role !== 'demo') return next();
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return res.status(403).json({
    status: 'fail',
    message: 'This demo account can view data but cannot change it',
  });
}

/** One permission per route (src/constants/opsRoles.js). Missing: 403 FORBIDDEN_ROLE. */
function requireOps(permission) {
  if (!isPermission(permission)) throw new Error(`Unknown ops permission: ${permission}`);
  const guard = (req, res, next) => {
    if (permissionsFor(req.opsAdmin && req.opsAdmin.role).includes(permission)) return next();
    return refuse(res, 403, 'FORBIDDEN_ROLE', 'Your role does not allow this.');
  };
  guard.opsPermission = permission;
  return guard;
}

/** Whether the current ops session holds `permission`. */
function opsCan(req, permission) {
  return permissionsFor(req.opsAdmin && req.opsAdmin.role).includes(permission);
}

module.exports = { protectOps, restrictDemo, requireOps, opsCan, OPS_TOKEN_TYPE };
