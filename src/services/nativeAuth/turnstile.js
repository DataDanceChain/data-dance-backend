/**
 * Cloudflare Turnstile, verified server-side (design §3.3, F8/F9).
 *
 * The client renders the widget with the public site key from GET /config and sends the token it
 * gets; the server redeems it at Cloudflare's siteverify endpoint with the secret and the client
 * IP (`remoteip`, the address Express resolved behind `trust proxy`, §3.9). A token is
 * single use at Cloudflare, so a request verifies its token at most once and every check in that
 * request reuses the answer.
 *
 * DDC_AUTH_TURNSTILE_MODE:
 *   off     — never called (no secret configured; local/test only, boot refuses it in prod)
 *   log     — tokens that are present are verified; a failure is logged, not enforced — except on
 *             the slow paths (per-email volume, cross-challenge failures), which always require a
 *             passing token
 *   enforce — every /email/start needs a passing token
 *
 * No exemption is ever derived from a client-claimed platform (F9). Local development uses
 * Cloudflare's published test keys (secret 1x…AA always passes, 2x…AA always fails, 3x…AA
 * answers "already spent"; the widget's test site keys hand out XXXX.DUMMY.TOKEN.XXXX).
 */
const crypto = require('crypto');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('nativeAuth');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5000;
const MAX_TOKEN_LENGTH = 2048;

/** A shape check before anything is sent to Cloudflare. */
function plausibleToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(token);
}

/**
 * Redeem one token. Returns { success, errorCodes, unavailable }: `unavailable` means Cloudflare
 * could not be asked (network, timeout, non-JSON answer); the caller fails closed. Never throws,
 * never logs the token or the secret.
 */
async function verifyTurnstileToken({ token, remoteip, secret, fetchImpl = globalThis.fetch, timeoutMs = VERIFY_TIMEOUT_MS }) {
  if (!plausibleToken(token)) return { success: false, errorCodes: ['invalid-input-response'], unavailable: false };
  if (!secret) return { success: false, errorCodes: ['missing-input-secret'], unavailable: true };
  const body = new URLSearchParams({ secret, response: token, idempotency_key: crypto.randomUUID() });
  if (remoteip) body.set('remoteip', remoteip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    const json = await res.json();
    const errorCodes = Array.isArray(json && json['error-codes']) ? json['error-codes'].map(String).slice(0, 8) : [];
    return { success: json && json.success === true, errorCodes, unavailable: false };
  } catch (err) {
    return { success: false, errorCodes: [err && err.name === 'AbortError' ? 'timeout' : 'network'], unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The per-request Turnstile answer, computed lazily and at most once.
 *   const ts = turnstileCheck({ cfg, token, remoteip });
 *   await ts.passed()   → true only when a token was present and Cloudflare accepted it
 *   ts.present          → a token was sent
 *   ts.mode             → the configured mode
 */
function turnstileCheck({ cfg, token, remoteip, fetchImpl, context = 'email' }) {
  const mode = cfg.turnstile.mode;
  let pending = null;
  return {
    mode,
    present: plausibleToken(token),
    async passed() {
      if (mode === 'off' || !plausibleToken(token)) return false;
      if (!pending) {
        pending = verifyTurnstileToken({ token, remoteip, secret: cfg.turnstile.secret, fetchImpl }).then((result) => {
          if (!result.success) {
            const log = result.unavailable ? logger.error.bind(logger) : logger.warn.bind(logger);
            log('native_auth.turnstile_failed', { context, mode, errorCodes: result.errorCodes, unavailable: result.unavailable });
          }
          return result.success;
        });
      }
      return pending;
    },
  };
}

module.exports = {
  SITEVERIFY_URL,
  VERIFY_TIMEOUT_MS,
  plausibleToken,
  verifyTurnstileToken,
  turnstileCheck,
};
