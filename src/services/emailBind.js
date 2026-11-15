const crypto = require('crypto');
const { isMailbox, normalizeEmail } = require('../utils/emailMask');
const { APP_REVIEW_EMAIL } = require('./emailOtpLogin');

// A Web3Auth sign-in that did not prove a mailbox can ask the holder to type one.
// The address is stored only after this code is verified. Login codes live in a
// different map and hash, so one cannot be reused as the other.

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;
const NAME_MAX = 80;

const sendWindows = new Map();
const pending = new Map();

const ACCEPTED = { status: 'success', data: { accepted: true } };

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(email, code) {
  return crypto.createHash('sha256').update(`ddc-email-bind:v1:${email}:${code}`).digest();
}

function hashesMatch(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function resetEmailBindState() {
  sendWindows.clear();
  pending.clear();
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

  const gate = throttle(email, now);
  if (gate.limited) return limited(gate.retryAfter);
  gate.entry.timestamps.push(now);

  const code = randomCode();
  try {
    await sendMail(email, code);
  } catch (error) {
    return unavailable(mailFailureReason(error));
  }

  pending.set(pendingKey(user.id, email), {
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
  const entry = pending.get(key);
  if (!entry || entry.expiresAt <= now) {
    pending.delete(key);
    return fail(401, 'invalid_code', 'EMAIL_CODE_INVALID', 'That code is incorrect or has expired.');
  }
  entry.attempts += 1;
  const presented = hashCode(email, code);
  const matches = hashesMatch(entry.codeHash, presented);
  if (!matches || entry.attempts > MAX_ATTEMPTS) {
    if (entry.attempts >= MAX_ATTEMPTS) pending.delete(key);
    return fail(401, 'invalid_code', 'EMAIL_CODE_INVALID', 'That code is incorrect or has expired.');
  }

  let others = [];
  try {
    others = await findOtherUsers(email, user.id);
  } catch {
    return unavailable('db_lookup_failed');
  }
  if (Array.isArray(others) && others.length > 0) {
    pending.delete(key);
    return fail(409, 'email_in_use', 'EMAIL_IN_USE', 'This email address is already registered to another account.');
  }

  pending.delete(key);
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
