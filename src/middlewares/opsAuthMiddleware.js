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
    req.opsAdmin = { username: decoded.sub };
    next();
  } catch (error) {
    return res.status(401).json({
      status: 'fail',
      message: error.name === 'TokenExpiredError' ? 'Ops session expired' : 'Invalid ops token',
    });
  }
}

module.exports = { protectOps, OPS_TOKEN_TYPE };
