/**
 * POST /api/auth/native/token and POST /api/auth/native/complete (design §2.1 #10–11, §3.7).
 *
 * Both are authenticated by the attempt's loginSecret alone (F3): 256 bits, stored only as
 * HMAC(stateKey('login'), secret), compared in constant time; an unknown loginId, a wrong secret,
 * an expired or finished attempt all answer the same LOGIN_EXPIRED. guardAccount runs on both
 * (F21). Only loginRef is logged.
 *
 * /token re-mints the Web3Auth JWT for the SAME attempt and subject: at most 2 re-mints (the
 * initial mint + 2 = w3aTokenCount ≤ 3), each with a reason from a closed enum. It never mints
 * for anything but an identified login attempt (no DDC-session path; F2/D4).
 *
 * /complete:
 *   1. claims the attempt (identified → completing, one winner); every failure resets it;
 *   2. recovers the signer of the EIP-4361 proof (buildProofMessage + ethers.verifyMessage);
 *   3. re-resolves the account (§3.6) and refuses with LOGIN_RACE if it changed since identify;
 *   4. proves the address with the Web3Auth nodes (w3aLookup; always enforced, fail closed),
 *      skipped only when NativeWalletBinding already holds this exact (connection, subject,
 *      address);
 *   5. decides the wallet rule, then writes create / link / bind in ONE transaction. Every
 *      refusal is decided BEFORE the transaction, so a refusal writes nothing (not even the
 *      identity). Every P2002 → LOGIN_RACE (the client re-runs identify once);
 *   6. applies the referral exactly as web3auth-login does (loginCompletion) and answers today's
 *      web3auth-login body plus `isNewUser` (D19), with a session carrying {ver: 2, amr}.
 */
const crypto = require('crypto');
const { getAddress, verifyMessage } = require('ethers');
const { readNativeAuthConfig, loginRef: loginRefFor, logger } = require('./config');
const { issueW3aToken } = require('./issuer');
const { buildProofMessage } = require('./proofMessage');
const { loginSecretHash } = require('./identify');
const accounts = require('./accounts');
const w3aLookup = require('./w3aLookup');
const { NativeAuthError } = require('../../controllers/nativeAuth/respond');
const loginCompletion = require('../loginCompletion');
const { generateToken } = require('../../utils/jwtUtils');
const { generateUniqueReferralCode } = require('../../utils/referralUtils');
const { normalizeReferralCodeInput } = require('../../utils/referralCodeFormat');

const TOKEN_REASONS = Object.freeze(['duplicate_token', 'timesigned', 'expired', 'network']);
const MAX_W3A_TOKENS = 3; // the initial mint + 2 re-mints
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WALLET_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const PROFILE_LANGUAGES = Object.freeze(['en', 'zh', 'zh-TW', 'ja', 'ko']);

function defaultDb() {
  return require('../../utils/prisma');
}

function expired() {
  return new NativeAuthError('LOGIN_EXPIRED', { message: 'This sign-in has expired. Please start again.' });
}

function race() {
  return new NativeAuthError('LOGIN_RACE', { message: 'This sign-in changed while it was being completed. Please try again.' });
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function constantTimeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Load the attempt `loginId` and check `loginSecret` against its HMAC. Any mismatch — unknown id,
 * malformed input, wrong secret, wrong intent, expired, not in `state` — is LOGIN_EXPIRED.
 * `intent: 'link'` is for POST /identities/link (BE7); /token and /complete accept only 'login'.
 */
async function loadAttempt({ loginId, loginSecret, state = 'identified', intent = 'login', db = defaultDb(), cfg = readNativeAuthConfig(), now = new Date() }) {
  if (typeof loginId !== 'string' || !UUID_PATTERN.test(loginId)) throw expired();
  if (typeof loginSecret !== 'string' || !LOGIN_SECRET_PATTERN.test(loginSecret)) throw expired();
  const attempt = await db.authLoginAttempt.findUnique({ where: { id: loginId } });
  // Compute the HMAC even for an unknown id, so the answer takes the same time either way.
  const presented = loginSecretHash(loginSecret, cfg);
  if (!attempt) throw expired();
  if (!constantTimeEqualHex(presented, attempt.loginSecretHash)) throw expired();
  if (attempt.intent !== intent || attempt.state !== state) throw expired();
  if (!(attempt.expiresAt instanceof Date) || attempt.expiresAt.getTime() <= now.getTime()) throw expired();
  if (intent === 'login' && (!attempt.w3aSubject || !attempt.walletProof)) throw expired();
  return attempt;
}

/** guardAccount on the attempt's resolved account, re-read (F21). */
async function guardAttemptAccount(attempt, db) {
  if (!attempt.userId) return null;
  const user = await db.user.findUnique({ where: { id: attempt.userId } });
  if (!user) throw race();
  accounts.guardAccount(user);
  return user;
}

// ---------------------------------------------------------------------------------------------
// POST /token
// ---------------------------------------------------------------------------------------------

/** Re-mint the Web3Auth JWT of an identified attempt. Returns { web3auth: { idToken, idTokenExpiresAt } }. */
async function reissueToken({ loginId, loginSecret, reason, db = defaultDb(), cfg = readNativeAuthConfig(), now = new Date() } = {}) {
  const attempt = await loadAttempt({ loginId, loginSecret, db, cfg, now });
  if (!TOKEN_REASONS.includes(reason)) throw expired();
  await guardAttemptAccount(attempt, db);
  const ref = loginRefFor(attempt.id, cfg);
  // One atomic step: only an identified, unexpired attempt below the limit gets a new token.
  const { count } = await db.authLoginAttempt.updateMany({
    where: { id: attempt.id, state: 'identified', expiresAt: { gt: now }, w3aTokenCount: { lt: MAX_W3A_TOKENS } },
    data: { w3aTokenCount: { increment: 1 } },
  });
  if (count !== 1) {
    const current = await db.authLoginAttempt.findUnique({ where: { id: attempt.id } });
    if (current && current.state === 'identified' && current.w3aTokenCount >= MAX_W3A_TOKENS) {
      logger.warn('native_auth.token_limit', { loginRef: ref, reason });
      throw new NativeAuthError('LOGIN_TOKEN_LIMIT', { message: 'Too many wallet tokens for this sign-in. Please start again.' });
    }
    throw expired();
  }
  const after = await db.authLoginAttempt.findUnique({ where: { id: attempt.id } });
  const tokenCount = after ? after.w3aTokenCount : attempt.w3aTokenCount + 1;
  const minted = await issueW3aToken({ subject: attempt.w3aSubject, loginRef: ref, count: tokenCount, cfg, now: now.getTime() });
  await db.authLoginAttempt.updateMany({ where: { id: attempt.id }, data: { lastJti: minted.jti } });
  logger.info('native_auth.token_reissued', { loginRef: ref, reason, count: tokenCount });
  return { web3auth: { idToken: minted.idToken, idTokenExpiresAt: minted.expiresAt } };
}

// ---------------------------------------------------------------------------------------------
// POST /complete
// ---------------------------------------------------------------------------------------------

function identityOf(attempt) {
  return {
    provider: attempt.provider,
    subject: attempt.subject,
    email: attempt.email,
    // identify stored an e-mail for Apple only when Apple verified it; for Google the stored grade
    // (passed to the re-resolution) carries the verdict.
    emailVerified: attempt.provider === 'email' || attempt.emailLinkGrade === 'strong' || (attempt.provider === 'apple' && Boolean(attempt.email)),
    hd: null,
    isPrivateRelay: attempt.isPrivateRelay,
    profile: attempt.profile || {},
  };
}

/** Step 2: the checksummed address that signed the attempt's proof, which must be `walletAddress`. */
function recoverProofSigner(attempt, walletAddress, signature) {
  if (typeof walletAddress !== 'string' || !WALLET_PATTERN.test(walletAddress)) throw proofInvalid();
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) throw proofInvalid();
  let recovered;
  try {
    recovered = verifyMessage(buildProofMessage(attempt.walletProof, walletAddress), signature);
  } catch {
    throw proofInvalid();
  }
  if (!sameAddress(recovered, walletAddress)) throw proofInvalid();
  return getAddress(recovered);
}

function proofInvalid() {
  return new NativeAuthError('WALLET_PROOF_INVALID', { message: 'The wallet confirmation could not be verified.' });
}

/**
 * Step 3: the resolution must still be the one identify made (same account, same kind), else a
 * concurrent sign-in changed it and the client re-identifies (LOGIN_RACE).
 */
async function reResolve(attempt, identity, db, cfg, now) {
  let current;
  try {
    current = await accounts.resolveNativeIdentity({ identity, cfg, db, now, checkNewAccountGate: false, grade: attempt.emailLinkGrade });
  } catch (err) {
    if (err instanceof NativeAuthError && err.code === 'ACCOUNT_LINK_REQUIRED') throw race();
    throw err;
  }
  const isNew = accounts.NEW_ACCOUNT_RESOLUTIONS.includes(attempt.resolution);
  if (isNew) {
    if (current.resolution !== attempt.resolution || !attempt.pendingUserId) throw race();
    return current;
  }
  if (!current.user || current.user.id !== attempt.userId) throw race();
  // An identity that appeared since identify (a parallel completion of the same attempt kind) is
  // the same account; any other change of kind is a race.
  if (current.resolution !== attempt.resolution && current.resolution !== 'existing') throw race();
  return current;
}

/** Step 4: prove `address` for the attempt's subject (or accept the existing identical binding). */
async function proveAddress({ attempt, address, binding, cfg, ref }) {
  if (binding && binding.connection === cfg.connectionId && binding.subject === attempt.w3aSubject && sameAddress(binding.address, address)) {
    return 'binding';
  }
  const derived = await w3aLookup.lookupWalletAddress({
    connection: cfg.connectionId,
    subject: attempt.w3aSubject,
    network: cfg.network,
    clientId: cfg.w3aClientId,
    loginRef: ref,
  });
  if (!sameAddress(derived, address)) {
    logger.error('native_auth.wallet_not_derived', { loginRef: ref });
    throw new NativeAuthError('WALLET_NOT_DERIVED', { message: 'This wallet was not derived for this sign-in.' });
  }
  return 'nodes';
}

async function assertWalletFree(db, address, exceptUserId) {
  const holder = await db.user.findFirst({
    where: { walletAddress: { equals: address, mode: 'insensitive' }, ...(exceptUserId && { id: { not: exceptUserId } }) },
  });
  if (holder) throw new NativeAuthError('WALLET_IN_USE', { message: 'Wallet address already in use' });
}

/** Rule of §3.7 step 4 for an existing account: 'bind' | 'unchanged' | 'rebind' (lazy), or throws. */
function walletRule({ user, binding, address, cfg, ref }) {
  if (binding) {
    if (!sameAddress(binding.address, address) || (user.walletAddress && !sameAddress(user.walletAddress, address))) {
      logger.error('native_auth.wallet_mismatch', { loginRef: ref });
      throw new NativeAuthError('WALLET_MISMATCH', { message: 'This sign-in produced a different wallet. Please contact support.' });
    }
    return user.walletAddress ? 'unchanged' : 'bind';
  }
  if (!user.walletAddress) return 'bind';
  if (sameAddress(user.walletAddress, address)) return 'unchanged';
  if (cfg.rebindPolicy === 'lazy') return 'rebind';
  logger.info('native_auth.rebind_refused', { loginRef: ref });
  throw new NativeAuthError('WALLET_REBIND_REQUIRED', { message: 'Please use your previous sign-in method for now.' });
}

/** The legacy network a Web3Auth verifier name points at (…-sapphire-devnet), for the audit row. */
function legacyNetwork(verifier) {
  const name = String(verifier || '');
  if (/sapphire[-_]mainnet/i.test(name)) return 'sapphire_mainnet';
  if (/sapphire[-_]devnet/i.test(name)) return 'sapphire_devnet';
  return 'unknown';
}

function profileLanguage(locale) {
  if (typeof locale !== 'string') return 'en';
  const match = PROFILE_LANGUAGES.find((lang) => lang.toLowerCase() === locale.trim().toLowerCase());
  if (match) return match;
  const base = locale.trim().toLowerCase().split(/[-_]/)[0];
  if (base === 'zh') return /(tw|hk|mo|hant)/i.test(locale) ? 'zh-TW' : 'zh';
  return PROFILE_LANGUAGES.includes(base) ? base : 'en';
}

/**
 * User.email for a new native account: the identity's e-mail when it is strong (or Apple's
 * verified address) and no row holds it; otherwise a placeholder that realEmail() reads as "no
 * e-mail" (`<provider>|<subject>`, or `email|<userId>` for a rule-3d shadow account).
 */
async function newAccountEmail({ identity, grade, resolution, userId, db }) {
  if (resolution === 'shadow_email') return `email|${userId}`;
  const usable = identity.email && (grade === 'strong' || (identity.provider === 'apple' && identity.emailVerified));
  if (usable) {
    const holder = await db.user.findFirst({ where: { email: { equals: identity.email, mode: 'insensitive' } } });
    if (!holder) return identity.email;
  }
  return `${identity.provider}|${identity.subject}`;
}

function displayName(identity, email) {
  if (identity.profile && identity.profile.name) return identity.profile.name;
  if (email && email.includes('@') && !email.includes('|')) return email.split('@')[0];
  if (identity.profile && identity.profile.xUsername) return identity.profile.xUsername;
  return 'User';
}

/** X: set User.xid only when no other row holds it (F12: never a 409 on a held xid). */
async function freeXid(identity, db, exceptUserId, ref) {
  if (identity.provider !== 'x') return null;
  const holder = await db.user.findFirst({ where: { xid: identity.subject, ...(exceptUserId && { id: { not: exceptUserId } }) } });
  if (holder) {
    logger.info('native_auth.xid_held_elsewhere', { loginRef: ref });
    return null;
  }
  return identity.subject;
}

function isP2002(err) {
  return Boolean(err && err.code === 'P2002');
}

/** Fill display fields only when empty (as web3auth-login does). */
async function displayUpdates({ user, identity, db, ref }) {
  const profile = identity.profile || {};
  const data = {
    ...(profile.name && !user.name && { name: profile.name }),
    ...(profile.avatar && !user.avatar && { avatar: profile.avatar }),
    ...(profile.xUsername && !user.xUsername && { xUsername: profile.xUsername }),
  };
  if (!user.xid) {
    const xid = await freeXid(identity, db, user.id, ref);
    if (xid) data.xid = xid;
  }
  return data;
}

/**
 * Complete a login attempt. Returns { httpStatus, data } where data is today's web3auth-login body
 * plus `isNewUser`. Throws NativeAuthError (contract codes) or loginCompletion.HttpReply (the
 * referral codes of web3auth-login, unchanged).
 */
async function completeLogin({ body = {}, db = defaultDb(), cfg = readNativeAuthConfig(), now = new Date() } = {}) {
  const { loginId, loginSecret, walletAddress, signature } = body;
  const attempt = await loadAttempt({ loginId, loginSecret, db, cfg, now });
  const ref = loginRefFor(attempt.id, cfg);

  // 1. Claim (one winner). Every failure below resets the attempt so the client may retry.
  const claimed = await db.authLoginAttempt.updateMany({
    where: { id: attempt.id, state: 'identified', expiresAt: { gt: now } },
    data: { state: 'completing' },
  });
  if (claimed.count !== 1) throw expired();

  let outcome;
  try {
    outcome = await completeClaimed({ attempt, body, walletAddress, signature, db, cfg, now, ref });
  } catch (err) {
    await db.authLoginAttempt
      .updateMany({ where: { id: attempt.id, state: 'completing' }, data: { state: 'identified' } })
      .catch(() => {});
    if (isP2002(err)) {
      logger.warn('native_auth.login_race', { loginRef: ref, target: err.meta && err.meta.target });
      throw race();
    }
    throw err;
  }

  await db.authLoginAttempt.updateMany({
    where: { id: attempt.id, state: 'completing' },
    data: { state: 'completed', completedAt: now, userId: outcome.user.id },
  });
  logger.info('native_auth.complete', { loginRef: ref, method: attempt.method, action: attempt.resolution, walletAction: outcome.walletAction });

  const token = generateToken(outcome.user.id, { ver: 2, amr: attempt.method });
  return {
    httpStatus: outcome.isNewUser ? 201 : 200,
    data: loginCompletion.loginResponseData(token, outcome.user, outcome.invitationStatus, { isNewUser: outcome.isNewUser }),
  };
}

async function completeClaimed({ attempt, body, walletAddress, signature, db, cfg, now, ref }) {
  // 2. Wallet proof.
  const address = recoverProofSigner(attempt, walletAddress, signature);

  // 3. Account (still the same?) and guardAccount.
  const identity = identityOf(attempt);
  const grade = attempt.emailLinkGrade;
  const current = await reResolve(attempt, identity, db, cfg, now);
  const isNewUser = accounts.NEW_ACCOUNT_RESOLUTIONS.includes(attempt.resolution);
  const existing = isNewUser ? null : current.user;
  accounts.guardAccount(existing);

  // Referral input, exactly as web3auth-login reads it.
  const referralCode = normalizeReferralCodeInput(body.referralCode);
  const { campaignSlug, inviteError } = await loginCompletion.resolveCampaign({ body }, referralCode);

  if (isNewUser) {
    return createAccount({ attempt, identity, grade, address, referralCode, campaignSlug, inviteError, body, db, cfg, now, ref });
  }
  return completeExisting({ attempt, identity, grade, user: existing, identityRow: current.identityRow, address, referralCode, campaignSlug, inviteError, db, cfg, now, ref });
}

async function createAccount({ attempt, identity, grade, address, referralCode, campaignSlug, inviteError, body, db, cfg, now, ref }) {
  const userId = attempt.pendingUserId;
  // The new-account gate was applied at identify; the daily cap is re-checked here (F16).
  await accounts.assertDailyCapAvailable({ cfg, db, now });

  // 4. The nodes must derive this address for the subject (no binding exists for a new user).
  await proveAddress({ attempt, address, binding: null, cfg, ref });
  await assertWalletFree(db, address, null);

  // An unusable campaign still refuses a new registration, as in web3auth-login.
  if (inviteError) throw inviteError;
  const referrerId = await loginCompletion.validateReferralForNewUser(referralCode, campaignSlug, userId);

  const email = await newAccountEmail({ identity, grade, resolution: attempt.resolution, userId, db });
  const xid = await freeXid(identity, db, null, ref);
  const ownReferralCode = await generateUniqueReferralCode();
  const profile = identity.profile || {};

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        id: userId,
        email,
        name: displayName(identity, email),
        ...(profile.avatar && { avatar: profile.avatar }),
        walletAddress: address,
        authType: 'web3auth',
        userType: 'regular',
        referralCode: ownReferralCode,
        web3authVerifier: cfg.connectionId,
        web3authVerifierId: userId,
        web3authLinkedAt: now,
        ...(xid && { xid }),
        ...(profile.xUsername && { xUsername: profile.xUsername }),
        profile: { create: { language: profileLanguage(body.locale) } },
      },
    });
    await tx.nativeWalletBinding.create({
      data: { userId, connection: cfg.connectionId, network: cfg.network, subject: attempt.w3aSubject, address, boundAt: now },
    });
    await tx.authIdentity.create({
      data: {
        userId,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
        emailLinkGrade: grade,
        isPrivateRelay: Boolean(identity.isPrivateRelay),
        linkedVia: 'created',
        lastLoginAt: now,
      },
    });
    if (referrerId) {
      await tx.referral.create({ data: { inviterId: referrerId, inviteeId: userId, code: referralCode, campaignSlug } });
    }
    return created;
  });

  if (referrerId) await loginCompletion.settleReferral(user.id, referrerId, campaignSlug, referralCode);
  return {
    user,
    isNewUser: true,
    walletAction: 'created',
    invitationStatus: referrerId ? { ...loginCompletion.REGISTERED_WITH_REFERRAL } : null,
  };
}

async function completeExisting({ attempt, identity, grade, user, identityRow, address, referralCode, campaignSlug, inviteError, db, cfg, now, ref }) {
  const binding = await db.nativeWalletBinding.findUnique({ where: { userId: user.id } });
  // The attempt was minted for another subject than the account's binding (a binding appeared
  // after identify): re-identify to get the bound subject.
  if (binding && binding.subject !== attempt.w3aSubject) throw race();

  // 4. Prove the address, then decide the wallet rule — all before any write.
  await proveAddress({ attempt, address, binding, cfg, ref });
  const action = walletRule({ user, binding, address, cfg, ref });
  if (action === 'bind' || action === 'rebind') await assertWalletFree(db, address, user.id);
  const updates = await displayUpdates({ user, identity, db, ref });
  const legacySubject = user.web3authVerifier && user.web3authVerifierId && user.web3authVerifier !== cfg.connectionId
    ? `${user.web3authVerifier}|${user.web3authVerifierId}`
    : null;
  const legacyIdentity = action === 'rebind' && legacySubject
    ? await db.authIdentity.findUnique({ where: { provider_subject: { provider: accounts.LEGACY_PROVIDER, subject: legacySubject } } })
    : null;

  const updated = await db.$transaction(async (tx) => {
    // The identity: a login through a known identity refreshes it; a link creates it.
    if (identityRow) {
      await tx.authIdentity.update({ where: { id: identityRow.id }, data: { lastLoginAt: now } });
    } else {
      await tx.authIdentity.create({
        data: {
          userId: user.id,
          provider: identity.provider,
          subject: identity.subject,
          email: identity.email,
          emailLinkGrade: grade,
          isPrivateRelay: Boolean(identity.isPrivateRelay),
          linkedVia: accounts.LINKED_VIA[attempt.resolution] || attempt.resolution,
          lastLoginAt: now,
        },
      });
    }

    let newBinding = binding;
    if (!binding) {
      newBinding = await tx.nativeWalletBinding.create({
        data: { userId: user.id, connection: cfg.connectionId, network: cfg.network, subject: attempt.w3aSubject, address, boundAt: now },
      });
    }

    if (action === 'bind') updates.walletAddress = address;
    if (action === 'rebind') {
      // §3.11 lazy rebind (DDC_AUTH_ENV=local|test only; boot refuses it elsewhere).
      await tx.walletAddressHistory.create({
        data: {
          userId: user.id,
          oldAddress: user.walletAddress,
          oldVerifier: user.web3authVerifier || null,
          oldVerifierId: user.web3authVerifierId || null,
          oldNetwork: legacyNetwork(user.web3authVerifier),
          newAddress: address,
          newVerifier: cfg.connectionId,
          // A reference to the binding row, never the subject itself (F11).
          newSubjectRef: newBinding.id,
          newNetwork: cfg.network,
          reason: 'native_login_rebind',
          status: 'applied',
          chainStatus: 'pending',
          appliedAt: now,
        },
      });
      if (legacySubject && !legacyIdentity) {
        await tx.authIdentity.create({
          data: { userId: user.id, provider: accounts.LEGACY_PROVIDER, subject: legacySubject, emailLinkGrade: 'none', linkedVia: 'lazy_rebind' },
        });
      }
      updates.walletAddress = address;
    }
    if (!Object.keys(updates).length) return tx.user.findUnique({ where: { id: user.id } });
    return tx.user.update({ where: { id: user.id }, data: updates });
  });
  if (action === 'rebind') logger.warn('native_auth.wallet_rebound', { loginRef: ref });

  const invitationStatus = await loginCompletion.applyReferralToExistingUser(updated, referralCode, campaignSlug, inviteError);
  const walletAction = action === 'rebind' ? 'rebound' : action === 'bind' ? 'bound' : 'unchanged';
  return { user: updated, isNewUser: false, walletAction, invitationStatus };
}

module.exports = {
  TOKEN_REASONS,
  MAX_W3A_TOKENS,
  reissueToken,
  completeLogin,
  loadAttempt,
  _internals: { recoverProofSigner, walletRule, newAccountEmail, profileLanguage, legacyNetwork },
};
