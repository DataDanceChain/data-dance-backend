/**
 * Self-serve registration for a DDC SSO client, by a signed-in DataDance account.
 * POST /api/developer/sso/clients returns the secret once. Nothing here lists existing secrets.
 * Closed unless SSO_DEVELOPER_REGISTRATION=on (src/constants/developerRegistration.js). When it is
 * on, the route itself still requires a user JWT (`protect`), so its protection does not depend on
 * where any other router is mounted.
 *
 * The account console (the frontend's /developers/ page) reads and changes the signed-in account's
 * own clients. These routes do not depend on the registration switch:
 *   GET  /api/developer/sso/clients         { email, clients: [...] }
 *   POST /api/developer/sso/clients/update  { client_id, redirect_uris, enabled? } -> the client
 *   POST /api/developer/sso/clients/secret  { client_id } -> a new secret, shown once
 * Each requires a user JWT (`protect`) and is rate-limited per account. A client that is not the
 * account's own answers 404, the same as one that does not exist.
 */
const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { publicBaseUrl } = require('../constants/lifeContext');
const { partnerResourceUrl } = require('../constants/partnerClient');
const { developerRegistrationOpen } = require('../constants/developerRegistration');
const { createLogger } = require('../utils/logger');
const {
  createDeveloperClient,
  DeveloperClientError,
  consoleClientId,
  listOwnedClients,
  updateOwnedClient,
  rotateOwnedSecret,
} = require('../services/ssoDeveloperClient');

const router = express.Router();
const logger = createLogger('developerSso');

// First on the route, before the login check, the rate limiter and any database access: a closed
// endpoint gives everyone the same answer and writes nothing.
function registrationOpen(req, res, next) {
  if (developerRegistrationOpen()) return next();
  return res.status(403).json({
    error: 'registration_closed',
    error_description: 'Self-serve client registration is closed. Contact DataDance to register a client.',
  });
}

router.post('/clients', registrationOpen, protect, rateLimiters.developerClientCreate, async (req, res) => {
  try {
    // `protect` set req.user: the client belongs to the account that registered it.
    const created = await createDeveloperClient(req.body || {}, { ownerUserId: req.user.id });
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
    logger.error('Developer client registration failed', { message: error && error.message });
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
