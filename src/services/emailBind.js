const crypto = require('crypto');
const { isMailbox, normalizeEmail } = require('../utils/emailMask');
const { APP_REVIEW_EMAIL } = require('./emailOtpLogin');

// A Web3Auth sign-in that did not prove a mailbox can ask the holder to type one.
// The address is stored only after this code is verified. Login codes live in a
// different map and hash, so one cannot be reused as the other.

const { createEmailChallengeState, CODE_TTL_MS, RESEND_INTERVAL_MS, MAX_SENDS_PER_HOUR, MAX_ATTEMPTS } = require('./emailChallengeState');
const challenge = createEmailChallengeState('bind');
const NAME_MAX = 80;

const ACCEPTED = { status: 'success', data: { accepted: true } };

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function resetEmailBindState() {
  challenge.reset();
}

function publicUser(user) {
  if (!user) return user;
  const { password, privateKey, xAccessToken, xRefreshToken, ...rest } = user;
  return rest;
}

function cleanName(name) {
  const value = String(name || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return value.slice(0, NAME_MAX);
}

function fail(status, reason, code, message) {
  return { status, reason, body: { status: 'fail', code, message } };
}

function limited(retryAfter) {
  return {
    status: 429,
    reason: 'address_throttled',
    body: {
      status: 'error',
      code: 'RATE_LIMITED',
      message: 'Too many codes were requested. Please try again later.',
      retryAfter,
    },
  };
}

function unavailable(reason) {
  return {
    status: 503,
    reason,
    body: {
      status: 'error',
      code: 'EMAIL_BIND_UNAVAILABLE',
      message: 'Email verification is temporarily unavailable.',
    },
  };
}

function pendingKey(userId, email) {
  return `${userId}:${email}`;
}

function mailFailureReason(error) {
  if (error?.code === 'EMAIL_DISABLED') return 'smtp_configuration_missing';
  if (error?.code === 'EAUTH') return 'smtp_authentication_failed';
  const responseCode = error?.responseCode;
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode < 600) return 'smtp_provider_refused';
  return 'smtp_send_failed';
}

/**
 * @param user the signed-in account that still has no mailbox
 * @param findOtherUsers async (email, userId) => users who already hold that mailbox
 */
async function requestEmailBindCode({
  user,
  email: rawEmail,
  now = Date.now(),
  sendMail,
  randomCode = newCode,
}) {
  if (!user || user.disabledAt) {
    return fail(403, 'account_unavailable', 'ACCOUNT_DISABLED', 'This account has been disabled.');
  }
  if (isMailbox(user.email)) {
    return fail(409, 'already_bound', 'EMAIL_ALREADY_BOUND', 'This account already has an email address.');
  }
  const email = normalizeEmail(rawEmail);
  if (!isMailbox(email)) {
    return fail(400, 'invalid_email', 'INVALID_EMAIL', 'Enter a valid email address.');
  }
  // The review mailbox stays the review account. Do not mail it a bind code.
  if (email === APP_REVIEW_EMAIL) {
    return fail(409, 'email_in_use', 'EMAIL_IN_USE', 'This email address is already registered to another account.');
  }

  const started = Date.now();
  const retryAfter = await challenge.reserveSend(email, now);
  if (retryAfter) return limited(retryAfter);

  const code = randomCode();
  const digest = challenge.digest(pendingKey(user.id, email), code);
  try {
    await sendMail(email, code);
  } catch (error) {
    return unavailable(mailFailureReason(error));
  }

  const saved = await challenge.saveDelivered(pendingKey(user.id, email), digest, {}, now, now + (Date.now() - started));
  if (!saved) return unavailable('delivery_superseded_or_expired');
  return { status: 200, reason: 'accepted', body: ACCEPTED };
}

async function verifyEmailBindCode({
  user,
  email: rawEmail,
  code: rawCode,
  name,
  now = Date.now(),
  findOtherUsers,
  saveBinding,
}) {
  if (!user || user.disabledAt) {
    return fail(403, 'account_unavailable', 'ACCOUNT_DISABLED', 'This account has been disabled.');
  }
  if (isMailbox(user.email)) {
    return fail(409, 'already_bound', 'EMAIL_ALREADY_BOUND', 'This account already has an email address.');
  }
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || '').trim();
  if (!isMailbox(email) || !/^\d{6}$/.test(code)) {
    return fail(401, 'invalid_code', 'EMAIL_CODE_INVALID', 'That code is incorrect or has expired.');
  }

  const key = pendingKey(user.id, email);
  const started = Date.now();
  const entry = await challenge.check(key, code, now, false);
  if (!entry) return fail(401, 'invalid_code', 'EMAIL_CODE_INVALID', 'That code is incorrect or has expired.');

  let others = [];
  try {
    others = await findOtherUsers(email, user.id);
  } catch {
    return unavailable('db_lookup_failed');
  }
  const consumed = await challenge.consumeChecked(key, entry.issuedAt, now + (Date.now() - started));
  if (!consumed) return fail(401, 'invalid_code', 'EMAIL_CODE_INVALID', 'That code is incorrect or has expired.');
  if (Array.isArray(others) && others.length > 0) {
    return fail(409, 'email_in_use', 'EMAIL_IN_USE', 'This email address is already registered to another account.');
  }

  let saved;
  try {
    saved = await saveBinding(user, email, cleanName(name));
  } catch {
    return unavailable('db_update_failed');
  }
  if (!saved) {
    return fail(409, 'bind_race', 'EMAIL_ALREADY_BOUND', 'This account already has an email address.');
  }
  return {
    status: 200,
    reason: 'verified',
    body: { status: 'success', data: { user: publicUser(saved) } },
  };
}

module.exports = {
  requestEmailBindCode,
  verifyEmailBindCode,
  resetEmailBindState,
  CODE_TTL_MS,
  RESEND_INTERVAL_MS,
  MAX_SENDS_PER_HOUR,
  MAX_ATTEMPTS,
};
