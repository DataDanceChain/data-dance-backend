/**
 * Google / Apple ID-token verification: the fixed rejection enum, the JWKS plumbing both providers
 * share, and the mapping from jose's errors to the contract codes (design §3.4, §2.2, F17).
 *
 * Every failure is reduced to one of IDP_REASONS BEFORE anything is answered or logged. Library
 * messages are never logged or returned: they can embed the token or its payload. The response
 * carries only the contract code (and `data.reason` from the enum for IDP_TOKEN_INVALID); the log
 * line carries only the provider and the reason.
 *
 *   IDP_TOKEN_INVALID  401  the token itself is not acceptable (reason ∈ IDP_REASONS minus nonce)
 *   IDP_NONCE_INVALID  401  the nonce is missing, wrong, reused or expired (reason 'nonce')
 *   IDP_UNAVAILABLE    503  the provider's key set could not be obtained (never the token's fault)
 */
const jose = require('jose');
const { NativeAuthError } = require('../../controllers/nativeAuth/respond');
const { logger } = require('./config');

/** The closed rejection enum (design §3.4). */
const IDP_REASONS = Object.freeze(['expired', 'audience', 'issuer', 'signature', 'nonce', 'malformed', 'azp']);

/** Why the key set was unusable; logged with idp_unavailable, never returned. */
const UNAVAILABLE_REASONS = Object.freeze(['network', 'http_status', 'invalid_json', 'timeout', 'invalid_jwks', 'internal']);

const JWKS_TIMEOUT_MS = 5000;
/** ID tokens are ~1–2 KB; anything far larger is not one. */
const MAX_TOKEN_LENGTH = 8192;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The key set could not be obtained (raised by fetchJwks, passed through jose untouched). */
class JwksUnavailableError extends Error {
  constructor(reason) {
    super(`JWKS unavailable (${reason})`);
    this.name = 'JwksUnavailableError';
    this.reason = reason;
  }
}

/** Raised by the verifiers: a token verdict already reduced to the enum. */
class IdpRejection extends Error {
  constructor(reason) {
    super(`ID token rejected (${reason})`);
    this.name = 'IdpRejection';
    this.reason = IDP_REASONS.includes(reason) ? reason : 'malformed';
  }
}

/**
 * The fetch jose uses for a provider's JWKS. Non-200 answers, connection failures and bodies that
 * are not JSON are decided here, where the response is in hand, so they surface as
 * JwksUnavailableError instead of a plain JOSEError indistinguishable from a token problem. A
 * timeout is left to jose (JWKSTimeout).
 */
async function fetchJwks(url, options) {
  const isTimeout = (err) => Boolean(err) && err.name === 'TimeoutError';
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error' });
  } catch (err) {
    if (isTimeout(err)) throw err;
    throw new JwksUnavailableError('network');
  }
  if (response.status !== 200) {
    try {
      await response.body?.cancel();
    } catch {
      /* the body is irrelevant */
    }
    throw new JwksUnavailableError('http_status');
  }
  let body;
  try {
    body = await response.text();
  } catch (err) {
    if (isTimeout(err)) throw err;
    throw new JwksUnavailableError('network');
  }
  try {
    JSON.parse(body);
  } catch {
    throw new JwksUnavailableError('invalid_json');
  }
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

const remoteSets = new Map();

/** One cached remote key set per URL (jose caches keys, refetches on an unknown kid). */
function remoteJwks(url, { timeoutMs = JWKS_TIMEOUT_MS } = {}) {
  const cacheKey = `${url}#${timeoutMs}`;
  if (!remoteSets.has(cacheKey)) {
    remoteSets.set(cacheKey, jose.createRemoteJWKSet(new URL(url), { timeoutDuration: timeoutMs, [jose.customFetch]: fetchJwks }));
  }
  return remoteSets.get(cacheKey);
}

/** Tests only: forget the cached key sets. */
function resetRemoteJwks() {
  remoteSets.clear();
}

/** Cheap shape check before any key is fetched: a compact JWS of sane length. */
function assertTokenShape(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(token)) {
    throw new IdpRejection('malformed');
  }
}

/**
 * jose error → IdpRejection (the token's fault) or JwksUnavailableError (the provider's). Only
 * the error's class and claim name are read, never its message.
 */
function classifyJoseError(err) {
  if (err instanceof IdpRejection || err instanceof JwksUnavailableError) return err;
  const code = err && err.code;
  if (err instanceof jose.errors.JWKSTimeout || code === 'ERR_JWKS_TIMEOUT') return new JwksUnavailableError('timeout');
  if (err instanceof jose.errors.JWKSInvalid || code === 'ERR_JWKS_INVALID') return new JwksUnavailableError('invalid_jwks');
  if (err instanceof jose.errors.JWTExpired || code === 'ERR_JWT_EXPIRED') return new IdpRejection('expired');
  if (err instanceof jose.errors.JWTClaimValidationFailed || code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    if (err.claim === 'aud') return new IdpRejection('audience');
    if (err.claim === 'iss') return new IdpRejection('issuer');
    // A time claim that is present but out of range; a missing or non-numeric one is malformed.
    if (['nbf', 'iat', 'exp'].includes(err.claim) && err.reason === 'check_failed') return new IdpRejection('expired');
    return new IdpRejection('malformed');
  }
  if (
    err instanceof jose.errors.JWSSignatureVerificationFailed ||
    err instanceof jose.errors.JWKSNoMatchingKey ||
    err instanceof jose.errors.JWKSMultipleMatchingKeys ||
    err instanceof jose.errors.JOSEAlgNotAllowed
  ) {
    return new IdpRejection('signature');
  }
  if (err instanceof jose.errors.JOSEError) return new IdpRejection('malformed'); // JWSInvalid, JWTInvalid, JOSENotSupported, …
  return new JwksUnavailableError('internal');
}

/**
 * Turn any verification failure into the contract error, logging `idp_rejected {provider, reason}`
 * or `idp_unavailable {provider, reason}` (error level). Nothing from the token, the payload or the
 * library message reaches the log or the response.
 */
function toNativeError(provider, err, log = logger) {
  if (err instanceof NativeAuthError) return err;
  const classified = classifyJoseError(err);
  if (classified instanceof JwksUnavailableError) {
    log.error('native_auth.idp_unavailable', { provider, reason: classified.reason });
    return new NativeAuthError('IDP_UNAVAILABLE', { message: 'The sign-in provider is temporarily unavailable. Please try again.' });
  }
  log.info('native_auth.idp_rejected', { provider, reason: classified.reason });
  if (classified.reason === 'nonce') {
    return new NativeAuthError('IDP_NONCE_INVALID', { message: 'This sign-in request has expired. Please try again.' });
  }
  return new NativeAuthError('IDP_TOKEN_INVALID', { message: 'The sign-in could not be verified.', data: { reason: classified.reason } });
}

/** `true` or `"true"` (Apple sends strings for booleans). */
function truthyClaim(value) {
  return value === true || value === 'true';
}

module.exports = {
  IDP_REASONS,
  UNAVAILABLE_REASONS,
  JWKS_TIMEOUT_MS,
  MAX_TOKEN_LENGTH,
  JwksUnavailableError,
  IdpRejection,
  fetchJwks,
  remoteJwks,
  resetRemoteJwks,
  assertTokenShape,
  classifyJoseError,
  toNativeError,
  truthyClaim,
};
