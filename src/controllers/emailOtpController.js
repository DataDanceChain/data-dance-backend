const prisma = require('../utils/prisma');
const { sendLoginCodeEmail } = require('../utils/email');
const { requestEmailLoginCode, verifyEmailLoginCode } = require('../services/emailOtpLogin');
const { createLogger } = require('../utils/logger');

const logger = createLogger('emailOtp');

function findUsersByEmail(email) {
  return prisma.$transaction(async (tx) => {
    const bound = await tx.userLoginEmail.findUnique({ where: { email }, include: { user: true } });
    if (bound) {
      return [{ ...bound.user, loginEmail: { email: bound.email, verifiedAt: bound.verifiedAt } }];
    }
    return tx.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      take: 2,
    });
  }, { isolationLevel: 'RepeatableRead' });
}

function fail(res, error, event) {
  logger.error(event, { name: error && error.name });
  return res.status(500).json({ status: 'error', message: 'Server error' });
}

exports.sendEmailCode = async (req, res) => {
  try {
    const result = await requestEmailLoginCode({
      email: req.body && req.body.email,
      findUsersByEmail,
      sendMail: sendLoginCodeEmail,
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return fail(res, error, 'email_otp_send_failed');
  }
};

exports.verifyEmailCode = async (req, res) => {
  try {
    const result = await verifyEmailLoginCode({
      email: req.body && req.body.email,
      code: req.body && req.body.code,
      findUsersByEmail,
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return fail(res, error, 'email_otp_verify_failed');
  }
};
