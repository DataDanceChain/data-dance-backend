const crypto = require('crypto');
const { normalizeEmail, isValidEmail } = require('../utils/emailMask');
const { generateToken } = require('../utils/jwtUtils');
const { withDisplayReferralCode } = require('../utils/referralCodeFormat');

// Temporary door while Web3Auth login is paused. EMAIL_OTP_LOGIN must be exactly "true".
// Turn it off when the usual sign-in works again. This does not create accounts.

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;

const sendWindows = new Map();
const pending = new Map();

const ACCEPTED = { status: 'success', data: { accepted: true } };
const INVALID_CODE = {
  status: 'fail',
  code: 'EMAIL_CODE_INVALID',
  message: 'That code is incorrect or has expired.',
};
const UNAVAILABLE = {
  status: 'error',
  code: 'EMAIL_LOGIN_UNAVAILABLE',
  message: 'Email sign-in is temporarily unavailable.',
};

function emailOtpEnabled(env = process.env) {
  return String(env.EMAIL_OTP_LOGIN || '').trim() === 'true';
}

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(email, code) {
  return crypto.createHash('sha256').update(`ddc-email-otp:v1:${email}:${code}`).digest();
}

function hashesMatch(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isTwitterVerifier(verifier) {
  const value = String(verifier || '').toLowerCase();
  return value.includes('twitter') || value === 'x' || value.includes('x.com');
}

/**
 * A code goes only to an existing account whose stored address is a mailbox.
 * X logins are skipped: that column often holds a verifier id, not an inbox.
 * No row is created.
 */
function eligibleUser(user) {
  if (!user || user.disabledAt) return false;
  const email = normalizeEmail(user.email);
  if (!email || email.length > 254 || !isValidEmail(email) || email.includes('|')) return false;
  if (isTwitterVerifier(user.web3authVerifier)) return false;
  return true;
}

function windowFor(email, now) {
  let entry = sendWindows.get(email);
  if (!entry) {
    entry = { timestamps: [] };
    sendWindows.set(email, entry);
  }
  entry.timestamps = entry.timestamps.filter((stamp) => now - stamp < HOUR_MS);
  if (sendWindows.size > 5000) {
    for (const [key, value] of sendWindows) {
      if (value.timestamps.length === 0) sendWindows.delete(key);
      if (sendWindows.size <= 4000) break;
    }
  }
  return entry;
}

function throttle(email, now) {
  const entry = windowFor(email, now);
  const last = entry.timestamps[entry.timestamps.length - 1];
  if (last !== undefined && now - last < RESEND_INTERVAL_MS) {
    return { limited: true, retryAfter: Math.max(1, Math.ceil((RESEND_INTERVAL_MS - (now - last)) / 1000)) };
  }
  if (entry.timestamps.length >= MAX_SENDS_PER_HOUR) {
    return { limited: true, retryAfter: Math.max(1, Math.ceil((entry.timestamps[0] + HOUR_MS - now) / 1000)) };
  }
  return { limited: false, entry };
}

function limitedBody(retryAfter) {
  return {
    status: 429,
    body: {
      status: 'error',
      code: 'RATE_LIMITED',
      message: 'Too many login codes were requested. Please try again later.',
      retryAfter,
    },
  };
}

function unavailable() {
  return { status: 503, body: UNAVAILABLE };
}

function invalidCode() {
  return { status: 401, body: INVALID_CODE };
}

function publicUser(user) {
  const {
    password,
    privateKey,
    xAccessToken,
    xRefreshToken,
    ...rest
  } = user;
  return withDisplayReferralCode(rest);
}

function resetEmailOtpState() {
  sendWindows.clear();
  pending.clear();
}

async function requestEmailLoginCode({
  email: rawEmail,
  now = Date.now(),
  env = process.env,
  findUsersByEmail,
  sendMail,
  randomCode = newCode,
}) {
  if (!emailOtpEnabled(env)) {
    return {
      status: 404,
      body: { status: 'fail', code: 'EMAIL_LOGIN_UNAVAILABLE', message: 'Email sign-in is not available.' },
    };
  }
  const email = normalizeEmail(rawEmail);
  if (!email || email.length > 254 || !isValidEmail(email)) {
    return { status: 400, body: { status: 'fail', code: 'INVALID_EMAIL', message: 'Enter a valid email address.' } };
  }

  const gate = throttle(email, now);
  if (gate.limited) return limitedBody(gate.retryAfter);
  // Count the attempt before any await so two clicks cannot both pass the gap.
  gate.entry.timestamps.push(now);

  let users = [];
  try {
    users = await findUsersByEmail(email);
  } catch {
    return unavailable();
  }
  const match = Array.isArray(users) && users.length === 1 ? users[0] : null;
  if (!match || !eligibleUser(match) || normalizeEmail(match.email) !== email) {
    // Same accepted body as a real send. The address is not told whether an account exists.
    return { status: 200, body: ACCEPTED };
  }

  const code = randomCode();
  try {
    await sendMail(email, code);
  } catch {
    return unavailable();
  }

  pending.set(email, {
    userId: match.id,
    codeHash: hashCode(email, code),
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
  });
  if (pending.size > 5000) {
    for (const [key, value] of pending) {
      if (value.expiresAt <= now) pending.delete(key);
      if (pending.size <= 4000) break;
    }
  }
  return { status: 200, body: ACCEPTED };
}

async function verifyEmailLoginCode({
  email: rawEmail,
  code: rawCode,
  now = Date.now(),
  env = process.env,
  findUserById,
}) {
  if (!emailOtpEnabled(env)) {
    return {
      status: 404,
      body: { status: 'fail', code: 'EMAIL_LOGIN_UNAVAILABLE', message: 'Email sign-in is not available.' },
    };
  }
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!email || !isValidEmail(email) || !/^\d{6}$/.test(code)) return invalidCode();

  const entry = pending.get(email);
  if (!entry || entry.expiresAt <= now) {
    pending.delete(email);
    return invalidCode();
  }
  entry.attempts += 1;
  const matched = hashesMatch(entry.codeHash, hashCode(email, code));
  if (!matched) {
    if (entry.attempts >= MAX_ATTEMPTS) pending.delete(email);
    return invalidCode();
  }
  pending.delete(email);

  let user;
  try {
    user = await findUserById(entry.userId);
  } catch {
    return unavailable();
  }
  if (!eligibleUser(user) || user.id !== entry.userId || normalizeEmail(user.email) !== email) {
    return invalidCode();
  }

  // ver:2 lets Planet and the other SSO hand-off accept the session while Web3Auth is down.
  // amr marks it so wallet rebinding, password changes, and X linking stay closed.
  const token = generateToken(user.id, { ver: 2, amr: 'email_otp' });
  return {
    status: 200,
    body: {
      status: 'success',
      data: {
        token,
        user: publicUser(user),
      },
    },
  };
}

module.exports = {
  emailOtpEnabled,
  eligibleUser,
  resetEmailOtpState,
  requestEmailLoginCode,
  verifyEmailLoginCode,
  CODE_TTL_MS,
  RESEND_INTERVAL_MS,
  MAX_SENDS_PER_HOUR,
  MAX_ATTEMPTS,
};
