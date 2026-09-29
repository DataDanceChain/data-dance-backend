/**
 * Native login API, mounted at /api/auth/native (contract §2.1). Behind DDC_AUTH_ENABLED, read
 * per request: while it is off, EVERY path under the mount answers 404 NATIVE_AUTH_DISABLED
 * (GET /config adds data {enabled:false}) before any limiter, body check or handler runs, so the
 * disabled surface costs nothing and reveals nothing. Per-method switches (DDC_AUTH_METHODS)
 * answer 404 METHOD_DISABLED the same way.
 *
 * Every response is `Cache-Control: no-store`. The JWKS route is not here: it is public, cacheable
 * and served even with the flag off (see issuer.jwksHandler, mounted by src/app.js).
 *
 * Handlers belong to their work packages (email BE3, IdP + nonce BE4, X BE5, token/complete BE6,
 * identities BE7) and answer 501 until they land.
 */
const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { readNativeAuthConfig, methodEnabled } = require('../services/nativeAuth/config');
const { noStore, sendError } = require('../controllers/nativeAuth/respond');
const configController = require('../controllers/nativeAuth/configController');
const emailController = require('../controllers/nativeAuth/emailController');
const idpController = require('../controllers/nativeAuth/idpController');
const xController = require('../controllers/nativeAuth/xController');
const completeController = require('../controllers/nativeAuth/completeController');
const identitiesController = require('../controllers/nativeAuth/identitiesController');

const router = express.Router();

router.use(noStore);

/** The master switch. Off → 404 for everything under the mount. */
router.use((req, res, next) => {
  const cfg = readNativeAuthConfig();
  if (!cfg.enabled) {
    const isConfig = req.method === 'GET' && req.path === '/config';
    return sendError(res, 'NATIVE_AUTH_DISABLED', isConfig ? { data: { enabled: false } } : {});
  }
  req.nativeAuthConfig = cfg;
  return next();
});

/** 404 METHOD_DISABLED unless at least one of `methods` is in DDC_AUTH_METHODS. */
function requireMethod(...methods) {
  return (req, res, next) => {
    const cfg = req.nativeAuthConfig || readNativeAuthConfig();
    if (methods.some((method) => methodEnabled(cfg, method))) return next();
    return sendError(res, 'METHOD_DISABLED');
  };
}

// 1. LoginConfig
router.get('/config', configController.getConfig);

// 2. IdP nonce (Google / Apple)
router.post('/nonce', requireMethod('google', 'apple'), rateLimiters.nativeIdp, idpController.nonce);

// 3–4. E-mail OTP
router.post(
  '/email/start',
  requireMethod('email'),
  rateLimiters.nativeEmailStartBurst,
  rateLimiters.nativeEmailStartHourly,
  emailController.start,
);
router.post('/email/verify', requireMethod('email'), rateLimiters.nativeEmailVerify, emailController.verify);

// 5–6. Google / Apple
router.post('/google', requireMethod('google'), rateLimiters.nativeIdp, idpController.google);
router.post('/apple', requireMethod('apple'), rateLimiters.nativeIdp, idpController.apple);

// 7–9. X (backend PKCE + hand-off)
router.get('/x/start', requireMethod('x'), rateLimiters.nativeXStart, xController.start);
router.get('/x/callback', requireMethod('x'), xController.callback);
router.post('/x/exchange', requireMethod('x'), rateLimiters.nativeIdp, xController.exchange);

// 10–11. Re-mint and completion (loginSecret-authenticated)
router.post('/token', rateLimiters.nativeComplete, completeController.token);
router.post('/complete', rateLimiters.nativeComplete, completeController.complete);

// 12–15. Identities (session + step-up)
router.post('/identities/challenge', rateLimiters.nativeIdentities, protect, identitiesController.challenge);
router.get('/identities', rateLimiters.nativeIdentities, protect, identitiesController.list);
router.post('/identities/link', rateLimiters.nativeIdentities, protect, identitiesController.link);
router.delete('/identities/:id', rateLimiters.nativeIdentities, protect, identitiesController.unlink);

module.exports = router;
module.exports.requireMethod = requireMethod;
