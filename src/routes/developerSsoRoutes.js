/**
 * Self-serve registration for a DDC SSO client, by a signed-in DataDance account.
 * POST /api/developer/sso/clients returns the secret once. Nothing here lists existing secrets.
 * Closed unless SSO_DEVELOPER_REGISTRATION=on (src/constants/developerRegistration.js). When it is
 * on, the route itself still requires a user JWT (`protect`), so its protection does not depend on
 * where any other router is mounted.
 */
const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { publicBaseUrl } = require('../constants/lifeContext');
const { partnerResourceUrl } = require('../constants/partnerClient');
const { developerRegistrationOpen } = require('../constants/developerRegistration');
const { createLogger } = require('../utils/logger');
const { createDeveloperClient, DeveloperClientError } = require('../services/ssoDeveloperClient');

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

module.exports = router;
