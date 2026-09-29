/**
 * POST /api/auth/native/email/start and /email/verify (contract §2.1 rows 3–4, design §3.3).
 * Reached only while DDC_AUTH_ENABLED=true and `email` is in DDC_AUTH_METHODS (the router answers
 * 404 before); the per-IP limiters run ahead of these handlers.
 *
 * start  {email, locale, turnstileToken?} → {challengeId, expiresInSec, resendAfterSec, codeLength}
 *        identical for known and unknown addresses (no account is looked at).
 * verify {challengeId, code, intent?, turnstileToken?} → Identified (identify.createLoginAttempt,
 *        work package BE6). intent 'link' needs the caller's bearer session, checked BEFORE the
 *        code is spent; it returns no Web3Auth token (BE6 contract).
 */
const { protect } = require('../../middlewares/authMiddleware');
const emailOtp = require('../../services/nativeAuth/emailOtp');
const { NativeAuthError, sendSuccess, sendNativeError } = require('./respond');

function requestContext(req) {
  return {
    ip: req.ip,
    userAgent: req.get('user-agent') || '',
    country: req.get('cf-ipcountry') || '',
    localAddress: req.socket && req.socket.localAddress,
  };
}

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/**
 * Handlers with injectable collaborators (tests). `authenticate` is an Express middleware that
 * sets req.user or answers 401 itself; `identify` is the BE6 module (createLoginAttempt).
 */
function createEmailController({
  otp = emailOtp,
  authenticate = protect,
  identify = () => require('../../services/nativeAuth/identify'),
  config = (req) => req.nativeAuthConfig,
} = {}) {
  async function start(req, res, next) {
    try {
      const { email, locale, turnstileToken } = body(req);
      if (typeof email !== 'string') throw new NativeAuthError('INVALID_EMAIL', { message: 'Enter a valid e-mail address.' });
      const cfg = config(req);
      const data = await otp.startEmailChallenge({
        email,
        locale: typeof locale === 'string' ? locale : '',
        turnstileToken,
        request: requestContext(req),
        ...(cfg ? { cfg } : {}),
      });
      return sendSuccess(res, data);
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  async function finishVerify(req, res, next, intent) {
    try {
      const { challengeId, code, turnstileToken } = body(req);
      const cfg = config(req);
      const verified = await otp.verifyEmailChallenge({
        challengeId,
        code,
        turnstileToken,
        request: requestContext(req),
        ...(cfg ? { cfg } : {}),
      });
      const identified = await identify().createLoginAttempt({
        identity: otp.emailIdentity(verified.email),
        intent,
        method: 'email',
        req,
        bearerUser: intent === 'link' ? req.user : undefined,
      });
      return sendSuccess(res, identified);
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  function verify(req, res, next) {
    // Only 'link' changes anything; an absent or unknown intent is a plain login.
    const intent = body(req).intent === 'link' ? 'link' : 'login';
    if (intent !== 'link') return finishVerify(req, res, next, intent);
    return authenticate(req, res, (err) => (err ? next(err) : finishVerify(req, res, next, intent)));
  }

  return { start, verify };
}

module.exports = { ...createEmailController(), createEmailController, requestContext };
