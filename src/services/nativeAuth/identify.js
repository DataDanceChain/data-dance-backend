/**
 * Identify → login attempt (design §1 step 1, §2.1 `Identified`, §3.6, §3.7).
 *
 * Every method (e-mail OTP, Google, Apple, X) ends its upstream verification by calling
 * createLoginAttempt() with the verified identity (shape documented in accounts.js). It resolves
 * the account (accounts.resolveNativeIdentity, which writes nothing), runs guardAccount, and
 * creates one AuthLoginAttempt:
 *
 *   - loginId (the row id, a UUID) and a 256-bit loginSecret, returned ONCE; only
 *     HMAC(stateKey('login'), loginSecret) is stored, and neither is ever logged (F3). Logs carry
 *     only loginRef = HMAC(state secret, loginId)[:16].
 *   - intent 'login': the first Web3Auth JWT (issuer.issueW3aToken, sub = the opaque w3aSubject of
 *     NativeWalletBinding, never the user id; F11) and the EIP-4361 walletProof the client signs.
 *   - intent 'link' (an already signed-in user proving one more method, BE7): nothing is minted;
 *     only { loginId, loginSecret, expiresAt, account } is returned.
 *
 * issuer.issueW3aToken is called only from here and from POST /token (complete.js). There is no
 * path from a DDC session to a Web3Auth JWT (F2, D4): a bearer session can only ever produce a
 * 'link' attempt, which mints nothing.
 */
const crypto = require('crypto');
const { readNativeAuthConfig, stateHmac, loginRef: loginRefFor, hashIp, logger } = require('./config');
const { issueW3aToken } = require('./issuer');
const { createWalletProof } = require('./proofMessage');
const accounts = require('./accounts');

const INTENTS = Object.freeze(['login', 'link']);
const METHODS = Object.freeze(['email', 'google', 'apple', 'x']);
const LOGIN_SECRET_BYTES = 32;

function defaultDb() {
  return require('../../utils/prisma');
}

/** HMAC stored for a loginSecret (hex). */
function loginSecretHash(loginSecret, cfg) {
  return stateHmac('login', loginSecret, cfg);
}

function clientIp(req) {
  return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
}

/**
 * Create the login attempt for a verified identity and return the `Identified` body (§2.1).
 *
 * @param identity   verified upstream identity (accounts.js shape)
 * @param intent     'login' (default) or 'link'
 * @param method     the sign-in method ('email'|'google'|'apple'|'x'); defaults to the provider
 * @param req        the request (client IP → ipHash); optional
 * @param bearerUser the signed-in user; required for intent 'link', ignored for 'login'
 */
async function createLoginAttempt({ identity: rawIdentity, intent = 'login', method, req, bearerUser, db = defaultDb(), cfg = readNativeAuthConfig(), now = new Date() } = {}) {
  if (!INTENTS.includes(intent)) throw new TypeError(`unknown intent "${intent}"`);
  const identity = accounts.normalizeIdentity(rawIdentity);
  const loginMethod = method || identity.provider;
  if (!METHODS.includes(loginMethod)) throw new TypeError(`unknown method "${loginMethod}"`);
  const grade = accounts.linkGrade(identity);

  const loginId = crypto.randomUUID();
  const loginSecret = crypto.randomBytes(LOGIN_SECRET_BYTES).toString('base64url');
  const ref = loginRefFor(loginId, cfg);
  const expiresAt = new Date(now.getTime() + cfg.loginTtlSec * 1000);
  const base = {
    id: loginId,
    loginSecretHash: loginSecretHash(loginSecret, cfg),
    intent,
    method: loginMethod,
    provider: identity.provider,
    subject: identity.subject,
    email: identity.email,
    emailLinkGrade: grade,
    isPrivateRelay: identity.isPrivateRelay,
    profile: identity.profile,
    ipHash: hashIp(clientIp(req), cfg),
    expiresAt,
  };

  if (intent === 'link') {
    if (!bearerUser || !bearerUser.id) throw new TypeError('intent "link" requires the signed-in user');
    accounts.guardAccount(bearerUser);
    await db.authLoginAttempt.create({ data: { ...base, resolution: 'link', userId: bearerUser.id } });
    logger.info('native_auth.identity_resolved', { loginRef: ref, resolution: 'link', method: loginMethod });
    return {
      loginId,
      loginSecret,
      expiresAt: expiresAt.toISOString(),
      account: { status: 'existing', hasWallet: Boolean(bearerUser.walletAddress), linkedBy: 'identity' },
    };
  }

  let resolved;
  try {
    resolved = await accounts.resolveNativeIdentity({ identity, cfg, db, now });
  } catch (err) {
    if (err && err.code === 'ACCOUNT_LINK_REQUIRED') {
      logger.info('native_auth.account_link_required', { loginRef: ref, reason: err.data && err.data.reason, method: loginMethod });
    }
    throw err;
  }
  const userId = resolved.user ? resolved.user.id : null;
  const { pendingUserId, w3aSubject } = await accounts.pendingSubjects({ identity, userId, db, now });

  const walletProof = createWalletProof({ cfg, loginRef: ref, expiresAt, now });
  const minted = await issueW3aToken({ subject: w3aSubject, loginRef: ref, count: 1, cfg, now: now.getTime() });
  await db.authLoginAttempt.create({
    data: {
      ...base,
      resolution: resolved.resolution,
      userId,
      pendingUserId,
      w3aSubject,
      walletProof,
      w3aTokenCount: 1,
      lastJti: minted.jti,
    },
  });
  logger.info('native_auth.identity_resolved', { loginRef: ref, resolution: resolved.resolution, method: loginMethod });
  if (resolved.resolution === 'shadow_email') logger.info('native_auth.email_shadowed', { loginRef: ref, method: loginMethod });

  return {
    loginId,
    loginSecret,
    expiresAt: expiresAt.toISOString(),
    account: resolved.account,
    web3auth: {
      network: cfg.network,
      verifier: cfg.connectionId,
      verifierId: w3aSubject,
      idToken: minted.idToken,
      idTokenExpiresAt: minted.expiresAt,
    },
    walletProof,
  };
}

module.exports = { INTENTS, METHODS, LOGIN_SECRET_BYTES, loginSecretHash, createLoginAttempt };
