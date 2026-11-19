/** Only dedicated host credentials enter this router. Ordinary Wallet bearers use legacy routes. */
const express = require('express');
const { protectHost, sendError } = require('../middlewares/developerHostAuth');
const clients = require('../services/developerHostClients');
const { DeveloperClientError } = require('../services/ssoDeveloperClient');
const { publicBaseUrl } = require('../constants/lifeContext');
const { partnerResourceUrl } = require('../constants/partnerClient');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const router = express.Router();
router.use((req, res, next) => {
  if (!/^Bearer\s+dhs_/i.test(String(req.headers.authorization || ''))) return next('router');
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  return protectHost(req, res, next);
});
function endpoints(req) {
  const issuer = publicBaseUrl(req);
  return { issuer, token_endpoint_auth_method: 'client_secret_post', authorization_endpoint: issuer + '/oauth/authorize',
    token_endpoint: issuer + '/oauth/token', userinfo_endpoint: issuer + '/partner/sso/me', resource: partnerResourceUrl(req) };
}
function call(fn) {
  return async (req, res) => {
    try { return await fn(req, res); }
    catch (error) {
      if (error instanceof DeveloperClientError) return res.status(error.status).json({ error: error.code, error_description: error.message });
      return sendError(res, error);
    }
  };
}
const body = req => req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
router.get('/me', rateLimiters.developerConsoleRead, call(async (req, res) => res.json(await clients.me(req.developerHost))));
router.get('/clients', rateLimiters.developerConsoleRead, call(async (req, res) => res.json(await clients.list(req.developerHost))));
router.post('/clients', rateLimiters.developerClientCreate, call(async (req, res) => {
  const metadata = endpoints(req); // Validate public metadata before the write/one-time secret.
  return res.status(201).json({ ...await clients.create(req.developerHost, body(req), req.reqId || null), ...metadata });
}));
for (const [action, limiter] of [['update', rateLimiters.developerConsoleUpdate], ['secret', rateLimiters.developerClientRotate], ['consent', rateLimiters.developerConsoleUpdate]]) {
  router.post('/clients/' + action, limiter, call(async (req, res) => {
    const metadata = action === 'secret' ? endpoints(req) : {};
    return res.json({ ...await clients.mutate(req.developerHost, body(req), action, req.reqId || null), ...metadata });
  }));
}
// A dedicated credential cannot accidentally reach an unowned/staff route in a later router.
router.use((req, res) => res.status(404).json({ error: 'not_found', error_description: 'Unknown developer resource.' }));
module.exports = router;
