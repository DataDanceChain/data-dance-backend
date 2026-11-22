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
  res.once('finish', () => {
    const status = res.statusCode;
    const reason = res.locals.emailOtpReason ?? (status === 429 ? 'request_throttled' : 'unexpected_failure');
    const level = status >= 500 ? 'error' : 'info';
    logger[level]('email_otp_result', { reqId: req.reqId, stage, status, reason });
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

function sendCode(existingAccountOnly) {
  return async (req, res) => {
    try {
      const result = await requestEmailLoginCode({
        email: req.body && req.body.email,
        existingAccountOnly,
        findUsersByEmail,
        sendMail: sendLoginCodeEmail,
      });
      return respond(res, result);
    } catch {
      return fail(res);
    }
  };
}

function verifyCode(existingAccountOnly) {
  return async (req, res) => {
    try {
      const result = await verifyEmailLoginCode({
        email: req.body && req.body.email,
        code: req.body && req.body.code,
        existingAccountOnly,
        findUsersByEmail,
        findUserById,
        createUser: existingAccountOnly ? undefined : createEmailOtpUser,
        openReviewUser: existingAccountOnly ? undefined : openReviewUser,
      });
      return respond(res, result);
    } catch {
      return fail(res);
    }
  };
}

exports.sendEmailCode = sendCode(false);
exports.verifyEmailCode = verifyCode(false);
exports.sendRecoveryEmailCode = sendCode(true);
exports.verifyRecoveryEmailCode = verifyCode(true);
