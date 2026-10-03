const jwt = require('jsonwebtoken');

const OPS_TOKEN_TYPE = 'ops_admin';

/**
 * Require a valid ops admin JWT (from POST /api/ops/auth/login).
 */
function protectOps(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ status: 'fail', message: 'Ops authentication required' });
    }
    const token = header.split(' ')[1];
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ status: 'error', message: 'JWT_SECRET is not configured' });
    }
    const decoded = jwt.verify(token, secret);
    if (decoded.type !== OPS_TOKEN_TYPE) {
      return res.status(403).json({ status: 'fail', message: 'Invalid ops token' });
    }
    req.opsAdmin = { username: decoded.sub, role: decoded.role === 'demo' ? 'demo' : 'admin' };
    next();
  } catch (error) {
    return res.status(401).json({
      status: 'fail',
      message: error.name === 'TokenExpiredError' ? 'Ops session expired' : 'Invalid ops token',
    });
  }
}

/** External demo sessions can read every ops page and cannot change anything. */
function restrictDemo(req, res, next) {
  if (req.opsAdmin?.role !== 'demo') return next();
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return res.status(403).json({
    status: 'fail',
    message: 'This demo account can view data but cannot change it',
  });
}

module.exports = { protectOps, restrictDemo, OPS_TOKEN_TYPE };
