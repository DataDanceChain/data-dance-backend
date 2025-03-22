const jwt = require('jsonwebtoken');

/**
 * 生成 JWT token
 * @param {string} id 用户ID
 * @returns {string} JWT token
 */
exports.generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN
  });
}; 