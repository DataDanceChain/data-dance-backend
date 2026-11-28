const prisma = require('../utils/prisma');
const { sendLoginCodeEmail } = require('../utils/email');
const { generateUniqueReferralCode } = require('../utils/referralUtils');
const {
  EMAIL_OTP_AUTH_TYPE,
  eligibleUser,
  requestEmailLoginCode,
  verifyEmailLoginCode,
} = require('../services/emailOtpLogin');
const { normalizeEmail } = require('../utils/emailMask');
const { createLogger } = require('../utils/logger');
const { performance } = require('node:perf_hooks');

const logger = createLogger('emailOtp');

function findUsersByEmail(email) {
  return prisma.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    take: 2,
  });
}

function findUserById(id) {
  return prisma.user.findUnique({ where: { id } });
}

async function openReviewUser(email) {
  const rows = await findUsersByEmail(email);
  if (rows.length > 1) return null;
  if (rows.length === 1) return rows[0];
  return createEmailOtpUser(email);
}

async function createEmailOtpUser(email) {
  const referralCode = await generateUniqueReferralCode();
  try {
    return await prisma.user.create({
      data: {
        email,
        name: email.split('@')[0],
        authType: EMAIL_OTP_AUTH_TYPE,
        userType: 'regular',
        referralCode,
        profile: { create: { language: 'en' } },
      },
    });
  } catch (error) {
    if (!error || error.code !== 'P2002') throw error;
    const rows = await findUsersByEmail(email);
    const match = rows.length === 1 ? rows[0] : null;
    if (match && eligibleUser(match) && normalizeEmail(match.email) === email) return match;
    return null;
  }
}

// Observe the route's actual result, including 429 responses produced before the handler.
exports.observeEmailOtp = (stage) => (req, res, next) => {
  // Untrusted correlation hint only; reqId remains the server-owned request identity.
  const flow = req.body?.flow;
  const hasFlow = typeof flow === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(flow);
  const trace = { reqId: req.reqId, stage, ...(hasFlow ? { flow } : {}) };
  if (hasFlow) {
    logger.info('email_otp_received', trace);
    res.once('close', () => {
      if (!res.writableFinished) logger.info('email_otp_disconnected', trace);
    });
  }
  res.once('finish', () => {
    const status = res.statusCode;
    const reason = res.locals.emailOtpReason ?? (status === 429 ? 'request_throttled' : 'unexpected_failure');
    const level = status >= 500 ? 'error' : 'info';
    logger[level]('email_otp_result', { ...trace, status, reason });
  });
  next();
};

function respond(res, result) {
  res.locals.emailOtpReason = result.reason;
  if (result.status === 429) res.set('Retry-After', String(result.body.retryAfter));
  return res.status(result.status).json(result.body);
}

function fail(res) {
  res.locals.emailOtpReason = 'unexpected_failure';
  return res.status(500).json({ status: 'error', message: 'Server error' });
}

exports.sendEmailCode = async (req, res) => {
  const timings = {};
  async function measure(key, operation, ...args) {
    const start = performance.now();
    try {
      return await operation(...args);
    } finally {
      timings[key] = Math.round(performance.now() - start);
    }
  }
  try {
    const result = await requestEmailLoginCode({
      email: req.body && req.body.email,
      findUsersByEmail: (email) => measure('lookupMs', findUsersByEmail, email),
      sendMail: (email, code) => measure('smtpAcceptMs', sendLoginCodeEmail, email, code),
    });
    return respond(res, result);
  } catch {
    return fail(res);
  } finally {
    if (Object.keys(timings).length) logger.info('email_otp_send_latency', { reqId: req.reqId, ...timings, reason: res.locals.emailOtpReason });
  }
};

exports.verifyEmailCode = async (req, res) => {
  try {
    const result = await verifyEmailLoginCode({
      email: req.body && req.body.email,
      code: req.body && req.body.code,
      findUserById,
      createUser: createEmailOtpUser,
      openReviewUser,
    });
    return respond(res, result);
  } catch {
    return fail(res);
  }
};
