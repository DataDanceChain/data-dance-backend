/**
 * E-mail one-time code (design §3.3, F8, F19; decision D15).
 *
 * startEmailChallenge  — POST /email/start
 *   1. emailGuard: normalise, syntax, disposable list, MX/A → INVALID_EMAIL.
 *   2. Turnstile per DDC_AUTH_TURNSTILE_MODE (never exempted by a client-claimed platform).
 *   3. Under pg_advisory_xact_lock(email), in one transaction:
 *        per-email hard ceiling (DDC_AUTH_OTP_EMAIL_CEILING_DAY per 24 h) → OTP_SEND_LIMITED
 *        slow path above DDC_AUTH_OTP_PER_EMAIL_HOUR / _DAY: a 60 s cooldown and a passing
 *          Turnstile token (even in mode `log`) — never a lock
 *        resend cooldown (DDC_AUTH_OTP_RESEND_SEC; 60 s on the slow path) → OTP_RESEND_TOO_SOON
          {retryAfterSec}; the answer's resendAfterSec is the cooldown the next send will face
 *        per-recipient-domain cap (200/h; the big consumer providers are exempt) → OTP_SEND_LIMITED
 *        global day: soft budget → error log + per-IP start limits halved; hard ceiling → 503
 *      then a NEW, independent challenge (random id; no superseding: a challenge is only ever
 *      closed by its own verify, TTL, lock or send failure, so nobody can invalidate another
 *      requester's code, F8a).
 *   4. Code = crypto.randomInt(0, 1e6), zero-padded; only codeHash = HMAC(stateKey('otp'),
 *      challengeId + ':' + code) is stored.
 *   5. Mail (10 s timeout). A failed send consumes the challenge and answers 503.
 *   The answer never depends on whether an account exists (no account is looked at).
 *
 * verifyEmailChallenge — POST /email/verify
 *   - The challenge must be open (unknown/consumed/expired → OTP_EXPIRED; locked → OTP_LOCKED).
 *   - Cross-challenge failure budget: after 30 wrong codes for one address in 24 h every further
 *     verify needs a passing Turnstile token (escalation, not a lock).
 *   - One atomic `attempts < max → attempts + 1` claim BEFORE comparing; a failed claim locks.
 *   - HMACs compared with timingSafeEqual; success sets consumedAt (single use, atomic).
 *   Returns the verified identity for identify.createLoginAttempt (BE6).
 *
 * Logs (createLogger('nativeAuth')) carry emailMasked and ipHash only: never the address, the code,
 * the code hash, or a Turnstile token.
 */
const crypto = require('crypto');
const { readNativeAuthConfig, stateHmac, hashIp } = require('./config');
const { NativeAuthError } = require('../../controllers/nativeAuth/respond');
const { maskEmail } = require('../../utils/emailMask');
const { createLogger } = require('../../utils/logger');
const emailGuard = require('./emailGuard');
const { turnstileCheck } = require('./turnstile');
const { normalizeAuthLocale } = require('../../i18n/authEmail');

const logger = createLogger('nativeAuth');

const CODE_LENGTH = 6;
const SLOW_PATH_COOLDOWN_SEC = 60;
const DOMAIN_CAP_PER_HOUR = 200;
const CROSS_CHALLENGE_FAILURES = 30;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Consumer mailbox providers whose volume is ordinary sign-in traffic: exempt from the per-domain
 * cap (a campaign day can bring more than 200 sign-ins an hour from gmail.com alone). Every other
 * domain — including a custom domain an attacker controls — is capped at DOMAIN_CAP_PER_HOUR.
 */
const DOMAIN_CAP_EXEMPT = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'gmx.de',
  'mail.ru', 'yandex.ru', 'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com',
  'sohu.com', 'aliyun.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'yahoo.co.jp',
  'docomo.ne.jp', 'ezweb.ne.jp', 'softbank.ne.jp', 'i.softbank.jp', 'yahoo.com.tw', 'hotmail.co.jp',
]);

function defaultDb() {
  return require('../../utils/prisma');
}

function defaultSend(...args) {
  return require('../../utils/email').sendLoginCodeEmail(...args);
}

function defaultSetTightened(value) {
  return require('../../middlewares/rateLimitMiddleware').setNativeOtpTightened(value);
}

function codeHash(challengeId, code, cfg) {
  return stateHmac('otp', `${challengeId}:${code}`, cfg);
}

function newCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function startOfUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function secondsUntil(date, now) {
  return Math.max(1, Math.ceil((date.getTime() - now.getTime()) / 1000));
}

function isLoopback(address) {
  const value = String(address || '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' || value.startsWith('127.');
}

/** A 64-bit advisory-lock key for one address (same address → same key, in every process). */
function emailLockKey(email) {
  return crypto.createHash('sha256').update(`ddc-native-otp:${email}`).digest().readBigInt64BE(0);
}

/**
 * The day's soft budget alarm fires once per UTC day per process; the per-IP tightening follows
 * the count on every start (so it lifts at midnight UTC by itself).
 */
let softAlarmDay = '';

function resetBudgetAlarm() {
  softAlarmDay = '';
}

/**
 * The per-email history the caps are computed from: every challenge for `email` in the last 24 h
 * (at most the ceiling, 50 by default, so this stays small).
 */
async function recentChallenges(db, email, now) {
  return db.authEmailChallenge.findMany({
    where: { email, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
    select: { id: true, createdAt: true, attempts: true, consumedAt: true, lockedAt: true },
  });
}

/** Wrong codes entered for this address in the last 24 h, across all its challenges. */
function failuresOf(rows) {
  return rows.reduce((sum, row) => sum + (row.attempts || 0) - (row.consumedAt && row.attempts > 0 ? 1 : 0), 0);
}

/**
 * Dev echo (DDC_AUTH_OTP_DEV_ECHO): the code is logged instead of mailed. Legal only with
 * DDC_AUTH_ENV=local and SMTP_HOST unset (boot refuses anything else); at send time it also
 * requires that the request arrived on a loopback socket, so a server reachable from elsewhere
 * never echoes codes. Outside those conditions the send is treated as unavailable (503).
 */
function devEchoAllowed(cfg, env, localAddress) {
  return cfg.otp.devEcho && cfg.env === 'local' && !String(env.SMTP_HOST || '').trim() && isLoopback(localAddress);
}

/**
 * POST /email/start. `request` = { ip, userAgent, country, localAddress } from the HTTP request.
 * Returns { challengeId, expiresInSec, resendAfterSec, codeLength } or throws NativeAuthError.
 */
async function startEmailChallenge({
  email: rawEmail,
  locale,
  turnstileToken,
  request = {},
  now = new Date(),
  db = defaultDb(),
  cfg = readNativeAuthConfig(),
  env = process.env,
  guard = emailGuard.guardEmail,
  send = defaultSend,
  setTightened = defaultSetTightened,
  fetchImpl,
}) {
  const otp = cfg.otp;
  // 1. Address.
  const { email, domain } = await guard(rawEmail);
  const emailMasked = maskEmail(email);
  const ipHash = request.ip ? hashIp(request.ip, cfg) : null;

  // 2. Turnstile, redeemed at most once per request and BEFORE the transaction (the slow-path
  // check inside reuses the answer, so no network call ever runs while the lock is held).
  const ts = turnstileCheck({ cfg, token: turnstileToken, remoteip: request.ip, fetchImpl, context: 'email_start' });
  const tsPassed = ts.mode !== 'off' && ts.present ? await ts.passed() : false; // `log`: failure logged, not enforced
  if (ts.mode === 'enforce' && !tsPassed) throw new NativeAuthError('TURNSTILE_FAILED');

  // 3–4. Caps and the new challenge, atomically per address.
  const challengeId = crypto.randomUUID();
  const code = newCode();
  const lang = normalizeAuthLocale(locale);
  const decision = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${emailLockKey(email)})`;
    const rows = await recentChallenges(tx, email, now);

    if (rows.length >= otp.emailCeilingDay) {
      const oldest = rows.reduce((min, row) => (row.createdAt < min ? row.createdAt : min), rows[0].createdAt);
      throw new NativeAuthError('OTP_SEND_LIMITED', { data: { retryAfterSec: secondsUntil(new Date(oldest.getTime() + DAY_MS), now) } });
    }
    const hourCount = rows.filter((row) => row.createdAt.getTime() >= now.getTime() - HOUR_MS).length;
    const slow = hourCount >= otp.perEmailHour || rows.length >= otp.perEmailDay;
    const cooldownSec = slow ? Math.max(otp.resendSec, SLOW_PATH_COOLDOWN_SEC) : otp.resendSec;
    const last = rows.reduce((max, row) => (!max || row.createdAt > max ? row.createdAt : max), null);
    if (last && now.getTime() - last.getTime() < cooldownSec * 1000) {
      throw new NativeAuthError('OTP_RESEND_TOO_SOON', { data: { retryAfterSec: secondsUntil(new Date(last.getTime() + cooldownSec * 1000), now) } });
    }
    // Slow path: a passing Turnstile token even where the mode is `log`. With Turnstile off
    // (local/test only; boot requires enforce in prod) the cooldown alone applies.
    if (slow && ts.mode !== 'off' && !tsPassed) {
      throw new NativeAuthError('TURNSTILE_FAILED', { data: { reason: 'slow_path' } });
    }

    if (!DOMAIN_CAP_EXEMPT.has(domain)) {
      const domainCount = await tx.authEmailChallenge.count({
        where: { email: { endsWith: `@${domain}` }, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
      });
      if (domainCount >= DOMAIN_CAP_PER_HOUR) {
        logger.warn('native_auth.otp_domain_capped', { domain, ipHash });
        throw new NativeAuthError('OTP_SEND_LIMITED', { data: { retryAfterSec: 15 * 60 } });
      }
    }

    const today = await tx.authEmailChallenge.count({ where: { createdAt: { gte: startOfUtcDay(now) } } });
    if (today >= otp.hardCeiling) {
      logger.error('native_auth.otp_budget_hard', { count: today, ceiling: otp.hardCeiling });
      throw new NativeAuthError('OTP_SEND_UNAVAILABLE');
    }

    await tx.authEmailChallenge.create({
      data: {
        id: challengeId,
        email,
        codeHash: codeHash(challengeId, code, cfg),
        locale: lang,
        ipHash,
        expiresAt: new Date(now.getTime() + otp.ttlSec * 1000),
        createdAt: now,
      },
    });
    // The client's resend countdown: the cooldown the NEXT send will face, counting this one.
    const slowNext = hourCount + 1 >= otp.perEmailHour || rows.length + 1 >= otp.perEmailDay;
    const nextCooldownSec = slowNext ? Math.max(otp.resendSec, SLOW_PATH_COOLDOWN_SEC) : otp.resendSec;
    return { slow, resendAfterSec: nextCooldownSec, todayAfter: today + 1 };
  }, { maxWait: 5000, timeout: 10000 });

  // Soft budget: an error log once per day, and the per-IP start limits halved while above it.
  const overSoft = decision.todayAfter >= otp.softBudget;
  setTightened(overSoft);
  const day = startOfUtcDay(now).toISOString().slice(0, 10);
  if (overSoft && softAlarmDay !== day) {
    softAlarmDay = day;
    logger.error('native_auth.otp_budget_soft', { count: decision.todayAfter, budget: otp.softBudget });
  }

  // 5. Deliver.
  const context = { ttlMinutes: Math.ceil(otp.ttlSec / 60), userAgent: request.userAgent, country: request.country };
  try {
    if (otp.devEcho) {
      if (!devEchoAllowed(cfg, env, request.localAddress)) {
        const err = new Error('dev echo refused: DDC_AUTH_ENV=local, SMTP_HOST unset and a loopback listener are all required');
        err.code = 'DEV_ECHO_REFUSED';
        throw err;
      }
      logger.warn(`native_auth.otp_dev_echo ${emailMasked} code ${code} (DDC_AUTH_OTP_DEV_ECHO, local only)`);
    } else {
      await send(email, code, lang, context);
    }
  } catch (err) {
    await db.authEmailChallenge.updateMany({ where: { id: challengeId, consumedAt: null }, data: { consumedAt: new Date() } });
    logger.error('native_auth.otp_send_failed', { emailMasked, ipHash, reason: String((err && err.code) || 'error') });
    throw new NativeAuthError('OTP_SEND_UNAVAILABLE');
  }
  logger.info('native_auth.otp_sent', { emailMasked, ipHash, locale: lang, slowPath: decision.slow });

  return {
    challengeId,
    expiresInSec: otp.ttlSec,
    resendAfterSec: decision.resendAfterSec,
    codeLength: CODE_LENGTH,
  };
}

function hmacEqual(expectedHex, presentedHex) {
  const a = Buffer.from(String(expectedHex), 'utf8');
  const b = Buffer.from(String(presentedHex), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function lockChallenge(db, id, now) {
  await db.authEmailChallenge.updateMany({ where: { id, lockedAt: null }, data: { lockedAt: now } });
}

/**
 * POST /email/verify. Returns { email, challengeId } for identify, or throws NativeAuthError
 * (OTP_EXPIRED, OTP_LOCKED, OTP_INVALID {attemptsLeft}, TURNSTILE_FAILED).
 */
async function verifyEmailChallenge({
  challengeId,
  code,
  turnstileToken,
  request = {},
  now = new Date(),
  db = defaultDb(),
  cfg = readNativeAuthConfig(),
  fetchImpl,
}) {
  const max = cfg.otp.maxAttempts;
  if (typeof challengeId !== 'string' || !UUID_PATTERN.test(challengeId)) throw new NativeAuthError('OTP_EXPIRED');
  const id = challengeId.toLowerCase();
  const row = await db.authEmailChallenge.findUnique({ where: { id } });
  if (!row || row.consumedAt || row.expiresAt <= now) throw new NativeAuthError('OTP_EXPIRED');
  if (row.lockedAt) throw new NativeAuthError('OTP_LOCKED');
  const emailMasked = maskEmail(row.email);
  const ipHash = request.ip ? hashIp(request.ip, cfg) : null;

  // Cross-challenge failure budget: escalate to Turnstile, never lock the owner out.
  if (cfg.turnstile.mode !== 'off') {
    const failures = failuresOf(await recentChallenges(db, row.email, now));
    if (failures >= CROSS_CHALLENGE_FAILURES) {
      const ts = turnstileCheck({ cfg, token: turnstileToken, remoteip: request.ip, fetchImpl, context: 'email_verify' });
      if (!(await ts.passed())) throw new NativeAuthError('TURNSTILE_FAILED', { data: { reason: 'too_many_failures' } });
    }
  }

  // Claim one attempt atomically before comparing anything.
  const claim = await db.authEmailChallenge.updateMany({
    where: { id, consumedAt: null, lockedAt: null, expiresAt: { gt: now }, attempts: { lt: max } },
    data: { attempts: { increment: 1 } },
  });
  if (claim.count === 0) {
    const current = await db.authEmailChallenge.findUnique({ where: { id } });
    if (!current || current.consumedAt || current.expiresAt <= now) throw new NativeAuthError('OTP_EXPIRED');
    await lockChallenge(db, id, now);
    logger.warn('native_auth.otp_locked', { emailMasked, ipHash });
    throw new NativeAuthError('OTP_LOCKED');
  }

  const wellFormed = typeof code === 'string' && /^\d{6}$/.test(code);
  const presented = codeHash(id, wellFormed ? code : 'x', cfg);
  if (!wellFormed || !hmacEqual(row.codeHash, presented)) {
    const after = await db.authEmailChallenge.findUnique({ where: { id } });
    const attemptsLeft = Math.max(0, max - ((after && after.attempts) || max));
    if (attemptsLeft === 0) {
      await lockChallenge(db, id, now);
      logger.warn('native_auth.otp_locked', { emailMasked, ipHash });
      throw new NativeAuthError('OTP_LOCKED');
    }
    logger.info('native_auth.otp_verify_failed', { emailMasked, ipHash, attemptsLeft });
    throw new NativeAuthError('OTP_INVALID', { data: { attemptsLeft } });
  }

  const consumed = await db.authEmailChallenge.updateMany({
    where: { id, consumedAt: null, lockedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) throw new NativeAuthError('OTP_EXPIRED');
  logger.info('native_auth.otp_verified', { emailMasked, ipHash });
  return { email: row.email, challengeId: id };
}

/** The identity an OTP-verified address hands to identify (§3.6: provider email, grade strong). */
function emailIdentity(email) {
  return { provider: 'email', subject: email, email, emailVerified: true };
}

module.exports = {
  CODE_LENGTH,
  SLOW_PATH_COOLDOWN_SEC,
  DOMAIN_CAP_PER_HOUR,
  DOMAIN_CAP_EXEMPT,
  CROSS_CHALLENGE_FAILURES,
  codeHash,
  emailLockKey,
  failuresOf,
  devEchoAllowed,
  resetBudgetAlarm,
  startEmailChallenge,
  verifyEmailChallenge,
  emailIdentity,
};
