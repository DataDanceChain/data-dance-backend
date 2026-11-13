const prisma = require('../utils/prisma');
const { sendLoginCodeEmail } = require('../utils/email');
const { requestEmailLoginCode, verifyEmailLoginCode } = require('../services/emailOtpLogin');
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

exports.sendEmailCode = async (req, res) => {
  try {
    const result = await requestEmailLoginCode({
      email: req.body && req.body.email,
      findUsersByEmail,
      sendMail: sendLoginCodeEmail,
    });
    return respond(res, result);
  } catch {
    return fail(res);
  }
};

exports.verifyEmailCode = async (req, res) => {
  try {
    const result = await verifyEmailLoginCode({
      email: req.body && req.body.email,
      code: req.body && req.body.code,
      findUserById,
    });
    return respond(res, result);
  } catch {
    return fail(res);
  }
};
