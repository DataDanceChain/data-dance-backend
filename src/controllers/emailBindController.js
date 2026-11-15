const prisma = require('../utils/prisma');
const { sendLoginCodeEmail } = require('../utils/email');
const { requestEmailBindCode, verifyEmailBindCode } = require('../services/emailBind');
const { createLogger } = require('../utils/logger');

const logger = createLogger('emailBind');

function findOtherUsers(email, userId) {
  return prisma.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: userId } },
    take: 2,
  });
}

async function saveBinding(user, email, name) {
  const updated = await prisma.user.updateMany({
    where: { id: user.id, email: user.email },
    data: { email, ...(name ? { name } : {}) },
  });
  if (updated.count !== 1) return null;
  return prisma.user.findUnique({ where: { id: user.id } });
}

function respond(res, userId, stage, result) {
  const level = result.status >= 500 ? 'error' : 'info';
  logger[level]('email_bind_result', { userId, stage, status: result.status, reason: result.reason });
  if (result.status === 429) res.set('Retry-After', String(result.body.retryAfter));
  return res.status(result.status).json(result.body);
}

exports.sendEmailBindCode = async (req, res) => {
  try {
    const result = await requestEmailBindCode({
      user: req.user,
      email: req.body && req.body.email,
      sendMail: sendLoginCodeEmail,
    });
    return respond(res, req.user && req.user.id, 'send', result);
  } catch {
    logger.error('email_bind_result', { userId: req.user && req.user.id, stage: 'send', reason: 'unexpected_failure' });
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.verifyEmailBindCode = async (req, res) => {
  try {
    const result = await verifyEmailBindCode({
      user: req.user,
      email: req.body && req.body.email,
      code: req.body && req.body.code,
      name: req.body && req.body.name,
      findOtherUsers,
      saveBinding,
    });
    return respond(res, req.user && req.user.id, 'verify', result);
  } catch {
    logger.error('email_bind_result', { userId: req.user && req.user.id, stage: 'verify', reason: 'unexpected_failure' });
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
