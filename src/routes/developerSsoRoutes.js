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

function audit(req, action, clientId, outcome) {
  consoleAudit.write(`developer_console.${action}`, {
    reqId: req.reqId || null,
    userId: req.user.id,
    clientId: consoleClientId(clientId),
    outcome,
  });
}

function sendConsoleError(res, error, what) {
  if (error instanceof DeveloperClientError && error.status < 500) {
    return res.status(error.status).json({ error: error.code, error_description: error.message });
  }
  logger.error(`Developer console ${what} failed`, { message: error && error.message });
  return res.status(500).json({
    error: 'server_error',
    error_description: 'Could not complete that request.',
  });
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
    return sendConsoleError(res, error, 'list');
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
    return sendConsoleError(res, error, 'update');
  }
});

router.post('/clients/secret', noStore, protect, rateLimiters.developerClientRotate, async (req, res) => {
  const body = consoleBody(req);
  try {
    const { client, clientSecret } = await rotateOwnedSecret(req.user.id, body.client_id);
    audit(req, 'rotate_secret', body.client_id, 'ok');
    const issuer = publicBaseUrl(req);
    // The registration answer's shape, so the console shows the new secret the same way.
    return res.json({
      client_id: client.client_id,
      client_secret: clientSecret,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'client_secret_post',
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/partner/sso/me`,
      resource: partnerResourceUrl(req),
      scopes: client.scopes,
    });
  } catch (error) {
    audit(req, 'rotate_secret', body.client_id, outcomeOf(error));
    return sendConsoleError(res, error, 'secret rotation');
  }
});

module.exports = router;
module.exports.consoleAudit = consoleAudit;
