/**
 * The confirmation token of the two-step partner bind (Sloan, 2026-09-28, item 35):
 *
 *   "Inside the App the extra DDC Continue page is odd and redundant. The bind scope may be
 *    auto-approved; the partner must show its own second confirmation before binding, and our
 *    backend enforces a programmatic second confirmation."
 *
 * POST /partner/tge/referral/bind/check issues it; POST /partner/tge/referral/bind requires it.
 * A token says "DataDance checked THIS code for THIS user of THIS client and found it bindable".
 * It is stateless — nothing is stored — and HMAC-SHA256 signed:
 *
 *   rbc1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(key, "rbc1." + payload))>
 *   payload = { c: client id, s: user id (token sub), h: sha256 of the normalised code,
 *               iat: issued-at (ms), exp: expiry (ms), n: 96-bit random nonce }
 *
 * Key: derived from SSO_SESSION_SECRET (HMAC-SHA256 over a fixed label, so it is never the session
 * key itself and a token of one kind can never verify as the other). No new variable: the boot
 * check (assertPartnerConfig) already refuses SSO_TGE_ENABLED=true without SSO_SESSION_SECRET, and
 * the partner API does not serve without SSO_TGE_ENABLED. Rotating that secret invalidates every
 * outstanding confirmation, which costs a partner at most one extra /check.
 *
 * Lifetime 120 s. A token younger than 1 s is refused as well: the check and the bind must be two
 * separate steps with the user's own tap between them (the partner's "确认使用邀请码 …？" dialog),
 * not one scripted call chained to the other.
 *
 * Replay: a valid token may be used again until it expires. That is harmless — the bind is
 * idempotent (same code again → 200 already:true) and never replaces an inviter, so a token for a
 * code other than the one the user ended up bound to is refused by the bind (409 already_referred).
 * So no server-side nonce store is needed; the nonce only makes every token unique.
 */
const crypto = require('crypto');

const CONFIRM_TOKEN_PREFIX = 'rbc1';
const CONFIRM_TTL_MS = 120 * 1000;
const CONFIRM_MIN_AGE_MS = 1000;
const KEY_LABEL = 'ddc:partner-referral-bind-confirm:v1';
const MAX_TOKEN_LENGTH = 1024;

/** Replaceable for tests (fake clock): every issue and verify reads the time through here. */
const clock = { now: () => Date.now() };

function signingKey() {
  const secret = String(process.env.SSO_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SSO_SESSION_SECRET is not configured');
  return crypto.createHmac('sha256', secret).update(KEY_LABEL).digest();
}

/**
 * Compares codes the way the lookup does (findUserByReferralCode): case, spaces and hyphens do
 * not matter. The route passes the OWNER's stored code when there is one, so a legacy code, its
 * current display code and any later display prefix all confirm the same bind.
 */
function normaliseCode(code) {
  return String(code || '').replace(/[\s-]+/g, '').toUpperCase();
}

function codeHash(code) {
  return crypto.createHash('sha256').update(normaliseCode(code)).digest('base64url');
}

function sign(body) {
  return crypto.createHmac('sha256', signingKey()).update(`${CONFIRM_TOKEN_PREFIX}.${body}`).digest();
}

/** @returns {{ token: string, expiresIn: number }} expiresIn in seconds (120). */
function issueConfirmToken({ clientId, userId, code }) {
  const iat = clock.now();
  const payload = {
    c: String(clientId),
    s: String(userId),
    h: codeHash(code),
    iat,
    exp: iat + CONFIRM_TTL_MS,
    n: crypto.randomBytes(12).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${CONFIRM_TOKEN_PREFIX}.${body}.${sign(body).toString('base64url')}`, expiresIn: CONFIRM_TTL_MS / 1000 };
}

/**
 * @returns {{ ok: true } | { ok: false, reason: 'malformed'|'signature'|'expired'|'too_early'|'client'|'user'|'code' }}
 *   Checks the signature (constant-time) before reading anything the token claims.
 */
function verifyConfirmToken(token, { clientId, userId, code }) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== CONFIRM_TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const [, body, sig] = parts;
  const expected = sign(body);
  const given = Buffer.from(sig, 'base64url');
  // Only the canonical encoding counts: Node's decoder ignores the spare low bits of the last
  // character (and stray characters), so several strings would otherwise decode to one signature.
  if (given.toString('base64url') !== sig) return { ok: false, reason: 'signature' };
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload !== 'object' || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: 'malformed' };
  }
  const now = clock.now();
  if (now >= payload.exp) return { ok: false, reason: 'expired' };
  if (now - payload.iat < CONFIRM_MIN_AGE_MS) return { ok: false, reason: 'too_early' };
  if (payload.c !== String(clientId)) return { ok: false, reason: 'client' };
  if (payload.s !== String(userId)) return { ok: false, reason: 'user' };
  if (payload.h !== codeHash(code)) return { ok: false, reason: 'code' };
  return { ok: true };
}

module.exports = {
  CONFIRM_TOKEN_PREFIX,
  CONFIRM_TTL_MS,
  CONFIRM_MIN_AGE_MS,
  clock,
  normaliseCode,
  issueConfirmToken,
  verifyConfirmToken,
};
