/**
 * POST /api/auth/native/token and POST /api/auth/native/complete (contract §2.1 #10–11).
 * Authenticated by loginId + loginSecret only (no session). The router answers 404 before these
 * run while DDC_AUTH_ENABLED is off, and applies the nativeComplete limiter.
 *
 * Nothing from the body is logged here: loginId, loginSecret and signature are secrets (the
 * services log loginRef only).
 */
const { sendSuccess, sendNativeError } = require('./respond');
const { reissueToken, completeLogin } = require('../../services/nativeAuth/complete');
const { HttpReply } = require('../../services/loginCompletion');

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

async function token(req, res, next) {
  try {
    const { loginId, loginSecret, reason } = body(req);
    const data = await reissueToken({ loginId, loginSecret, reason, cfg: req.nativeAuthConfig });
    return sendSuccess(res, data);
  } catch (err) {
    return sendNativeError(res, next, err);
  }
}

async function complete(req, res, next) {
  try {
    const { httpStatus, data } = await completeLogin({ body: body(req), cfg: req.nativeAuthConfig });
    return sendSuccess(res, data, httpStatus);
  } catch (err) {
    // The referral codes of web3auth-login (INVALID_CODE, CAMPAIGN_*, CAMPAIGN_INVITER_LOCKED, …)
    // pass through with today's status and body.
    if (err instanceof HttpReply) return res.status(err.status).json(err.body);
    return sendNativeError(res, next, err);
  }
}

module.exports = { token, complete };
