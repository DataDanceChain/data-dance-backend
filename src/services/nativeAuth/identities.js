/**
 * Sign-in methods of the signed-in account: list, link and unlink (design §2.1 #12–15, §3.8;
 * F2, D4, D9). Every route runs behind `protect` (a DDC session) AND a step-up, and every change
 * mails a notice to the account's strong addresses (notify.js).
 *
 * Link:
 *   1. the user proves the new method with `intent: 'link'` + bearer (e-mail verify, Google, Apple,
 *      X exchange) → a link attempt {loginId, loginSecret}; identify mints NOTHING for it;
 *   2. POST /identities/challenge {action: 'link', loginId} → {stepUp, mode};
 *   3. POST /identities/link {loginId, loginSecret, stepUpSignature} → {identity}.
 *   The attempt is verified with complete.loadAttempt({loginId, loginSecret, intent: 'link'}) and
 *   must belong to the bearer; an AuthIdentity (provider, subject) that already exists anywhere is
 *   refused with IDENTITY_ALREADY_LINKED; the row carries the attempt's email, emailLinkGrade and
 *   isPrivateRelay, linkedVia 'manual'.
 *
 * Unlink: POST /identities/challenge {action: 'unlink', identityId}, then
 *   DELETE /identities/:id {stepUpSignature}. The last method is never removed
 *   (IDENTITY_LAST_METHOD), checked again under a per-account advisory lock so two concurrent
 *   unlinks cannot remove the last two.
 *
 * Step-up (§3.8):
 *   - an account with a PROVEN wallet signs an EIP-4361 message (proofMessage.buildProofMessage)
 *     with its CURRENT wallet over a server challenge naming the action and the target; the
 *     challenge is an AuthFlowState 'step_up' row (5 min, single use) keyed by HMAC(user, action,
 *     target), so it is found again without a client-held id and cannot serve another action or
 *     target. A stolen session cannot produce the signature: NODE mode never stores the key (F2).
 *     User.walletAddress alone proves nothing: a session can write it on an account that has none
 *     (PUT /api/users/wallet, POST /api/auth/update-wallet, /wallet/generate|import). The wallet
 *     counts only when a login proved it (provenWallet below); otherwise the account is treated
 *     exactly like an account without a wallet;
 *   - an account without a (proven) wallet: a link attempt (intent 'link', same account, created in the
 *     last 10 minutes) of a method ALREADY linked to the account, sent as
 *     {stepUpLoginId, stepUpLoginSecret} and consumed here; or, for link only, nothing more when
 *     the method being linked is our e-mail OTP for the account's own User.email (that proves the
 *     one thing a password account's owner can prove; F5, rule 3d).
 *
 * F2 / D4: nothing here mints a Web3Auth JWT (issuer is not used), and a link attempt has no
 * subject or wallet proof, so /token and /complete refuse it (loadAttempt intent 'login').
 *
 * Logs: native_auth.identity_linked|unlinked {provider, identityId, stepUp, loginRef?}; never a
 * subject, an address, a secret or a signature.
 */
const crypto = require('crypto');
const { verifyMessage } = require('ethers');
const { readNativeAuthConfig, stateHmac, loginRef: loginRefFor, logger } = require('./config');
const { buildProofMessage, DDC_CHAIN_ID } = require('./proofMessage');
const flowState = require('./flowState');
const accounts = require('./accounts');
const complete = require('./complete');
const notify = require('./notify');
const { NativeAuthError } = require('../../controllers/nativeAuth/respond');
const { maskEmail } = require('../../utils/emailMask');

const ACTIONS = Object.freeze(['link', 'unlink']);
const STEP_UP_TTL_SEC = 300;
const IDENTIFY_STEP_UP_WINDOW_MS = 10 * 60 * 1000;
const MANUAL_LINKED_VIA = 'manual';
/** The methods a user sees and manages. `web3auth_legacy` rows (rebind / migration) are internal. */
const LISTED_PROVIDERS = accounts.PROVIDERS;
const STEP_UP_MODES = Object.freeze({ wallet: 'wallet', identify: 'identify', none: 'none' });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

const PROVIDER_LABELS = Object.freeze({ email: 'e-mail code', google: 'Google', apple: 'Apple', x: 'X' });

// Mirror of web3authIdentity.EXTERNAL_WALLET_VERIFIER (asserted equal in
// test/unit/nativeAuthIdentities.test.js); copied so this module does not load the legacy
// Web3Auth verifier and its boot assertions.
const EXTERNAL_WALLET_VERIFIER = 'external-wallet';

function defaultDb() {
  return require('../../utils/prisma');
}

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isP2002(err) {
  return Boolean(err && err.code === 'P2002');
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

function expired() {
  return new NativeAuthError('LOGIN_EXPIRED', { message: 'This confirmation has expired. Please start again.' });
}

function stepUpRequired(mode) {
  return new NativeAuthError('STEP_UP_REQUIRED', { message: 'Please confirm it is you first.', data: { mode } });
}

function stepUpInvalid(reason) {
  return new NativeAuthError('STEP_UP_INVALID', { message: 'The confirmation could not be verified. Please try again.', data: { reason } });
}

function alreadyLinked() {
  return new NativeAuthError('IDENTITY_ALREADY_LINKED', { message: 'This sign-in method is already linked to an account.' });
}

function lastMethod() {
  return new NativeAuthError('IDENTITY_LAST_METHOD', { message: 'You cannot remove your only sign-in method.' });
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `GET /identities` row: never the subject; the address only masked. */
function identitySummary(row) {
  return {
    id: row.id,
    provider: row.provider,
    emailMasked: row.email ? maskEmail(row.email) : null,
    linkedVia: row.linkedVia,
    createdAt: iso(row.createdAt),
    lastLoginAt: iso(row.lastLoginAt),
  };
}

function isListed(row) {
  return Boolean(row && LISTED_PROVIDERS.includes(row.provider));
}

/** Ways left to sign in to `user` once `excludeId` is gone: listed identities + a password. */
function otherMethodCount(user, rows, excludeId) {
  const identities = rows.filter((row) => isListed(row) && row.id !== excludeId).length;
  return identities + (user && user.password ? 1 : 0);
}

async function listRows(user, db) {
  const rows = await db.authIdentity.findMany({ where: { userId: user.id } });
  return rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** GET /identities */
async function listIdentities({ user, db = defaultDb() }) {
  accounts.guardAccount(user);
  const rows = await listRows(user, db);
  return rows.filter(isListed).map(identitySummary);
}

// ---------------------------------------------------------------------------------------------
// Step-up challenge
// ---------------------------------------------------------------------------------------------

function stepUpValue(userId, action, target) {
  return `${userId}|${action}|${target}`;
}

/** Same derivation as flowState (HMAC(stateKey('flow:step_up'), value)), so consumeFlowState finds it. */
function stepUpHash(value, cfg) {
  return stateHmac('flow:step_up', value, cfg);
}

/** Per-account lock key for identity changes (same account → same key in every process). */
function identityLockKey(userId) {
  return crypto.createHash('sha256').update(`ddc-native-identities:${userId}`).digest().readBigInt64BE(0);
}

function methodName(provider, email) {
  const label = PROVIDER_LABELS[provider] || provider;
  return email ? `${label} (${maskEmail(email)})` : label;
}

function stepUpStatement(action, provider, email) {
  return action === 'link'
    ? `Add ${methodName(provider, email)} as a sign-in method to your DataDance account.`
    : `Remove ${methodName(provider, email)} from the sign-in methods of your DataDance account.`;
}

/** The open link attempt `loginId` of `user` (no secret needed to ask for a challenge). */
async function openLinkAttempt({ user, loginId, db, now }) {
  if (typeof loginId !== 'string' || !UUID_PATTERN.test(loginId)) throw expired();
  const attempt = await db.authLoginAttempt.findUnique({ where: { id: loginId } });
  if (!attempt || attempt.intent !== 'link' || attempt.state !== 'identified' || attempt.userId !== user.id) throw expired();
  if (!(attempt.expiresAt instanceof Date) || attempt.expiresAt.getTime() <= now.getTime()) throw expired();
  if (!LISTED_PROVIDERS.includes(attempt.provider)) throw expired();
  return attempt;
}

/** A listed identity of `user`, else STEP_UP_INVALID {reason: 'identity'} (unknown, foreign or internal). */
async function ownedIdentity({ user, identityId, db }) {
  if (typeof identityId !== 'string' || !identityId || identityId.length > 64) throw stepUpInvalid('identity');
  const row = await db.authIdentity.findUnique({ where: { id: identityId } });
  if (!row || row.userId !== user.id || !isListed(row)) throw stepUpInvalid('identity');
  return row;
}

async function assertNotLinked(attempt, db) {
  const row = await db.authIdentity.findUnique({
    where: { provider_subject: { provider: attempt.provider, subject: attempt.subject } },
  });
  if (row) throw alreadyLinked();
}

/** Link only: our OTP for the account's own address is itself the step-up of a wallet-less account. */
function linkProvesOwnEmail(user, attempt) {
  return Boolean(attempt && attempt.provider === 'email' && notify.isRealEmail(user.email) && lower(user.email) === lower(attempt.email));
}

/**
 * The account's wallet if a LOGIN proved it, else null (F2). User.walletAddress is not enough on
 * its own: the session-only wallet endpoints write it on any account that has none. Proven means:
 *   - native accounts: the NativeWalletBinding of the account holds this address (written only
 *     by complete.js after a verified wallet proof); a binding for another address proves nothing,
 *     and a native-connection pair without a binding proves nothing;
 *   - an external-wallet Web3Auth pair: its verifierId IS the lower-cased address the ID token
 *     proved, so it must be this address;
 *   - a legacy social Web3Auth pair: the address came in through a verified login, unless a
 *     session endpoint wrote it — all of those also write User.chainId, which no login path
 *     does, so a wallet with a chainId is not counted.
 * Every other account (password rows, placeholders) uses the identify / own-e-mail step-up.
 * Looked up at challenge time AND at verify time.
 */
async function provenWallet(user, db, cfg) {
  const address = user && user.walletAddress;
  if (typeof address !== 'string' || !address) return null;
  const binding = await db.nativeWalletBinding.findUnique({ where: { userId: user.id } });
  if (binding) return sameAddress(binding.address, address) ? address : null;
  const verifier = user.web3authVerifier;
  if (!verifier || !user.web3authVerifierId || verifier === cfg.connectionId) return null;
  if (verifier === EXTERNAL_WALLET_VERIFIER) return sameAddress(user.web3authVerifierId, address) ? address : null;
  if (user.chainId !== null && user.chainId !== undefined) return null;
  return address;
}

async function modeFor({ user, action, attempt, db, cfg }) {
  if (await provenWallet(user, db, cfg)) return STEP_UP_MODES.wallet;
  if (action === 'link' && linkProvesOwnEmail(user, attempt)) return STEP_UP_MODES.none;
  return STEP_UP_MODES.identify;
}

/**
 * POST /identities/challenge {action, loginId?, identityId?} → {stepUp, mode}.
 *   mode 'wallet':   stepUp = the EIP-4361 fields the current wallet signs (5 min, single use);
 *   mode 'identify': stepUp = null; send {stepUpLoginId, stepUpLoginSecret} of a fresh link
 *                    attempt of an already-linked method instead of a signature;
 *   mode 'none':     stepUp = null; the link attempt itself is the proof (own e-mail by OTP).
 * Refusals that the final call would give anyway are given here first (already linked, last method).
 */
async function createStepUpChallenge({ user, body = {}, db = defaultDb(), cfg = readNativeAuthConfig(), now = new Date() }) {
  accounts.guardAccount(user);
  const { action } = body;
  if (!ACTIONS.includes(action)) throw stepUpInvalid('action');

  let target;
  let provider;
  let email;
  let attempt = null;
  let requestId;
  if (action === 'link') {
    attempt = await openLinkAttempt({ user, loginId: body.loginId, db, now });
    await assertNotLinked(attempt, db);
    target = attempt.id;
    provider = attempt.provider;
    email = attempt.email;
    requestId = loginRefFor(attempt.id, cfg);
  } else {
    const identity = await ownedIdentity({ user, identityId: body.identityId, db });
    const rows = await listRows(user, db);
    if (otherMethodCount(user, rows, identity.id) === 0) throw lastMethod();
    target = identity.id;
    provider = identity.provider;
    email = identity.email;
    requestId = identity.id;
  }

  const mode = await modeFor({ user, action, attempt, db, cfg });
  if (mode !== STEP_UP_MODES.wallet) return { stepUp: null, mode };

  const expiresAt = new Date(now.getTime() + STEP_UP_TTL_SEC * 1000);
  const proof = {
    domain: cfg.proofDomain,
    uri: cfg.proofUri,
    chainId: DDC_CHAIN_ID,
    statement: stepUpStatement(action, provider, email),
    nonce: crypto.randomBytes(16).toString('hex'),
    issuedAt: now.toISOString(),
    expirationTime: expiresAt.toISOString(),
    requestId,
  };
  // Fail here, not at link time, if the configuration or the account cannot produce a message.
  buildProofMessage(proof, user.walletAddress);

  // One live challenge per (account, action, target): a new request replaces the previous one.
  const value = stepUpValue(user.id, action, target);
  const valueHash = stepUpHash(value, cfg);
  const data = { userId: user.id, action, target, address: user.walletAddress, proof };
  for (let tries = 0; ; tries += 1) {
    try {
      await db.authFlowState.deleteMany({ where: { valueHash } });
      await flowState.createFlowState({ kind: 'step_up', value, data, ttlSec: STEP_UP_TTL_SEC, now, db, cfg });
      break;
    } catch (err) {
      if (!isP2002(err) || tries >= 1) throw err;
    }
  }
  logger.info('native_auth.step_up_issued', { action, provider });
  return { stepUp: proof, mode };
}

// ---------------------------------------------------------------------------------------------
// Step-up verification
// ---------------------------------------------------------------------------------------------

async function verifyWalletStepUp({ user, action, target, body, db, cfg, now }) {
  const signature = body.stepUpSignature;
  if (signature === undefined || signature === null || signature === '') throw stepUpRequired(STEP_UP_MODES.wallet);
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) throw stepUpInvalid('signature');

  const value = stepUpValue(user.id, action, target);
  const row = await db.authFlowState.findUnique({ where: { valueHash: stepUpHash(value, cfg) } });
  if (!row || row.kind !== 'step_up' || row.consumedAt || !(row.expiresAt instanceof Date) || row.expiresAt.getTime() <= now.getTime()) {
    throw stepUpInvalid('challenge');
  }
  const data = row.data || {};
  // The wallet that must sign is the account's wallet now AND when the challenge was issued.
  if (data.userId !== user.id || data.action !== action || data.target !== target || !sameAddress(data.address, user.walletAddress)) {
    throw stepUpInvalid('challenge');
  }
  let recovered;
  try {
    recovered = verifyMessage(buildProofMessage(data.proof, user.walletAddress), signature);
  } catch {
    throw stepUpInvalid('signature');
  }
  if (!sameAddress(recovered, user.walletAddress)) {
    logger.warn('native_auth.step_up_failed', { action, reason: 'wrong_wallet' });
    throw stepUpInvalid('signature');
  }
  const consumed = await flowState.consumeFlowState({ kind: 'step_up', value, now, db, cfg });
  if (!consumed) throw stepUpInvalid('challenge');
  return STEP_UP_MODES.wallet;
}

async function verifyIdentifyStepUp({ user, excludeAttemptId, body, db, cfg, now }) {
  const { stepUpLoginId, stepUpLoginSecret } = body;
  if (stepUpLoginId === undefined || stepUpLoginId === null || stepUpLoginId === '') throw stepUpRequired(STEP_UP_MODES.identify);
  let proofAttempt;
  try {
    proofAttempt = await complete.loadAttempt({ loginId: stepUpLoginId, loginSecret: stepUpLoginSecret, intent: 'link', db, cfg, now });
  } catch {
    throw stepUpInvalid('identify');
  }
  const createdAt = proofAttempt.createdAt instanceof Date ? proofAttempt.createdAt.getTime() : Number.NaN;
  if (
    proofAttempt.userId !== user.id
    || proofAttempt.id === excludeAttemptId
    || !(createdAt >= now.getTime() - IDENTIFY_STEP_UP_WINDOW_MS)
  ) {
    throw stepUpInvalid('identify');
  }
  const linked = await db.authIdentity.findUnique({
    where: { provider_subject: { provider: proofAttempt.provider, subject: proofAttempt.subject } },
  });
  if (!linked || linked.userId !== user.id || !isListed(linked)) throw stepUpInvalid('identify');
  const { count } = await db.authLoginAttempt.updateMany({
    where: { id: proofAttempt.id, intent: 'link', state: 'identified', expiresAt: { gt: now } },
    data: { state: 'completed', completedAt: now },
  });
  if (count !== 1) throw stepUpInvalid('identify');
  return STEP_UP_MODES.identify;
}

/** Verify (and consume) the step-up for `action` on `target`. Returns the mode used. */
async function verifyStepUp({ user, action, target, body = {}, linkAttempt = null, db, cfg, now }) {
  const mode = await modeFor({ user, action, attempt: linkAttempt, db, cfg });
  if (mode === STEP_UP_MODES.wallet) return verifyWalletStepUp({ user, action, target, body, db, cfg, now });
  if (mode === STEP_UP_MODES.none) return mode;
  return verifyIdentifyStepUp({ user, excludeAttemptId: linkAttempt && linkAttempt.id, body, db, cfg, now });
}

// ---------------------------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------------------------

async function accountLocale(user, db, fallback) {
  try {
    if (db.userProfile && typeof db.userProfile.findUnique === 'function') {
      const profile = await db.userProfile.findUnique({ where: { userId: user.id } });
      if (profile && profile.language) return profile.language;
    }
  } catch {
    // The notice falls back to the request's locale, then English.
  }
  return typeof fallback === 'string' && fallback ? fallback : 'en';
}

/** Start the notices; the returned promise never rejects (notify.sendIdentityNotices). */
async function sendNotices({ user, rows, kind, identity, stepUp, request, db, cfg, now, notifier }) {
  const to = notify.strongEmailsOf({ user, identities: rows, cfg });
  const locale = await accountLocale(user, db, request.locale);
  return notifier.sendIdentityNotices({
    to,
    kind,
    provider: identity.provider,
    methodEmailMasked: identity.email ? maskEmail(identity.email) : null,
    locale,
    at: now,
    context: { userAgent: request.userAgent, country: request.country },
    confirmedWithWallet: stepUp === STEP_UP_MODES.wallet,
    identityId: identity.id,
  });
}

function safeNotice(promise) {
  return Promise.resolve(promise).catch(() => ({ sent: 0, failed: 0 }));
}

// ---------------------------------------------------------------------------------------------
// Link / unlink
// ---------------------------------------------------------------------------------------------

/**
 * POST /identities/link {loginId, loginSecret, stepUpSignature | stepUpLoginId + stepUpLoginSecret}.
 * Returns { identity, notice } — `notice` is the (never rejecting) promise of the notices, which
 * the controller does not wait for.
 */
async function linkIdentity({ user, body = {}, request = {}, db = defaultDb(), cfg = readNativeAuthConfig(), now = new Date(), notifier = notify }) {
  accounts.guardAccount(user);
  const attempt = await complete.loadAttempt({ loginId: body.loginId, loginSecret: body.loginSecret, intent: 'link', db, cfg, now });
  if (attempt.userId !== user.id || !LISTED_PROVIDERS.includes(attempt.provider)) throw expired();
  const ref = loginRefFor(attempt.id, cfg);
  await assertNotLinked(attempt, db);

  const stepUp = await verifyStepUp({ user, action: 'link', target: attempt.id, body, linkAttempt: attempt, db, cfg, now });

  // Claim the attempt (one winner); a failure below puts it back.
  const claimed = await db.authLoginAttempt.updateMany({
    where: { id: attempt.id, intent: 'link', state: 'identified', expiresAt: { gt: now } },
    data: { state: 'completing' },
  });
  if (claimed.count !== 1) throw expired();

  let row;
  try {
    row = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${identityLockKey(user.id)})`;
      const created = await tx.authIdentity.create({
        data: {
          userId: user.id,
          provider: attempt.provider,
          subject: attempt.subject,
          email: attempt.email,
          emailLinkGrade: attempt.emailLinkGrade,
          isPrivateRelay: Boolean(attempt.isPrivateRelay),
          linkedVia: MANUAL_LINKED_VIA,
        },
      });
      await tx.authLoginAttempt.updateMany({
        where: { id: attempt.id, state: 'completing' },
        data: { state: 'completed', completedAt: now },
      });
      return created;
    });
  } catch (err) {
    await db.authLoginAttempt
      .updateMany({ where: { id: attempt.id, state: 'completing' }, data: { state: 'identified' } })
      .catch(() => {});
    if (isP2002(err)) throw alreadyLinked();
    throw err;
  }

  logger.info('native_auth.identity_linked', { loginRef: ref, provider: row.provider, identityId: row.id, stepUp });
  const rows = await listRows(user, db);
  const notice = safeNotice(sendNotices({ user, rows, kind: 'linked', identity: row, stepUp, request, db, cfg, now, notifier }));
  return { identity: identitySummary(row), notice };
}

/**
 * DELETE /identities/:id {stepUpSignature | stepUpLoginId + stepUpLoginSecret}. Returns { notice }.
 */
async function unlinkIdentity({ user, identityId, body = {}, request = {}, db = defaultDb(), cfg = readNativeAuthConfig(), now = new Date(), notifier = notify }) {
  accounts.guardAccount(user);
  const identity = await ownedIdentity({ user, identityId, db });
  const before = await listRows(user, db);
  if (otherMethodCount(user, before, identity.id) === 0) throw lastMethod();

  const stepUp = await verifyStepUp({ user, action: 'unlink', target: identity.id, body, db, cfg, now });

  await db.$transaction(async (tx) => {
    // Two concurrent unlinks of the last two methods: the second one re-counts after the first.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${identityLockKey(user.id)})`;
    const current = await tx.authIdentity.findMany({ where: { userId: user.id } });
    const fresh = (await tx.user.findUnique({ where: { id: user.id } })) || user;
    if (!current.some((row) => row.id === identity.id)) throw stepUpInvalid('identity');
    if (otherMethodCount(fresh, current, identity.id) === 0) throw lastMethod();
    const { count } = await tx.authIdentity.deleteMany({ where: { id: identity.id, userId: user.id } });
    if (count !== 1) throw stepUpInvalid('identity');
  });

  logger.info('native_auth.identity_unlinked', { provider: identity.provider, identityId: identity.id, stepUp });
  // The removed method's own strong address is told too (it is in `before`).
  const notice = safeNotice(sendNotices({ user, rows: before, kind: 'unlinked', identity, stepUp, request, db, cfg, now, notifier }));
  return { notice };
}

module.exports = {
  ACTIONS,
  STEP_UP_TTL_SEC,
  IDENTIFY_STEP_UP_WINDOW_MS,
  MANUAL_LINKED_VIA,
  STEP_UP_MODES,
  identitySummary,
  listIdentities,
  createStepUpChallenge,
  linkIdentity,
  unlinkIdentity,
  EXTERNAL_WALLET_VERIFIER,
  _internals: { stepUpValue, stepUpHash, stepUpStatement, otherMethodCount, identityLockKey, verifyStepUp, provenWallet },
};
