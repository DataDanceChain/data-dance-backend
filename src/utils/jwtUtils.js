const jwt = require('jsonwebtoken');

// D12: an unset JWT_EXPIRES_IN would mean non-expiring session tokens. Fail at boot in production.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_EXPIRES_IN) {
  throw new Error(
    'JWT_EXPIRES_IN must be set when NODE_ENV=production (unset = non-expiring session tokens). Example: JWT_EXPIRES_IN=7d'
  );
}

/**
 * 生成 JWT token
 * @param {string} id 用户ID
 * @param {object} [extra] additional claims (e.g. `{ ver: 2 }` for sessions minted from a verified Web3Auth ID token)
 * @returns {string} JWT token
 */
exports.generateToken = (id, extra = {}) => {
  return jwt.sign({ ...extra, id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN
  });
};
