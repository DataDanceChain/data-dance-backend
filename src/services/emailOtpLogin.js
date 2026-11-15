const crypto = require('crypto');
const { normalizeEmail, isValidEmail } = require('../utils/emailMask');
const { generateToken } = require('../utils/jwtUtils');
const { withDisplayReferralCode } = require('../utils/referralCodeFormat');

// Temporary door while Web3Auth login is paused. EMAIL_OTP_LOGIN must be exactly "true".
// An unknown mailbox can open an account with no wallet. Web3Auth login later attaches
// its proven key only to that empty row. Turn the switch off when the usual sign-in works.

const EMAIL_OTP_AUTH_TYPE = 'email_otp';

// App Store review uses this mailbox and code. No message is sent. The account stays an
// email-code account with no wallet, and the pair never signs in any other address.
const APP_REVIEW_EMAIL = 'app-review@datadance.ai';
const APP_REVIEW_CODE = '740258';

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
 * A code goes to an existing mailbox, or opens a new account when the address is unused.
 * X logins are skipped: that column often holds a verifier id, not an inbox.
 * A disabled account is skipped and is not replaced by a new row.
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

function isAppReviewLogin(email, code) {
  if (email !== APP_REVIEW_EMAIL || typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  const left = Buffer.from(code);
  const right = Buffer.from(APP_REVIEW_CODE);
  return hashesMatch(left, right);
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
  if (email === APP_REVIEW_EMAIL) return { status: 200, body: ACCEPTED };

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
  const rows = Array.isArray(users) ? users : [];
  // Two rows that differ only by case cannot be told apart. Say nothing and send nothing.
  if (rows.length > 1) return { status: 200, body: ACCEPTED };
  const match = rows.length === 1 ? rows[0] : null;
  let pendingEntry = { register: true };
  if (match) {
    if (!eligibleUser(match) || normalizeEmail(match.email) !== email) {
      // Same accepted body as a real send. The address is not told whether an account exists.
      return { status: 200, body: ACCEPTED };
    }
    pendingEntry = { register: false, userId: match.id };
  }

  const code = randomCode();
  try {
    await sendMail(email, code);
  } catch {
    return unavailable();
  }

  pending.set(email, {
    ...pendingEntry,
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

function sessionFor(user) {
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

async function verifyEmailLoginCode({
  email: rawEmail,
  code: rawCode,
  now = Date.now(),
  env = process.env,
  findUserById,
  createUser,
  openReviewUser,
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

  if (isAppReviewLogin(email, code)) {
    if (typeof openReviewUser !== 'function') return invalidCode();
    let reviewUser;
    try {
      reviewUser = await openReviewUser(email);
    } catch {
      return unavailable();
    }
    // A real account that already has a key, or was not opened by this door, is left alone.
    if (
      !reviewUser
      || !eligibleUser(reviewUser)
      || normalizeEmail(reviewUser.email) !== email
      || reviewUser.authType !== EMAIL_OTP_AUTH_TYPE
      || reviewUser.walletAddress
    ) {
      return invalidCode();
    }
    return sessionFor(reviewUser);
  }

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
    if (entry.register) {
      if (typeof createUser !== 'function') return unavailable();
      user = await createUser(email);
    } else {
      user = await findUserById(entry.userId);
    }
  } catch {
    return unavailable();
  }
  if (!eligibleUser(user) || normalizeEmail(user.email) !== email) return invalidCode();
  if (!entry.register && user.id !== entry.userId) return invalidCode();

  return sessionFor(user);
}

module.exports = {
  EMAIL_OTP_AUTH_TYPE,
  APP_REVIEW_EMAIL,
  APP_REVIEW_CODE,
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
