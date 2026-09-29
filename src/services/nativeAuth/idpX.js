/**
 * Native X login (design §2.1 rows 7–9, §2.6, §3.5; F6, F12, D11). Our backend is the X OAuth 2.0
 * confidential client and runs PKCE itself; the client never sees an X code or token.
 *
 *   GET /x/start    ?platform&challenge&intent&locale
 *                   → AuthFlowState x_oauth (10 min) holding {platform, clientChallenge, intent,
 *                     cookieHash}; cookie __Host-ddc_xlogin (Secure, HttpOnly, SameSite=Lax, Path=/,
 *                     10 min); 302 to X with code_challenge = S256(code_verifier), where
 *                     code_verifier = b64url(HMAC(stateKey('x-pkce'), state)) is never stored.
 *   GET /x/callback ?code&state | ?error
 *                   → consume the state (single use), require sha256(cookie) = cookieHash (login
 *                     CSRF), exchange the code at X with the recomputed verifier and our callback
 *                     URL, read the user (users.read), identify, then store an x_handoff (60 s)
 *                     and 302 to the platform's return URL `#handoff=<v>&provider=x`; failures go
 *                     back as `#error=x_denied|x_failed|state_invalid&provider=x`. X tokens are
 *                     discarded.
 *   POST /x/exchange {handoff, verifier}
 *                   → consume the hand-off (single use), require b64url(sha256(verifier)) =
 *                     clientChallenge, unseal and answer `Identified`.
 *
 * Identity = the X user id (users/me `id`). Nothing else identifies: User.xid is never read here
 * and X never auto-links (accounts.js, F12); the handle, name and avatar are display only.
 *
 * The hand-off row never holds a usable secret: the `Identified` body (loginSecret and the
 * Web3Auth JWT included) is sealed with AES-256-GCM under HMAC(stateKey('x-handoff-seal'),
 * handoff), so a database read — even together with the state secret — does not open it without
 * the hand-off value, which exists only in the client's URL fragment. The row itself is looked up
 * by HMAC (flowState).
 *
 * Return URLs come only from configuration, never from the request (F6): web →
 * DDC_AUTH_X_WEB_RETURN_URL; ios/android → DDC_AUTH_X_APP_RETURN_URL, which must be a verified
 * https app link everywhere but DDC_AUTH_ENV=local (the only place a custom scheme is legal). X
 * only ever calls back to our API (DDC_AUTH_X_CALLBACK_URL).
 *
 * Never logged: code, state, cookie, hand-off, verifier, X tokens, the X user id.
 */
const crypto = require('crypto');
const xService = require('../xService');
const { readNativeAuthConfig, stateKey, PLATFORMS, logger } = require('./config');
const { createFlowState, consumeFlowState, randomValue, sha256Hex } = require('./flowState');
const { NativeAuthError, NATIVE_ERROR_CODES } = require('../../controllers/nativeAuth/respond');

const COOKIE_NAME = '__Host-ddc_xlogin';
const START_TTL_SEC = 600;
const HANDOFF_TTL_SEC = 60;
const X_HTTP_TIMEOUT_MS = 10000;
const X_INTENTS = Object.freeze(['login', 'link']);
const FRAGMENT_ERRORS = Object.freeze(['x_denied', 'x_failed', 'state_invalid']);
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,2}$/;
const X_USER_ID_PATTERN = /^[0-9]{1,20}$/;
const SEAL_VERSION = 1;
const SEAL_AAD = Buffer.from('ddc-native-auth:x-handoff:v1', 'utf8');

function defaultDb() {
  return require('../../utils/prisma');
}

/** Thrown for a request we answer without going to X (the controller maps it). */
class XLoginError extends Error {
  constructor(kind, { platform, reason } = {}) {
    super(`x login: ${kind}`);
    this.name = 'XLoginError';
    this.kind = kind; // 'platform' | 'request' | 'misconfigured'
    this.platform = platform;
    this.reason = reason;
  }
}

function b64urlSha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

/** The PKCE code_verifier for an X state: derived, never stored (43 base64url characters). */
function pkceVerifier(state, cfg) {
  return crypto.createHmac('sha256', stateKey('x-pkce', cfg)).update(String(state)).digest('base64url');
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

/**
 * The configured return URL for `platform`, without any fragment. Throws XLoginError
 * 'misconfigured' when it is missing or not allowed where we run:
 *   - https always;
 *   - http only for a loopback host with DDC_AUTH_ENV=local|test;
 *   - a custom scheme only for ios/android with DDC_AUTH_ENV=local (F6; boot rule 5 refuses it
 *     elsewhere, this re-checks at run time).
 */
function returnUrlFor(platform, cfg) {
  if (!PLATFORMS.includes(platform)) throw new XLoginError('misconfigured', { platform, reason: 'platform' });
  const configured = platform === 'web' ? cfg.x.webReturnUrl : cfg.x.appReturnUrl;
  if (!configured) throw new XLoginError('misconfigured', { platform, reason: 'return_url_missing' });
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new XLoginError('misconfigured', { platform, reason: 'return_url_invalid' });
  }
  const relaxed = cfg.env === 'local' || cfg.env === 'test';
  let allowed = false;
  if (url.protocol === 'https:') allowed = true;
  else if (url.protocol === 'http:') allowed = relaxed && isLoopbackHost(url.hostname);
  else allowed = platform !== 'web' && cfg.env === 'local' && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'data:', 'file:', 'blob:'].includes(url.protocol);
  if (!allowed) throw new XLoginError('misconfigured', { platform, reason: 'return_url_refused' });
  url.hash = '';
  return url.toString().replace(/#$/, '');
}

function withFragment(base, params) {
  return `${base}#${new URLSearchParams(params).toString()}`;
}

function errorRedirect(error, platform, cfg) {
  if (!FRAGMENT_ERRORS.includes(error)) throw new Error(`unknown fragment error "${error}"`);
  return withFragment(returnUrlFor(platform, cfg), { error, provider: 'x' });
}

function platformEnabled(platform, cfg) {
  return PLATFORMS.includes(platform) && cfg.platforms.includes(platform);
}

// ---------------------------------------------------------------------------------------------
// Sealing the hand-off payload
// ---------------------------------------------------------------------------------------------

function sealKey(handoff, cfg) {
  return crypto.createHmac('sha256', stateKey('x-handoff-seal', cfg)).update(String(handoff)).digest();
}

function seal(payload, handoff, cfg) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(handoff, cfg), iv);
  cipher.setAAD(SEAL_AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { v: SEAL_VERSION, iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

/** Returns the payload, or null when the box does not open with this hand-off. */
function unseal(box, handoff, cfg) {
  if (!box || box.v !== SEAL_VERSION || typeof box.iv !== 'string' || typeof box.ct !== 'string' || typeof box.tag !== 'string') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(handoff, cfg), Buffer.from(box.iv, 'base64url'));
    decipher.setAAD(SEAL_AAD);
    decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
    const text = Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64url')), decipher.final()]).toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// GET /x/start
// ---------------------------------------------------------------------------------------------

/**
 * Validates the start request and prepares the X redirect. Returns
 * { redirectUrl, cookie: { name, value, maxAgeSec } }.
 * Throws XLoginError: 'platform' (unknown or disabled platform), 'request' (bad challenge, intent
 * or locale; carries the platform so the caller can bounce to its return URL), 'misconfigured'.
 */
async function startXLogin({ query = {}, cfg = readNativeAuthConfig(), db = defaultDb(), now = new Date() } = {}) {
  const platform = typeof query.platform === 'string' ? query.platform : '';
  if (!platformEnabled(platform, cfg)) throw new XLoginError('platform', { platform, reason: 'platform' });
  returnUrlFor(platform, cfg); // a misconfigured return URL fails before anything is stored

  const challenge = query.challenge;
  const intent = query.intent === undefined || query.intent === '' ? 'login' : query.intent;
  const locale = typeof query.locale === 'string' ? query.locale : '';
  if (typeof challenge !== 'string' || !B64URL_43.test(challenge)) throw new XLoginError('request', { platform, reason: 'challenge' });
  if (!X_INTENTS.includes(intent)) throw new XLoginError('request', { platform, reason: 'intent' });
  if (locale && !LOCALE_PATTERN.test(locale)) throw new XLoginError('request', { platform, reason: 'locale' });
  if (!String(process.env.X_CLIENT_ID || '').trim() || !String(process.env.X_CLIENT_SECRET || '').trim()) {
    throw new XLoginError('misconfigured', { platform, reason: 'client' });
  }
  if (!cfg.x.callbackUrl) throw new XLoginError('misconfigured', { platform, reason: 'callback_url' });

  const state = randomValue(32);
  // The cookie names its platform so a callback whose state is gone can still bounce the user to
  // the right return URL; it chooses only between configured URLs, so it needs no trust.
  const cookieValue = `${platform}.${randomValue(32)}`;
  await createFlowState({
    kind: 'x_oauth',
    value: state,
    data: { platform, clientChallenge: challenge, intent, locale: locale || null, cookieHash: sha256Hex(cookieValue) },
    ttlSec: START_TTL_SEC,
    now,
    db,
    cfg,
  });
  const redirectUrl = xService.buildLoginAuthorizeUrl({
    redirectUri: cfg.x.callbackUrl,
    state,
    codeChallenge: b64urlSha256(pkceVerifier(state, cfg)),
  });
  return { redirectUrl, cookie: { name: COOKIE_NAME, value: cookieValue, maxAgeSec: START_TTL_SEC } };
}

// ---------------------------------------------------------------------------------------------
// GET /x/callback
// ---------------------------------------------------------------------------------------------

function cookiePlatform(cookieValue, cfg) {
  const match = typeof cookieValue === 'string' ? /^(web|ios|android)\./.exec(cookieValue) : null;
  return match && platformEnabled(match[1], cfg) ? match[1] : null;
}

/** Where an error goes when the state (and so the platform) is not known. */
function fallbackErrorRedirect(error, cookieValue, cfg) {
  const candidates = [cookiePlatform(cookieValue, cfg), 'web', 'ios', 'android'].filter((p) => p && platformEnabled(p, cfg));
  for (const platform of candidates) {
    try {
      return errorRedirect(error, platform, cfg);
    } catch {
      // try the next configured platform
    }
  }
  throw new XLoginError('misconfigured', { reason: 'no_return_url' });
}

function callbackFailure(reason, extra = {}) {
  logger.warn('native_auth.x_callback_error', { reason, ...extra });
}

/** users/me → the identity accounts.js expects (provider x, subject = X user id). */
function xIdentity(user) {
  if (!user || typeof user !== 'object' || typeof user.id !== 'string' || !X_USER_ID_PATTERN.test(user.id)) return null;
  const profile = {};
  if (typeof user.username === 'string' && /^[A-Za-z0-9_]{1,50}$/.test(user.username)) profile.xUsername = user.username;
  if (typeof user.name === 'string' && user.name.trim()) profile.name = user.name;
  if (typeof user.profile_image_url === 'string' && /^https:\/\//i.test(user.profile_image_url)) profile.avatar = user.profile_image_url;
  return { provider: 'x', subject: user.id, profile };
}

/**
 * Handles X's redirect. Always resolves to { redirectUrl } (a return URL with a fragment); throws
 * only XLoginError 'misconfigured' (no usable return URL) or an unexpected (database) error.
 *
 * @param identify the identify module (createLoginAttempt); injectable for tests
 * @param x        the xService module; injectable for tests
 */
async function handleXCallback({ query = {}, cookieValue, req, cfg = readNativeAuthConfig(), db = defaultDb(), now = new Date(), identify = require('./identify'), x = xService } = {}) {
  const state = typeof query.state === 'string' && query.state.length <= 512 ? query.state : '';
  const row = state ? await consumeFlowState({ kind: 'x_oauth', value: state, now, db, cfg }) : null;
  if (!row) {
    callbackFailure(state ? 'state_unknown' : 'state_missing');
    return { redirectUrl: fallbackErrorRedirect('state_invalid', cookieValue, cfg) };
  }
  const data = row.data || {};
  const platform = data.platform;
  if (!platformEnabled(platform, cfg)) {
    callbackFailure('platform_disabled');
    return { redirectUrl: fallbackErrorRedirect('state_invalid', cookieValue, cfg) };
  }
  const fail = (error, reason, extra) => {
    callbackFailure(reason, extra);
    return { redirectUrl: errorRedirect(error, platform, cfg) };
  };

  // Login CSRF: the browser that finishes must be the browser that started.
  if (typeof cookieValue !== 'string' || !constantTimeEqual(sha256Hex(cookieValue), String(data.cookieHash || ''))) {
    return fail('state_invalid', 'cookie_mismatch');
  }
  if (query.error !== undefined) {
    return query.error === 'access_denied' ? fail('x_denied', 'denied') : fail('x_failed', 'x_error');
  }
  if (typeof query.code !== 'string' || !query.code || query.code.length > 2048) return fail('x_failed', 'code_missing');

  const apiBase = x.loginApiBase();
  let accessToken;
  try {
    const tokens = await x.exchangeCodeForToken(query.code, pkceVerifier(state, cfg), cfg.x.callbackUrl, { timeout: X_HTTP_TIMEOUT_MS, apiBase });
    accessToken = tokens && tokens.access_token;
  } catch (err) {
    return fail('x_failed', 'token_exchange', { status: err && err.response ? err.response.status : undefined });
  }
  if (typeof accessToken !== 'string' || !accessToken) return fail('x_failed', 'token_exchange');

  let identity;
  try {
    identity = xIdentity(await x.getOAuth2UserInfo(accessToken, { timeout: X_HTTP_TIMEOUT_MS, apiBase, userFields: 'profile_image_url' }));
  } catch (err) {
    return fail('x_failed', 'user_lookup', { status: err && err.response ? err.response.status : undefined });
  }
  accessToken = null; // X tokens are discarded: never stored, never returned, never logged.
  if (!identity) return fail('x_failed', 'user_invalid');
  logger.info('native_auth.idp_verified', { provider: 'x', intent: data.intent });

  let payload;
  if (data.intent === 'link') {
    // The signed-in user is only known at /x/exchange (bearer); the attempt is created there.
    payload = { identity };
  } else {
    try {
      payload = { identified: await identify.createLoginAttempt({ identity, intent: 'login', method: 'x', req, db, cfg, now }) };
    } catch (err) {
      if (!(err instanceof NativeAuthError) || !Object.prototype.hasOwnProperty.call(NATIVE_ERROR_CODES, err.code)) {
        logger.error('native_auth.x_callback_error', { reason: 'identify', error: err && err.name });
        return { redirectUrl: errorRedirect('x_failed', platform, cfg) };
      }
      // Account refusals (NEW_ACCOUNTS_CLOSED, ACCOUNT_DISABLED, …) travel through the hand-off so
      // /x/exchange can answer them with their contract code; the fragment set stays closed.
      payload = { error: { code: err.code, message: err.message, ...(err.data !== undefined && { data: err.data }) } };
    }
  }

  const handoff = randomValue(32);
  await createFlowState({
    kind: 'x_handoff',
    value: handoff,
    data: { clientChallenge: data.clientChallenge, intent: data.intent, sealed: seal(payload, handoff, cfg) },
    ttlSec: HANDOFF_TTL_SEC,
    now,
    db,
    cfg,
  });
  return { redirectUrl: withFragment(returnUrlFor(platform, cfg), { handoff, provider: 'x' }) };
}

// ---------------------------------------------------------------------------------------------
// POST /x/exchange
// ---------------------------------------------------------------------------------------------

function handoffInvalid() {
  return new NativeAuthError('X_HANDOFF_INVALID', { message: 'This X sign-in has expired. Please try again.' });
}

/**
 * Redeems a hand-off. Single use: the row is consumed before the verifier is compared, so a
 * wrong verifier burns it. Returns { intent, identified } (login), { intent, identity } (link),
 * or throws the NativeAuthError recorded at the callback, or X_HANDOFF_INVALID.
 */
async function redeemXHandoff({ handoff, verifier, cfg = readNativeAuthConfig(), db = defaultDb(), now = new Date() } = {}) {
  if (typeof handoff !== 'string' || !B64URL_43.test(handoff)) throw handoffInvalid();
  if (typeof verifier !== 'string' || !B64URL_43.test(verifier)) throw handoffInvalid();
  const row = await consumeFlowState({ kind: 'x_handoff', value: handoff, now, db, cfg });
  if (!row) throw handoffInvalid();
  const data = row.data || {};
  if (!constantTimeEqual(b64urlSha256(verifier), String(data.clientChallenge || ''))) throw handoffInvalid();
  const payload = unseal(data.sealed, handoff, cfg);
  if (!payload) throw handoffInvalid();
  if (payload.error) {
    const { code, message, data: errorData } = payload.error;
    if (!Object.prototype.hasOwnProperty.call(NATIVE_ERROR_CODES, code)) throw handoffInvalid();
    throw new NativeAuthError(code, { message, ...(errorData !== undefined && { data: errorData }) });
  }
  if (data.intent === 'link') {
    if (!payload.identity) throw handoffInvalid();
    return { intent: 'link', identity: payload.identity };
  }
  if (!payload.identified) throw handoffInvalid();
  return { intent: 'login', identified: payload.identified };
}

module.exports = {
  COOKIE_NAME,
  START_TTL_SEC,
  HANDOFF_TTL_SEC,
  X_INTENTS,
  FRAGMENT_ERRORS,
  XLoginError,
  pkceVerifier,
  b64urlSha256,
  returnUrlFor,
  errorRedirect,
  fallbackErrorRedirect,
  xIdentity,
  startXLogin,
  handleXCallback,
  redeemXHandoff,
};
