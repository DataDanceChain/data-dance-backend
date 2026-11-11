const { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } = require('node:crypto');
const { normalizeEmail, isValidEmail } = require('../utils/emailMask');
const { publicUser } = require('../utils/publicUser');

const RECENT_SESSION_SECONDS = 10 * 60;
const PROVIDER_CLOCK_SKEW_SECONDS = 30;
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS = 5;
const MAX_ATTEMPTS = 5;
const MAX_USERS = 4096;

const challenges = new Map();
const challengeKey = randomBytes(32);

const unavailable = () => error(503, 'EMAIL_BINDING_UNAVAILABLE', 'Email binding is temporarily unavailable.');
const recentRequired = () => error(403, 'EMAIL_BIND_REAUTH_REQUIRED', 'Sign in again with your existing wallet login to bind an email.');
const conflict = () => error(409, 'EMAIL_BIND_CONFLICT', 'This email cannot be bound to this account.');
const alreadyBound = () => error(409, 'EMAIL_BIND_ALREADY_BOUND', 'This email is already bound to this account.');
const invalidCode = () => error(400, 'EMAIL_CODE_INVALID', 'That code is incorrect or has expired.');
const accepted = () => success({ accepted: true });

function error(status, code, message) {
  return { status, body: { status: 'fail', code, message } };
}

function success(data) {
  return { status: 200, body: { status: 'success', data } };
}

function emailBindingEnabled(env = process.env) {
  return String(env.EMAIL_BINDING_ENABLED || '').trim() === 'true';
}

function canBind(user) {
  return user && !user.disabledAt && !user.isOrganization && user.userType === 'regular' &&
    user.authType === 'web3auth' && user.web3authVerifier && user.web3authVerifierId;
}

function identityProof(user) {
  return createHash('sha256')
    .update(JSON.stringify([user.id, user.web3authVerifier, user.web3authVerifierId]))
    .digest('base64url');
}

// Call only after successful verification of a social ID token. A different provider pair that
// may sign in to the same account does not establish fresh proof of its persisted identity.
function bindingClaims(user, identity, trusted, providerClaims, env = process.env, now = Date.now()) {
  if (!emailBindingEnabled(env) || !trusted || identity.kind !== 'social' || !canBind(user) ||
      identity.verifier !== user.web3authVerifier || identity.verifierId !== user.web3authVerifierId) {
    return {};
  }
  const nowSeconds = Math.floor(now / 1000);
  const issued = [providerClaims?.iat];
  if (providerClaims && Object.hasOwn(providerClaims, 'auth_time')) issued.push(providerClaims.auth_time);
  if (!issued.every((time) => Number.isSafeInteger(time) && time > 0 &&
      time <= nowSeconds + PROVIDER_CLOCK_SKEW_SECONDS)) return {};
  const bindingUntil = Math.min(nowSeconds, ...issued) + RECENT_SESSION_SECONDS;
  if (bindingUntil <= nowSeconds) return {};
  return { amr: 'web3auth', jti: randomUUID(), bindingIdentity: identityProof(user), bindingUntil };
}

function recentBindingSession(user, claims, now = Date.now()) {
  if (!canBind(user) || claims?.amr !== 'web3auth' || claims.id !== user.id ||
      typeof claims.jti !== 'string' || !claims.jti || !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.bindingUntil)) return false;
  const nowSeconds = Math.floor(now / 1000);
  const age = nowSeconds - claims.iat;
  return age >= 0 && age < RECENT_SESSION_SECONDS && nowSeconds < claims.bindingUntil &&
    claims.bindingIdentity === identityProof(user);
}

async function reauthBindingSession({ user, idToken, walletAddress, provider, issueToken, env = process.env }) {
  if (!canBind(user) || typeof idToken !== 'string' || !idToken.trim() ||
      (walletAddress != null && typeof walletAddress !== 'string')) return recentRequired();
  let claims;
  try {
    const { kind, payload } = await provider.verifyIdToken(idToken.trim());
    const identity = provider.extractIdentity(payload, { kind });
    claims = bindingClaims(user, identity, provider.isTrustedVerifier(identity.verifier), payload, env);
    if (!claims.amr) return recentRequired();

    const provenWallet = provider.assertWalletBound(identity, walletAddress || user.walletAddress);
    if (user.walletAddress && provenWallet?.toLowerCase() !== user.walletAddress.toLowerCase()) {
      return recentRequired();
    }
  } catch (err) {
    if (err instanceof provider.Web3AuthIdentityError && err.code !== 'IDTOKEN_UPSTREAM_UNAVAILABLE') {
      return recentRequired();
    }
    throw err;
  }
  return success({ token: issueToken(user.id, { ver: 2, ...claims }), user: publicUser(user) });
}

function bindingEmail(rawEmail) {
  const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : '';
  return email.length <= 254 && !email.includes('|') && isValidEmail(email) ? email : null;
}

function beginSend(userId, now) {
  const cutoff = now - SEND_WINDOW_MS;
  let state = challenges.get(userId);
  if (!state) {
    if (challenges.size >= MAX_USERS) {
      for (const [id, prior] of challenges) {
        if (prior.sends.at(-1) <= cutoff) challenges.delete(id);
      }
      if (challenges.size >= MAX_USERS) return null;
    }
    state = { sends: [], pending: null };
    challenges.set(userId, state);
  }
  state.sends = state.sends.filter((time) => time > cutoff);
  const lastSend = state.sends.at(-1);
  if (state.sends.length >= MAX_SENDS || (lastSend !== undefined && now - lastSend < RESEND_INTERVAL_MS)) return null;
  state.sends.push(now);
  return state;
}

function codeHash(userId, email, session, code) {
  return createHmac('sha256', challengeKey)
    .update(JSON.stringify(['ddc-email-binding:v1', userId, email, session, code]))
    .digest();
}

async function sendBindingCode({ user, claims, rawEmail, getBinding, sendMail, now = Date.now() }) {
  if (!recentBindingSession(user, claims, now)) return recentRequired();
  const email = bindingEmail(rawEmail);
  if (!email) return error(400, 'INVALID_EMAIL', 'Enter a valid email address.');

  const bound = await getBinding(user.id);
  if (bound) return bound.email === email ? alreadyBound() : conflict();

  const state = beginSend(user.id, now);
  if (!state) return error(429, 'RATE_LIMITED', 'Too many email verification codes were requested.');

  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const pending = {
    email,
    session: claims.jti,
    hash: codeHash(user.id, email, claims.jti, code),
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    sent: false,
  };
  state.pending = pending;
  try {
    await sendMail(email, code);
    pending.sent = true;
  } catch {
    if (state.pending === pending) state.pending = null;
    return unavailable();
  }
  return accepted();
}

async function verifyBindingCode({ user, claims, rawEmail, rawCode, bindEmail, now = Date.now() }) {
  if (!recentBindingSession(user, claims, now)) return recentRequired();
  const email = bindingEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  const state = challenges.get(user.id);
  const pending = state?.pending;
  if (!email || !/^\d{6}$/.test(code) || !pending?.sent ||
      pending.email !== email || pending.session !== claims.jti) return invalidCode();
  if (pending.expiresAt <= now) {
    state.pending = null;
    return invalidCode();
  }
  if (!timingSafeEqual(pending.hash, codeHash(user.id, email, claims.jti, code))) {
    pending.attempts += 1;
    if (pending.attempts >= MAX_ATTEMPTS) state.pending = null;
    return invalidCode();
  }

  // Consume synchronously before any DB await. A database failure requires a fresh code.
  state.pending = null;
  const outcome = await bindEmail(user.id, email, claims);
  if (outcome === 'conflict') return conflict();
  if (outcome === 'recent_required') return recentRequired();
  return outcome === 'bound' ? success({ loginEmail: email }) : unavailable();
}

async function bindLoginEmail(db, userId, email, claims, now = Date.now()) {
  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true, authType: true, userType: true, isOrganization: true, disabledAt: true,
          web3authVerifier: true, web3authVerifierId: true, loginEmail: { select: { email: true } },
        },
      });
      if (!recentBindingSession(current, claims, now)) return 'recent_required';
      if (current.loginEmail) return current.loginEmail.email === email ? 'bound' : 'conflict';

      const legacyOwner = await tx.user.findFirst({
        where: { id: { not: userId }, email: { equals: email, mode: 'insensitive' } },
        select: { id: true },
      });
      if (legacyOwner) return 'conflict';

      // Primary and unique keys enforce first-bind-only and one owner even with concurrent sends.
      await tx.userLoginEmail.create({ data: { userId, email } });
      return 'bound';
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    if (err?.code === 'P2002' || err?.code === 'P2034') return 'conflict';
    throw err;
  }
}

module.exports = { emailBindingEnabled, bindingClaims, reauthBindingSession, sendBindingCode, verifyBindingCode, bindLoginEmail };
