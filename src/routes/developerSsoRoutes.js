/**
 * Self-serve registration for a DDC SSO client, by a signed-in DataDance account.
 * POST /api/developer/sso/clients returns the secret once. Nothing here lists existing secrets.
 * Closed unless SSO_DEVELOPER_REGISTRATION=on or allowlist (src/constants/developerRegistration.js),
 * or the account has the developer or ddc_admin role (below). The route itself requires a user JWT
 * (`protect`), so its protection does not depend on where any other router is mounted. In allowlist
 * mode only a listed account with a verified login e-mail, or one of those roles, gets past
 * `registrationAllowed`; every other one gets the off answer.
 *
 * The account console (the frontend's /developers/ page) reads and changes the signed-in account's
 * own clients. These routes do not depend on the registration switch:
 *   GET  /api/developer/sso/clients         { email, clients: [...] }
 *   POST /api/developer/sso/clients/update  { client_id, redirect_uris, enabled? } -> the client
 *   POST /api/developer/sso/clients/secret  { client_id } -> a new secret, shown once
 * Each requires a user JWT (`protect`) and is rate-limited per account. A client that is not the
 * account's own answers 404, the same as one that does not exist.
 *
 * Roles (src/services/userRoles.js, admin issue #2):
 *   GET /api/developer/sso/me                   { user_id, email, roles, admin, can_register,
 *                                                 verified_session }
 *   GET /api/developer/sso/admin/clients        ddc_admin: every client, read-only, never a secret
 *   GET /api/developer/sso/admin/staff-unlock   ddc_admin: the staff network unlock (audited)
 * While registration is off, or allowlist does not admit the account, a signed-in account with
 * the developer or ddc_admin role may still register a client (audited: console.client_register);
 * anyone else gets registration_closed, and so does every caller without a token while it is off.
 *
 * These staff uses of a wallet JWT (the two admin routes, and registering while registration is
 * closed) apply the rule of POST /api/ops/auth/code (src/services/staffSession.js): a verified
 * session (ver 2), else 403 verified_session_required; not issued before the account's last
 * disable / enable, else 401 session_revoked. A listed account in allowlist mode needs the same
 * second part: a session from before its last disable / enable does not count as listed (see
 * modeDecision), and it gets the off answer like any other refused account.
 */
const express = require('express');
const prisma = require('../utils/prisma');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { publicBaseUrl } = require('../constants/lifeContext');
const { partnerResourceUrl } = require('../constants/partnerClient');
const { developerRegistrationMode, registrationDecision } = require('../constants/developerRegistration');
const { createLogger } = require('../utils/logger');
const {
  createDeveloperClient,
  DeveloperClientError,
  consoleClientId,
  listOwnedClients,
  listAllClients,
  updateOwnedClient,
  rotateOwnedSecret,
} = require('../services/ssoDeveloperClient');
const { activeRoles } = require('../services/userRoles');
const { writeAudit, actorFromUser, OpsError } = require('../services/opsAudit');
const { assertStaffWalletSession, issuedBeforeReset, verifiedSession } = require('../services/staffSession');

const router = express.Router();
const logger = createLogger('developerSso');

function registrationClosed(res) {
  return res.status(403).json({
    error: 'registration_closed',
    error_description: 'Self-serve client registration is closed. Contact DataDance to register a client.',
  });
}

function hasBearer(req) {
  return /^Bearer\s+\S+/i.test(String(req.headers.authorization || ''));
}

// First on the route, before the login check, the rate limiter and any database access: while
// registration is off, a caller without a token gets the same answer as before and nothing is read
// or written. Any other caller goes on to `protect` and `registrationAllowed` below (on and
// allowlist: an anonymous caller gets protect's 401).
function registrationOpen(req, res, next) {
  if (developerRegistrationMode() !== 'off') return next();
  if (!hasBearer(req)) return registrationClosed(res);
  return next();
}

/** Where a refused registration is logged. Replaceable for tests. */
const registrationLog = {
  info: (event, entry) => logger.info(event, entry),
};

/**
 * Whether the mode admits the account `protect` loaded by itself, and why not (the reason goes to
 * the refusal line). on: every signed-in account. allowlist: registrationDecision (a listed account
 * with a verified login e-mail), and the session must not be older than the account's last disable /
 * enable (User.sessionsResetAt), as on the staff routes: the list grants a privilege, like the roles,
 * so re-enabling an account does not bring an older session back to it. Never reads the body.
 */
function modeDecision(req) {
  const decision = registrationDecision(req.user, req.authClaims);
  if (
    decision.allowed &&
    developerRegistrationMode() === 'allowlist' &&
    issuedBeforeReset(req.authClaims, req.user && req.user.sessionsResetAt)
  ) {
    return { allowed: false, reason: 'session_revoked' };
  }
  return decision;
}

/**
 * A wallet JWT acting as staff on the console (see the header): verified, and not issued before
 * the account's last disable / enable. Answers false after sending the refusal.
 */
function staffSessionOk(req, res) {
  try {
    assertStaffWalletSession(req.user, req.authClaims);
    return true;
  } catch (error) {
    if (!(error instanceof OpsError)) throw error;
    res.status(error.status).json({
      error: error.code === 'SESSION_REVOKED' ? 'session_revoked' : 'verified_session_required',
      error_description: error.message,
    });
    return false;
  }
}

/**
 * After `protect`, before the rate limiter. on lets every signed-in account through, allowlist a
 * listed account with a verified login e-mail and a session newer than its last disable / enable
 * (modeDecision: the account row and the verified JWT, never the body). When that refuses (off, or allowlist and not admitted), the developer or
 * ddc_admin role may still register, from a staff session; the role is kept for the audit row.
 * Everyone else gets the off answer, so it never tells whether an address is listed, and an account
 * that is refused does not use up the per-IP registration limit. One log line per refusal: the
 * account id and the reason code, never the e-mail.
 */
async function registrationAllowed(req, res, next) {
  const decision = modeDecision(req);
  if (decision.allowed) return next();
  try {
    const roles = await activeRoles(req.user.id);
    if (roles.includes('developer') || roles.includes('ddc_admin')) {
      if (!staffSessionOk(req, res)) return undefined;
      req.registrationRole = roles.includes('ddc_admin') ? 'ddc_admin' : 'developer';
      req.registrationMode = developerRegistrationMode();
      return next();
    }
  } catch (error) {
    logger.error('Developer registration role check failed', { errorName: error && error.name });
    return res.status(500).json({ error: 'server_error', error_description: 'Could not create the client.' });
  }
  try {
    registrationLog.info('developer_registration.refused', { reqId: req.reqId || null, userId: req.user.id, reason: decision.reason });
  } catch (_) {
    // A failed log line does not change the answer.
  }
  return registrationClosed(res);
}

/** The audit row of a registration made with a role while registration is off, or allowlist refused it. */
function registrationAudit(req) {
  if (!req.registrationRole) return undefined;
  return (tx, row) => writeAudit(tx, {
    actor: actorFromUser(req.user, req.registrationRole),
    action: 'console.client_register',
    target: { type: 'sso_client', id: row.clientId, label: row.clientName },
    detail: {
      kind: 'developer',
      registration: req.registrationMode === 'allowlist' ? 'allowlist' : 'closed',
      redirectUris: Array.isArray(row.redirectUris) ? row.redirectUris.length : 0,
    },
    surface: 'console',
    requestId: req.reqId || null,
  });
}

router.post('/clients', registrationOpen, protect, registrationAllowed, rateLimiters.developerClientCreate, async (req, res) => {
  try {
    // `protect` set req.user: the client belongs to the account that registered it. A
    // registration made with a role writes its audit row in the same transaction as the client.
    const created = await createDeveloperClient(req.body || {}, {
      ownerUserId: req.user.id,
      audit: registrationAudit(req),
    });
    const issuer = publicBaseUrl(req);
    return res.status(201).json({
      client_id: created.clientId,
      client_secret: created.clientSecret,
      client_name: created.clientName,
      redirect_uris: created.redirectUris,
      token_endpoint_auth_method: 'client_secret_post',
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/partner/sso/me`,
      resource: partnerResourceUrl(req),
      scopes: created.scopes,
    });
  } catch (error) {
    if (error instanceof DeveloperClientError) {
      return res.status(error.status).json({
        error: error.code,
        error_description: error.message,
      });
    }
    // The error's code and name only: a failed write's message can carry the row it refused.
    consoleLog.error('Developer client registration failed', {
      reqId: req.reqId || null,
      errorCode: errorCode(error && error.code),
      errorName: errorName(error && error.name),
    });
    return res.status(500).json({
      error: 'server_error',
      error_description: 'Could not create the client.',
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Account console
// ---------------------------------------------------------------------------------------------

// The console's answers describe one account; none of them is cached anywhere on the way.
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  return next();
}

/**
 * One line per change attempt: ids and the outcome only. Never a secret, a hash, a redirect URI
 * or the request body. Replaceable for tests.
 */
const consoleAudit = {
  write: (event, entry) => logger.info(event, entry),
};

/**
 * Where a console failure is logged. Replaceable for tests. Each line carries the request id and the
 * error's code and name, never error.message: a Prisma validation message prints the call's
 * arguments, and the rotate call's data is the new secret's hash.
 */
const consoleLog = {
  error: (event, entry) => logger.error(event, entry),
};

// Constant-style codes (P2025, ECONNREFUSED) and class-style names (PrismaClientValidationError).
// Both start with a capital, so a hex hash or a ddc_ secret can never pass as either.
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

function errorCode(value) {
  if (Number.isInteger(value)) return value;
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : null;
}

function errorName(value) {
  return typeof value === 'string' && ERROR_NAME.test(value) ? value : null;
}

function audit(req, action, clientId, outcome) {
  // A failed audit line must not turn a change that was made into an error answer: after a rotation
  // that answer would lose the only copy of the new secret.
  try {
    consoleAudit.write(`developer_console.${action}`, {
      reqId: req.reqId || null,
      userId: req.user.id,
      clientId: consoleClientId(clientId),
      outcome,
    });
  } catch (auditError) {
    try {
      consoleLog.error('developer_console.audit_failed', {
        reqId: req.reqId || null,
        action,
        errorName: errorName(auditError && auditError.name),
      });
    } catch (_) {
      // The logger itself failed: there is nowhere left to write.
    }
  }
}

function sendConsoleError(req, res, error, what) {
  if (error instanceof DeveloperClientError && error.status < 500) {
    return res.status(error.status).json({ error: error.code, error_description: error.message });
  }
  consoleLog.error(`Developer console ${what} failed`, {
    reqId: req.reqId || null,
    errorCode: errorCode(error && error.code),
    errorName: errorName(error && error.name),
  });
  return res.status(500).json({
    error: 'server_error',
    error_description: 'Could not complete that request.',
  });
}

/** The registration answer's issuer and endpoints. Reads the configuration, so it can throw. */
function issuerEndpoints(req) {
  const issuer = publicBaseUrl(req);
  return {
    token_endpoint_auth_method: 'client_secret_post',
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/partner/sso/me`,
    resource: partnerResourceUrl(req),
  };
}

function outcomeOf(error) {
  return error instanceof DeveloperClientError && error.status < 500 ? error.code : 'server_error';
}

function consoleBody(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

router.get('/clients', noStore, protect, rateLimiters.developerConsoleRead, async (req, res) => {
  try {
    const clients = await listOwnedClients(req.user.id);
    return res.json({ email: req.user.email || null, clients });
  } catch (error) {
    return sendConsoleError(req, res, error, 'list');
  }
});

// ---------------------------------------------------------------------------------------------
// Roles: who the signed-in account is to the console, and the DDC admin view
// ---------------------------------------------------------------------------------------------

router.get('/me', noStore, protect, rateLimiters.developerConsoleRead, async (req, res) => {
  try {
    const roles = await activeRoles(req.user.id);
    const admin = roles.includes('ddc_admin');
    return res.json({
      user_id: req.user.id,
      email: req.user.email || null,
      roles,
      admin,
      // on: any account; allowlist: a listed account with a verified login e-mail (modeDecision);
      // any mode: the roles.
      can_register: modeDecision(req).allowed || admin || roles.includes('developer'),
      // The staff routes need a verified session: false tells the console to ask for a new sign-in.
      verified_session: verifiedSession(req.authClaims),
    });
  } catch (error) {
    return sendConsoleError(req, res, error, 'me');
  }
});

/**
 * ddc_admin only, from a staff session; anyone else gets 403 forbidden and no data, and an admin
 * whose session is not a staff session gets 403 verified_session_required or 401 session_revoked.
 */
async function requireConsoleAdmin(req, res, next) {
  try {
    const roles = await activeRoles(req.user.id);
    if (!roles.includes('ddc_admin')) {
      return res.status(403).json({ error: 'forbidden', error_description: 'This view is for DataDance admins.' });
    }
    if (!staffSessionOk(req, res)) return undefined;
    return next();
  } catch (error) {
    return sendConsoleError(req, res, error, 'admin check');
  }
}

router.get('/admin/clients', noStore, protect, rateLimiters.developerConsoleRead, requireConsoleAdmin, async (req, res) => {
  try {
    const issuer = publicBaseUrl(req);
    const clients = await listAllClients();
    return res.json({ issuer, clients });
  } catch (error) {
    return sendConsoleError(req, res, error, 'admin client list');
  }
});

const STAFF_UNLOCK_TOKEN = /^[0-9a-f]{64}$/;

/**
 * The staff network unlock the wallet stores (keccak256 of the staff code), handed to a DDC admin's
 * console so the environment switch needs no code typed in. Each hand-out is audited.
 */
router.get('/admin/staff-unlock', noStore, protect, rateLimiters.developerConsoleRead, requireConsoleAdmin, async (req, res) => {
  const unlock = String(process.env.STAFF_UNLOCK_TOKEN || '').trim();
  if (!STAFF_UNLOCK_TOKEN.test(unlock)) {
    return res.status(404).json({ error: 'not_configured', error_description: 'The staff unlock is not configured here.' });
  }
  try {
    // Written before the answer: an unlock that cannot be recorded is not handed out.
    await writeAudit(prisma, {
      actor: actorFromUser(req.user, 'ddc_admin'),
      action: 'console.staff_unlock',
      target: { type: 'console', id: null, label: 'staff_unlock' },
      surface: 'console',
      requestId: req.reqId || null,
    });
    return res.json({ unlock_token: unlock });
  } catch (error) {
    return sendConsoleError(req, res, error, 'staff unlock');
  }
});

router.post('/clients/update', noStore, protect, rateLimiters.developerConsoleUpdate, async (req, res) => {
  const body = consoleBody(req);
  try {
    const client = await updateOwnedClient(req.user.id, body);
    audit(req, 'update', body.client_id, 'ok');
    return res.json(client);
  } catch (error) {
    audit(req, 'update', body.client_id, outcomeOf(error));
    return sendConsoleError(req, res, error, 'update');
  }
});

router.post('/clients/secret', noStore, protect, rateLimiters.developerClientRotate, async (req, res) => {
  const body = consoleBody(req);
  try {
    // Everything the answer needs is read before the new hash is written (here, and the client's
    // settings inside rotateOwnedSecret): once the old secret is dead, nothing may fail before the
    // caller has the new one.
    const endpoints = issuerEndpoints(req);
    const { client, clientSecret } = await rotateOwnedSecret(req.user.id, body.client_id);
    // The registration answer's shape, so the console shows the new secret the same way.
    const answer = {
      client_id: client.client_id,
      client_secret: clientSecret,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      ...endpoints,
      scopes: client.scopes,
    };
    audit(req, 'rotate_secret', body.client_id, 'ok');
    return res.json(answer);
  } catch (error) {
    audit(req, 'rotate_secret', body.client_id, outcomeOf(error));
    return sendConsoleError(req, res, error, 'secret rotation');
  }
});

module.exports = router;
module.exports.consoleAudit = consoleAudit;
module.exports.consoleLog = consoleLog;
module.exports.registrationLog = registrationLog;
