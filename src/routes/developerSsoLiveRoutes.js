const express = require('express');
const { createDeveloperClient } = require('../services/ssoDeveloperLive');

const router = express.Router();
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const recent = (hits.get(ip) || []).filter((at) => now - at < windowMs);
  if (recent.length >= 5) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

router.post('/clients', async (req, res) => {
  try {
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
    if (limited(ip)) {
      return res.status(429).json({
        error: 'rate_limited',
        error_description: 'Too many client registrations from this address. Please wait an hour.',
      });
    }
    const created = await createDeveloperClient(req.body || {});
    return res.status(201).json({
      client_id: created.clientId,
      client_secret: created.clientSecret,
      client_name: created.clientName,
      redirect_uris: created.redirectUris,
      token_endpoint_auth_method: 'client_secret_post',
      issuer: created.issuer,
      authorization_endpoint: `${created.issuer}/oauth/authorize`,
      token_endpoint: `${created.issuer}/oauth/token`,
      userinfo_endpoint: `${created.issuer}/partner/sso/me`,
      resource: created.resource,
      scopes: created.scopes,
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('Developer client registration failed', error && error.message);
    return res.status(status).json({
      error: error.code || 'server_error',
      error_description: status >= 500 ? 'Could not create the client.' : error.message,
    });
  }
});

module.exports = router;
