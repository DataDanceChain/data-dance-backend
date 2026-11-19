const host = require('../services/developerHostAuth');
const { withoutUserSecrets } = require('../utils/userSecretFields');
const { protect } = require('./authMiddleware');
const { OpsError } = require('../services/opsAudit');
const { classifyAuthError } = require('./authErrors');
function bearer(req) { const match = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || '')); return match ? match[1] : null; }
function sendError(res, error) {
  if (error instanceof OpsError) return res.status(error.status).json({ error: error.code, error_description: error.message });
  if (classifyAuthError(error) === 'db_unavailable' || error.code === 'P2010' && error.meta?.code === '55P03') return res.status(503).set('Retry-After', '5').json({ error: 'temporarily_unavailable' });
  return res.status(500).json({ error: 'server_error' });
}
async function protectHost(req, res, next) {
  try {
    const token = bearer(req), context = await host.current(token);
    req.user = withoutUserSecrets(context.user); req.authClaims = context.authClaims;
    req.developerHost = { token, context }; return next();
  } catch (error) { return sendError(res, error); }
}
/** Only explicitly owned developer routes use this. Never install it on staff/ops/user routers. */
function protectOwnedDeveloper(req, res, next) {
  return /^dhs_/.test(bearer(req) || '') ? protectHost(req, res, next) : protect(req, res, next);
}
module.exports = { bearer, sendError, protectHost, protectOwnedDeveloper };
