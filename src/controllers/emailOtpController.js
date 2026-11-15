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
      findUserById,
      createUser: createEmailOtpUser,
      openReviewUser,
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return fail(res, error, 'email_otp_verify_failed');
  }
};
