/**
 * Ops sign-in, roles, account status, audit and sign-in issues (admin issue #2).
 * Envelope: { status: 'success', data } / { status: 'fail', code, message }.
 */
const { createLogger } = require('../utils/logger');
const { permissionsFor } = require('../constants/opsRoles');
const { OpsError, actorFromOps, listAudit } = require('../services/opsAudit');
const { mintSignInCode, exchangeSignInCode } = require('../services/opsSignIn');
const { listGrants, grantRole, revokeRole } = require('../services/userRoles');
const { disableAccount, enableAccount } = require('../services/opsAccounts');
const { listIdentityConflicts } = require('../services/identityConflicts');
const { grantPlanetManager } = require('../services/ssoDeveloperLive');

const logger = createLogger('opsAccess');

const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function sendError(req, res, error, what) {
  if (error instanceof OpsError && error.status < 500) {
    return res.status(error.status).json({ status: 'fail', code: error.code, message: error.message });
  }
  // Name and code only: a Prisma message can quote the call's arguments.
  logger.error(`Ops ${what} failed`, {
    reqId: req.reqId || null,
    errorName: error && ERROR_NAME.test(String(error.name)) ? error.name : null,
    errorCode: error && ERROR_CODE.test(String(error.code)) ? error.code : null,
  });
  return res.status(500).json({ status: 'error', message: 'Server error' });
}

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

/** POST /api/ops/auth/code (wallet JWT through `protect`). */
exports.createSignInCode = async (req, res) => {
  noStore(res);
  try {
    const data = await mintSignInCode({ user: req.user, authClaims: req.authClaims, body: body(req) });
    return res.json({ status: 'success', data });
  } catch (error) {
    return sendError(req, res, error, 'sign-in code');
  }
};

/** POST /api/ops/auth/exchange (public). */
exports.exchangeSignInCode = async (req, res) => {
  noStore(res);
  try {
    const data = await exchangeSignInCode({ body: body(req), requestId: req.reqId || null });
    return res.json({ status: 'success', data });
  } catch (error) {
    return sendError(req, res, error, 'sign-in exchange');
  }
};

/** GET /api/ops/auth/me */
exports.me = (req, res) => {
  noStore(res);
  const ops = req.opsAdmin;
  return res.json({
    status: 'success',
    data: {
      kind: ops.kind,
      userId: ops.userId || null,
      email: ops.kind === 'user' ? ops.email : null,
      name: ops.kind === 'user' ? ops.name || null : null,
      username: ops.username,
      role: ops.role,
      roles: ops.roles || [],
      permissions: permissionsFor(ops.role),
    },
  });
};

/** GET /api/ops/roles?role= */
exports.listRoles = async (req, res) => {
  try {
    const items = await listGrants({ role: req.query.role });
    return res.json({ status: 'success', data: { items } });
  } catch (error) {
    return sendError(req, res, error, 'role list');
  }
};

/** POST /api/ops/users/:userId/roles { role, reason } */
exports.grantRole = async (req, res) => {
  try {
    const input = body(req);
    const result = await grantRole({
      userId: req.params.userId,
      role: input.role,
      reason: input.reason,
      actor: actorFromOps(req.opsAdmin),
      requestId: req.reqId || null,
    });
    req.auditWritten = true;
    return res.status(201).json({ status: 'success', data: { grant: result.grant } });
  } catch (error) {
    return sendError(req, res, error, 'role grant');
  }
};

/** POST /api/ops/users/:userId/roles/:role/revoke { reason } */
exports.revokeRole = async (req, res) => {
  try {
    const result = await revokeRole({
      userId: req.params.userId,
      role: req.params.role,
      reason: body(req).reason,
      actor: actorFromOps(req.opsAdmin),
      requestId: req.reqId || null,
    });
    req.auditWritten = true;
    return res.json({ status: 'success', data: { revoked: result.revoked } });
  } catch (error) {
    return sendError(req, res, error, 'role revoke');
  }
};

/** POST /api/ops/users/:userId/disable { reason } */
exports.disableUser = async (req, res) => {
  try {
    const result = await disableAccount({
      userId: req.params.userId,
      reason: body(req).reason,
      actor: actorFromOps(req.opsAdmin),
      requestId: req.reqId || null,
    });
    req.auditWritten = true;
    return res.json({ status: 'success', data: { user: result.user } });
  } catch (error) {
    return sendError(req, res, error, 'account disable');
  }
};

/** POST /api/ops/users/:userId/enable { reason } */
exports.enableUser = async (req, res) => {
  try {
    const result = await enableAccount({
      userId: req.params.userId,
      reason: body(req).reason,
      actor: actorFromOps(req.opsAdmin),
      requestId: req.reqId || null,
    });
    req.auditWritten = true;
    return res.json({ status: 'success', data: { user: result.user } });
  } catch (error) {
    return sendError(req, res, error, 'account enable');
  }
};

/** GET /api/ops/audit */
exports.listAudit = async (req, res) => {
  try {
    const data = await listAudit(req.query || {});
    return res.json({ status: 'success', data });
  } catch (error) {
    return sendError(req, res, error, 'audit list');
  }
};

/** GET /api/ops/identity-conflicts */
exports.listIdentityConflicts = async (req, res) => {
  try {
    const data = await listIdentityConflicts(req.query || {});
    return res.json({ status: 'success', data });
  } catch (error) {
    return sendError(req, res, error, 'sign-in issue list');
  }
};

/** POST /api/ops/sso/planet-manager { email, reason } */
exports.assignPlanetManager = async (req, res) => {
  try {
    const input = body(req);
    const result = await grantPlanetManager(input.email, {
      actor: actorFromOps(req.opsAdmin),
      reason: input.reason,
      requestId: req.reqId || null,
    });
    req.auditWritten = true;
    return res.json({ status: 'success', data: result });
  } catch (error) {
    const status = (error && (error.status || error.statusCode)) || 500;
    if (status < 500 && error && error.code) {
      return res.status(status).json({ status: 'fail', code: error.code, message: error.message });
    }
    return sendError(req, res, error, 'Data Planet manager assignment');
  }
};
