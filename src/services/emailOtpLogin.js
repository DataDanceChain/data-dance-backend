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

const { createEmailChallengeState, CODE_TTL_MS, RESEND_INTERVAL_MS, MAX_SENDS_PER_HOUR, MAX_ATTEMPTS } = require('./emailChallengeState');
const challenge = createEmailChallengeState('login');

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

function limitedBody(retryAfter) {
  return {
    status: 429,
    reason: 'address_throttled',
    body: {
      status: 'error',
      code: 'RATE_LIMITED',
      message: 'Too many login codes were requested. Please try again later.',
      retryAfter,
    },
  };
}

function unavailable(reason) {
  return { status: 503, reason, body: UNAVAILABLE };
}

function invalidCode(reason = 'invalid_code') {
  return { status: 401, reason, body: INVALID_CODE };
}

function mailFailureReason(error) {
  if (error?.code === 'EMAIL_DISABLED') return 'smtp_configuration_missing';
  if (error?.code === 'EAUTH') return 'smtp_authentication_failed';
  const responseCode = error?.responseCode;
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode < 600) {
    return 'smtp_provider_refused';
  }
  return 'smtp_send_failed';
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
  challenge.reset();
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
      reason: 'feature_disabled',
      body: { status: 'fail', code: 'EMAIL_LOGIN_UNAVAILABLE', message: 'Email sign-in is not available.' },
    };
  }
  const email = normalizeEmail(rawEmail);
  if (!email || email.length > 254 || !isValidEmail(email)) {
    return { status: 400, reason: 'invalid_email', body: { status: 'fail', code: 'INVALID_EMAIL', message: 'Enter a valid email address.' } };
  }
  if (email === APP_REVIEW_EMAIL) return { status: 200, reason: 'accepted', body: ACCEPTED };

  const started = Date.now();
  const retryAfter = await challenge.reserveSend(email, now);
  if (retryAfter) return limitedBody(retryAfter);

  let users = [];
  try {
    users = await findUsersByEmail(email);
  } catch {
    return unavailable('db_lookup_failed');
  }
  const rows = Array.isArray(users) ? users : [];
  // Two rows that differ only by case cannot be told apart. Say nothing and send nothing.
  if (rows.length > 1) return { status: 200, reason: 'accepted', body: ACCEPTED };
  const match = rows.length === 1 ? rows[0] : null;
  let pendingEntry = { register: true };
  if (match) {
    if (!eligibleUser(match) || normalizeEmail(match.email) !== email) {
      // Same accepted body as a real send. The address is not told whether an account exists.
      return { status: 200, reason: 'accepted', body: ACCEPTED };
    }
    pendingEntry = { register: false, userId: match.id };
  }

  const code = randomCode();
  const digest = challenge.digest(email, code);
  try {
    await sendMail(email, code);
  } catch (error) {
    return unavailable(mailFailureReason(error));
  }

  const saved = await challenge.saveDelivered(email, digest, pendingEntry, now, now + (Date.now() - started));
  if (!saved) return unavailable('delivery_superseded_or_expired');
  return { status: 200, reason: 'accepted', body: ACCEPTED };
}

function sessionFor(user) {
  // ver:2 lets Planet and the other SSO hand-off accept the session while Web3Auth is down.
  // amr marks it so wallet rebinding, password changes, and X linking stay closed.
  const token = generateToken(user.id, { ver: 2, amr: 'email_otp' });
  return {
    status: 200,
    reason: 'verified',
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
      reason: 'feature_disabled',
      body: { status: 'fail', code: 'EMAIL_LOGIN_UNAVAILABLE', message: 'Email sign-in is not available.' },
    };
  }
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!email || !isValidEmail(email) || !/^\d{6}$/.test(code)) return invalidCode('invalid_input');

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

  const entry = await challenge.check(email, code, now, true);
  if (!entry) return invalidCode();

  let user;
  try {
    if (entry.register) {
      if (typeof createUser !== 'function') return unavailable();
      user = await createUser(email);
    } else {
      user = await findUserById(entry.userId);
    }
  } catch {
    return unavailable('db_lookup_failed');
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
