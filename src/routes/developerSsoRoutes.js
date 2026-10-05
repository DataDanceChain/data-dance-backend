/**
 * Public self-serve registration for a DDC SSO client.
 * POST /api/developer/sso/clients returns the secret once. Nothing here lists existing secrets.
 */
const express = require('express');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { publicBaseUrl } = require('../constants/lifeContext');
const { partnerResourceUrl } = require('../constants/partnerClient');
const { createLogger } = require('../utils/logger');
const { createDeveloperClient, DeveloperClientError } = require('../services/ssoDeveloperClient');

const router = express.Router();
const logger = createLogger('developerSso');

router.post('/clients', rateLimiters.developerClientCreate, async (req, res) => {
  try {
    const created = await createDeveloperClient(req.body || {});
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
