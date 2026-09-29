/**
 * Response envelope and the closed error-code set of /api/auth/native/* (contract §2, §2.2).
 *
 *   success: { status: 'success', data }
 *   failure: { status: 'fail' (4xx) | 'error' (5xx), code, message, data? }
 *
 * Every response carries `Cache-Control: no-store` (router-level). The frontend's errors.ts maps
 * exactly NATIVE_ERROR_CODES; the referral codes of today's web3auth-login (INVALID_CODE,
 * CAMPAIGN_*, CAMPAIGN_INVITER_LOCKED) pass through /complete unchanged and are not listed here.
 * RATE_LIMITED comes from the limiters (sendRateLimited, native envelope).
 */
const NATIVE_ERROR_CODES = Object.freeze({
  NATIVE_AUTH_DISABLED: 404,
  METHOD_DISABLED: 404,
  INVALID_EMAIL: 400,
  TURNSTILE_FAILED: 400,
  OTP_RESEND_TOO_SOON: 429,
  OTP_SEND_LIMITED: 429,
  OTP_SEND_UNAVAILABLE: 503,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  OTP_LOCKED: 400,
  IDP_TOKEN_INVALID: 401,
  IDP_NONCE_INVALID: 401,
  IDP_UNAVAILABLE: 503,
  X_HANDOFF_INVALID: 400,
  ACCOUNT_LINK_REQUIRED: 409,
  NEW_ACCOUNTS_CLOSED: 403,
  ACCOUNT_DISABLED: 403,
  ORG_NOT_ALLOWED: 403,
  LOGIN_EXPIRED: 400,
  LOGIN_TOKEN_LIMIT: 429,
  WALLET_PROOF_INVALID: 401,
  WALLET_NOT_DERIVED: 401,
  W3A_LOOKUP_UNAVAILABLE: 503,
  WALLET_REBIND_REQUIRED: 409,
  WALLET_MISMATCH: 409,
  WALLET_IN_USE: 400,
  LOGIN_RACE: 409,
  STEP_UP_REQUIRED: 401,
  STEP_UP_INVALID: 401,
  IDENTITY_ALREADY_LINKED: 409,
  IDENTITY_LAST_METHOD: 409,
});

/** Emitted by the limiters, not by a handler. */
const TRANSPORT_CODES = Object.freeze({ RATE_LIMITED: 429 });

/**
 * Scaffolding only: the 501 the handler stubs answer until their work package lands. Not part of
 * the contract; nothing reaches it while DDC_AUTH_ENABLED is off.
 */
const STUB_CODE = 'NOT_IMPLEMENTED';

const DEFAULT_MESSAGES = Object.freeze({
  NATIVE_AUTH_DISABLED: 'Native sign-in is not available.',
  METHOD_DISABLED: 'This sign-in method is not available.',
  [STUB_CODE]: 'Not implemented yet.',
});

class NativeAuthError extends Error {
  constructor(code, { message, data, status } = {}) {
    super(message || DEFAULT_MESSAGES[code] || code);
    this.name = 'NativeAuthError';
    this.code = code;
    this.status = status || NATIVE_ERROR_CODES[code] || (code === STUB_CODE ? 501 : 500);
    if (data !== undefined) this.data = data;
  }
}

function sendSuccess(res, data, status = 200) {
  return res.status(status).json({ status: 'success', data });
}

function sendError(res, code, { message, data, status } = {}) {
  const httpStatus = status || NATIVE_ERROR_CODES[code] || (code === STUB_CODE ? 501 : 500);
  const body = { status: httpStatus >= 500 ? 'error' : 'fail', code, message: message || DEFAULT_MESSAGES[code] || code };
  if (data !== undefined) body.data = data;
  return res.status(httpStatus).json(body);
}

/** Answer a NativeAuthError in the envelope; anything else goes to the app's error handler. */
function sendNativeError(res, next, err) {
  if (err instanceof NativeAuthError) return sendError(res, err.code, { message: err.message, data: err.data, status: err.status });
  return next(err);
}

/** Router-level: no native response is ever cached. */
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

/** A 501 handler for an endpoint whose work package has not landed. */
function notImplemented(req, res) {
  return sendError(res, STUB_CODE);
}

module.exports = {
  NATIVE_ERROR_CODES,
  TRANSPORT_CODES,
  STUB_CODE,
  NativeAuthError,
  sendSuccess,
  sendError,
  sendNativeError,
  noStore,
  notImplemented,
};
