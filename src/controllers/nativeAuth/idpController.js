/**
 * POST /api/auth/native/nonce, /google and /apple (contract §2.1 rows 2, 5, 6; design §2.5, §3.4).
 * Reached only while DDC_AUTH_ENABLED=true and the method is in DDC_AUTH_METHODS (the router
 * answers 404 before); the nativeIdp limiter runs ahead of these handlers.
 *
 * nonce  {purpose:'google'|'apple'} → {nonce, nonceSha256, expiresInSec:300}
 * google {credential, nonce, intent?}                        → Identified
 * apple  {identityToken, nonce, user?:{firstName,lastName}, intent?} → Identified
 *
 * A method whose client ids / audiences are not configured is unavailable: METHOD_DISABLED, the
 * same answer as a method that is switched off. intent 'link' needs the caller's bearer session,
 * checked BEFORE the token is verified or the nonce spent; it returns no Web3Auth token (BE6).
 * The verified identity goes to identify.createLoginAttempt exactly as BE6 exposes it.
 */
const { protect } = require('../../middlewares/authMiddleware');
const flowState = require('../../services/nativeAuth/flowState');
const idpGoogle = require('../../services/nativeAuth/idpGoogle');
const idpApple = require('../../services/nativeAuth/idpApple');
const { readNativeAuthConfig, methodEnabled, logger } = require('../../services/nativeAuth/config');
const { NativeAuthError, sendSuccess, sendNativeError } = require('./respond');

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/**
 * Handlers with injectable collaborators (tests). `authenticate` is an Express middleware that
 * sets req.user or answers 401 itself; `identify` returns the BE6 module (createLoginAttempt).
 */
function createIdpController({
  google = idpGoogle,
  apple = idpApple,
  flow = flowState,
  authenticate = protect,
  identify = () => require('../../services/nativeAuth/identify'),
  config = (req) => req.nativeAuthConfig || readNativeAuthConfig(),
  log = logger,
} = {}) {
  const providers = {
    google: { enabled: (cfg) => methodEnabled(cfg, 'google') && google.googleAvailable(cfg) },
    apple: { enabled: (cfg) => methodEnabled(cfg, 'apple') && apple.appleAvailable(cfg) },
  };

  function assertAvailable(provider, cfg) {
    if (!providers[provider].enabled(cfg)) throw new NativeAuthError('METHOD_DISABLED');
  }

  async function nonce(req, res, next) {
    try {
      const { purpose } = body(req);
      const cfg = config(req);
      // An unknown purpose names no method we offer: the same answer as a method switched off.
      if (typeof purpose !== 'string' || !Object.prototype.hasOwnProperty.call(providers, purpose)) throw new NativeAuthError('METHOD_DISABLED');
      assertAvailable(purpose, cfg);
      return sendSuccess(res, await flow.issueIdpNonce({ purpose, cfg }));
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  async function finish(req, res, next, provider, intent, verify) {
    try {
      const cfg = config(req);
      const identity = await verify(cfg);
      log.info('native_auth.idp_verified', { provider, intent });
      const identified = await identify().createLoginAttempt({
        identity,
        intent,
        method: provider,
        req,
        bearerUser: intent === 'link' ? req.user : undefined,
      });
      return sendSuccess(res, identified);
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  /** Availability first, then (for link) the session, then the token and its nonce. */
  function handler(provider, verify) {
    return (req, res, next) => {
      try {
        assertAvailable(provider, config(req));
      } catch (err) {
        return sendNativeError(res, next, err);
      }
      // Only 'link' changes anything; an absent or unknown intent is a plain login.
      const intent = body(req).intent === 'link' ? 'link' : 'login';
      const run = () => finish(req, res, next, provider, intent, (cfg) => verify(body(req), cfg));
      if (intent !== 'link') return run();
      return authenticate(req, res, (err) => (err ? next(err) : run()));
    };
  }

  return {
    nonce,
    google: handler('google', (b, cfg) => google.verifyGoogleCredential({ credential: b.credential, nonce: b.nonce, cfg })),
    apple: handler('apple', (b, cfg) => apple.verifyAppleIdentityToken({ identityToken: b.identityToken, nonce: b.nonce, user: b.user, cfg })),
  };
}

module.exports = { ...createIdpController(), createIdpController };
