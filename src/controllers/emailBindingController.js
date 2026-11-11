const prisma = require('../utils/prisma');
const { sendBindingCodeEmail } = require('../utils/email');
const { createLogger } = require('../utils/logger');
const { generateToken } = require('../utils/jwtUtils');
const provider = require('../services/web3authIdentity');
const { emailBindingEnabled, reauthBindingSession, sendBindingCode, verifyBindingCode, bindLoginEmail } = require('../services/emailBinding');

const logger = createLogger('emailBinding');
const getBinding = (userId) => prisma.userLoginEmail.findUnique({ where: { userId }, select: { email: true } });

function bindingEndpoint(operation) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!emailBindingEnabled()) {
      return res.status(404).json({ status: 'fail', code: 'EMAIL_BINDING_UNAVAILABLE', message: 'Email binding is not available.' });
    }
    try {
      const result = await operation(req);
      return res.status(result.status).json(result.body);
    } catch (err) {
      logger.error('email_binding_failed', { name: err?.name });
      return res.status(503).json({ status: 'error', code: 'EMAIL_BINDING_UNAVAILABLE', message: 'Email binding is temporarily unavailable.' });
    }
  };
}

exports.getEmailBinding = bindingEndpoint(async (req) => {
  const bound = await getBinding(req.user.id);
  return { status: 200, body: { status: 'success', data: { loginEmail: bound?.email ?? null } } };
});

exports.reauthEmailBinding = bindingEndpoint((req) => reauthBindingSession({
  user: req.user,
  idToken: req.body?.idToken,
  walletAddress: req.body?.walletAddress,
  provider,
  issueToken: generateToken,
}));

exports.sendEmailBindingCode = bindingEndpoint((req) => sendBindingCode({
  user: req.user,
  claims: req.authClaims,
  rawEmail: req.body?.email,
  getBinding,
  sendMail: sendBindingCodeEmail,
}));

exports.verifyEmailBindingCode = bindingEndpoint((req) => verifyBindingCode({
  user: req.user,
  claims: req.authClaims,
  rawEmail: req.body?.email,
  rawCode: req.body?.code,
  bindEmail: (userId, email, claims) => bindLoginEmail(prisma, userId, email, claims),
}));
