/**
 * Single-use, short-lived server state for native login (table AuthFlowState): IdP nonces,
 * X OAuth state, X hand-offs, step-up challenges.
 *
 * The client holds the value; the row holds only valueHash = HMAC(stateKey('flow:<kind>'), value),
 * so a database read never yields a usable nonce, state or hand-off. Consumption is one atomic
 * conditional update (unconsumed AND unexpired → consumedAt = now); of two concurrent consumers
 * exactly one gets the row, the other gets null. Expired and consumed rows are purged by
 * scripts/cleanupSso.js after 24 h.
 */
const crypto = require('crypto');
const { readNativeAuthConfig, stateHmac } = require('./config');

const FLOW_KINDS = Object.freeze(['idp_nonce', 'x_oauth', 'x_handoff', 'step_up']);
const IDP_NONCE_PURPOSES = Object.freeze(['google', 'apple']);
const IDP_NONCE_TTL_SEC = 300;

function defaultDb() {
  return require('../../utils/prisma');
}

function assertKind(kind) {
  if (!FLOW_KINDS.includes(kind)) throw new Error(`unknown flow state kind "${kind}"`);
}

/** 32 random bytes, base64url (43 characters). */
function randomValue(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function valueHashFor(kind, value, cfg) {
  return stateHmac(`flow:${kind}`, value, cfg);
}

/**
 * Store one flow state. `value` (optional) is the client-held secret it will be looked up by;
 * `data` is JSON (never put a raw secret in it — seal it first). Returns the created row.
 */
async function createFlowState({ kind, value, data = {}, ttlSec, now = new Date(), db = defaultDb(), cfg = readNativeAuthConfig() }) {
  assertKind(kind);
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) throw new Error('ttlSec is required');
  return db.authFlowState.create({
    data: {
      kind,
      valueHash: value === undefined || value === null ? null : valueHashFor(kind, value, cfg),
      data,
      expiresAt: new Date(now.getTime() + ttlSec * 1000),
    },
  });
}

async function claim(where, now, db) {
  const { count } = await db.authFlowState.updateMany({
    where: { ...where, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  return count === 1;
}

/** Consume the live state of `kind` whose client value is `value`. Returns the row or null. */
async function consumeFlowState({ kind, value, now = new Date(), db = defaultDb(), cfg = readNativeAuthConfig() }) {
  assertKind(kind);
  if (typeof value !== 'string' || !value || value.length > 512) return null;
  const valueHash = valueHashFor(kind, value, cfg);
  if (!(await claim({ kind, valueHash }, now, db))) return null;
  return db.authFlowState.findUnique({ where: { valueHash } });
}

/** Consume the live state of `kind` by row id (states that carry no client value, e.g. step-up). */
async function consumeFlowStateById({ kind, id, now = new Date(), db = defaultDb() }) {
  assertKind(kind);
  if (typeof id !== 'string' || !id || id.length > 64) return null;
  if (!(await claim({ kind, id }, now, db))) return null;
  return db.authFlowState.findUnique({ where: { id } });
}

/**
 * POST /nonce (§2.5). The raw nonce goes back to the client, which hands the IdP its sha256 hex
 * and later submits the IdP token with the raw value. Stored as a hash of `<purpose>:<raw>`, so a
 * Google nonce can never satisfy an Apple token.
 */
async function issueIdpNonce({ purpose, now = new Date(), db = defaultDb(), cfg = readNativeAuthConfig() }) {
  if (!IDP_NONCE_PURPOSES.includes(purpose)) throw new Error(`unknown nonce purpose "${purpose}"`);
  const nonce = randomValue(32);
  await createFlowState({ kind: 'idp_nonce', value: `${purpose}:${nonce}`, data: { purpose }, ttlSec: IDP_NONCE_TTL_SEC, now, db, cfg });
  return { nonce, nonceSha256: sha256Hex(nonce), expiresInSec: IDP_NONCE_TTL_SEC };
}

/**
 * The IdP token's `nonce` claim must equal sha256hex(rawNonce), and the raw nonce must be a live,
 * unconsumed nonce issued for `purpose`; it is consumed here (single use). Returns true only when
 * both hold. A mismatch does not consume the nonce.
 */
async function consumeIdpNonce({ purpose, rawNonce, tokenNonce, now = new Date(), db = defaultDb(), cfg = readNativeAuthConfig() }) {
  if (!IDP_NONCE_PURPOSES.includes(purpose)) return false;
  if (typeof rawNonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawNonce)) return false;
  if (typeof tokenNonce !== 'string' || tokenNonce.length !== 64) return false;
  const expected = Buffer.from(sha256Hex(rawNonce), 'utf8');
  const presented = Buffer.from(tokenNonce.toLowerCase(), 'utf8');
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) return false;
  const row = await consumeFlowState({ kind: 'idp_nonce', value: `${purpose}:${rawNonce}`, now, db, cfg });
  return Boolean(row);
}

module.exports = {
  FLOW_KINDS,
  IDP_NONCE_PURPOSES,
  IDP_NONCE_TTL_SEC,
  randomValue,
  sha256Hex,
  createFlowState,
  consumeFlowState,
  consumeFlowStateById,
  issueIdpNonce,
  consumeIdpNonce,
};
