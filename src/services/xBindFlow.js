/**
 * Server-side state for the "bind X account" OAuth 2.0 flow (decision 46, option B).
 *
 * The old flow kept `state -> { userId, codeVerifier }` in a Map and wrote `User.xid` in the
 * callback, which X calls in whatever browser finished the authorization. Nothing tied that browser
 * to the DDC user who started the flow, so an attacker could mail someone the authorization link
 * from their own flow (the victim's X account ends up on the attacker's DDC account), or the
 * callback URL of their own authorization (an X account bound without the opener asking for it).
 *
 * The flow now has two server-side records, both single-use and short-lived:
 *
 *   1. FLOW (`state`, 10 min). Created by `GET /api/x/oauth2/authorize-url` for the bearer user.
 *      Holds the PKCE verifier, the platform the return URL is chosen from, and the sha256 of a
 *      `bindingSecret` that is returned ONLY in that XHR response (never in a URL), so it stays in
 *      the initiating Wallet session. Consumed by the X callback, valid or not.
 *   2. PENDING BIND (`handle`, 5 min). Created by the callback after the code exchange; holds the
 *      X profile and tokens. Nothing is written to `User` yet. The browser is sent back to the
 *      Wallet with the handle, and `POST /api/x/oauth2/complete` binds only when the bearer user
 *      IS the initiator AND presents the initiator's `bindingSecret`. Consumed on the first
 *      attempt, valid or not, so a handle that reached the wrong session is gone.
 *
 * `state`, `handle` and `bindingSecret` are 32 random bytes (base64url, 43 chars). Only the
 * secret's hash is kept. Nothing here is logged.
 *
 * In-memory, like the store it replaces: the API runs as one process. A restart drops open flows
 * and the user simply starts again. Expired records are swept on every write, and the number of
 * open records per user and in total is capped, so the maps cannot grow without bound.
 */
const crypto = require('crypto');

const FLOW_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_OPEN_PER_USER = 5;
const MAX_OPEN_TOTAL = 10000;

const PLATFORMS = ['web', 'ios', 'android'];
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const flows = new Map();
const pending = new Map();

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function isToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function sweep(map, now) {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}

/** Keep at most `max - 1` records for this user (oldest first out), then make room overall. */
function makeRoom(map, userId, now) {
  sweep(map, now);
  const mine = [...map].filter(([, entry]) => entry.userId === userId);
  for (const [key] of mine.slice(0, Math.max(0, mine.length - (MAX_OPEN_PER_USER - 1)))) {
    map.delete(key);
  }
  while (map.size >= MAX_OPEN_TOTAL) {
    map.delete(map.keys().next().value);
  }
}

/** Take a record out of the map whatever its state: one look per key, ever. */
function take(map, key, now) {
  if (!isToken(key)) return null;
  const entry = map.get(key);
  map.delete(key);
  if (!entry || entry.expiresAt <= now) return null;
  return entry;
}

/** `web` when absent; null when present but not one of PLATFORMS. */
function normalizePlatform(value) {
  if (value === undefined || value === null || value === '') return 'web';
  return typeof value === 'string' && PLATFORMS.includes(value) ? value : null;
}

/**
 * Start a flow for `userId`. Returns the values for the X authorization URL (`state`,
 * `codeChallenge`) and the `bindingSecret` for the initiating session.
 */
function createFlow({ userId, platform = 'web', now = Date.now() }) {
  if (!userId) throw new Error('userId is required');
  const state = randomToken();
  const codeVerifier = randomToken();
  const codeChallenge = sha256(codeVerifier).toString('base64url');
  const bindingSecret = randomToken();
  makeRoom(flows, userId, now);
  flows.set(state, {
    userId,
    platform,
    codeVerifier,
    bindingHash: sha256(bindingSecret),
    expiresAt: now + FLOW_TTL_MS,
  });
  return { state, codeChallenge, bindingSecret, expiresIn: FLOW_TTL_MS / 1000 };
}

/** The flow for `state` (deleted on read), or null when missing, malformed, used or expired. */
function consumeFlow(state, now = Date.now()) {
  return take(flows, state, now);
}

/** Park the result of a completed X authorization until the initiator confirms it. */
function createPendingBind({ flow, xUser, accessToken, refreshToken, now = Date.now() }) {
  const handle = randomToken();
  makeRoom(pending, flow.userId, now);
  pending.set(handle, {
    userId: flow.userId,
    bindingHash: flow.bindingHash,
    xUser: { id: xUser.id, username: xUser.username },
    accessToken,
    refreshToken,
    expiresAt: now + PENDING_TTL_MS,
  });
  return handle;
}

/**
 * Consume the pending bind for `handle` and check it belongs to this session.
 * Returns `{ ok: true, bind }`, or `{ ok: false, reason }` with reason `invalid` (missing,
 * malformed, used or expired handle) or `not_initiator` (another user, or the initiator's user
 * without the initiator's binding secret).
 */
function consumePendingBind({ handle, userId, bindingSecret, now = Date.now() }) {
  const bind = take(pending, handle, now);
  if (!bind) return { ok: false, reason: 'invalid' };
  const secretOk = isToken(bindingSecret) && crypto.timingSafeEqual(sha256(bindingSecret), bind.bindingHash);
  if (!secretOk || !userId || bind.userId !== userId) {
    return { ok: false, reason: 'not_initiator', initiatorUserId: bind.userId };
  }
  return { ok: true, bind };
}

function appOrigin(env) {
  return String(env.APP_PUBLIC_URL || env.FRONTEND_URL || 'https://app.datadance.ai').trim().replace(/\/+$/, '');
}

/**
 * Where the browser goes after the callback. Only configuration decides it (never the request),
 * so the callback cannot be turned into an open redirect. The App defaults are the custom schemes
 * the Wallet App registers (iOS `datadance`, Android `ai.datadance.app`); its `appUrlOpen`
 * handler routes `<scheme>://localhost/user/my?...` to the Me page.
 */
function returnUrlFor(platform, env = process.env) {
  const configured = {
    web: env.X_BIND_RETURN_URL_WEB,
    ios: env.X_BIND_RETURN_URL_IOS,
    android: env.X_BIND_RETURN_URL_ANDROID,
  };
  const defaults = {
    web: `${appOrigin(env)}/user/my`,
    ios: 'datadance://localhost/user/my',
    android: 'ai.datadance.app://localhost/user/my',
  };
  const key = PLATFORMS.includes(platform) ? platform : 'web';
  // A malformed value must not turn the callback into an unhandled throw: fall back to the
  // platform default, then to the production Wallet page.
  for (const candidate of [configured[key], defaults[key], LAST_RESORT_RETURN_URL]) {
    const value = String(candidate || '').trim();
    if (value && isAbsoluteUrl(value)) return value;
  }
  return LAST_RESORT_RETURN_URL;
}

const LAST_RESORT_RETURN_URL = 'https://app.datadance.ai/user/my';

function isAbsoluteUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** `base` plus `params`, keeping any query `base` already has. */
function withParams(base, params) {
  const url = new URL(base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

function _reset() {
  flows.clear();
  pending.clear();
}

function _sizes() {
  return { flows: flows.size, pending: pending.size };
}

module.exports = {
  FLOW_TTL_MS,
  PENDING_TTL_MS,
  MAX_OPEN_PER_USER,
  PLATFORMS,
  normalizePlatform,
  createFlow,
  consumeFlow,
  createPendingBind,
  consumePendingBind,
  returnUrlFor,
  withParams,
  _reset,
  _sizes,
};
