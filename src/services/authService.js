const prisma = require('../utils/prisma');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createLogger } = require('../utils/logger');
const { xApiClient } = require('../utils/xClient');

const logger = createLogger('authService');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const {
  X_API_KEY,
  X_API_SECRET,
  X_BEARER_TOKEN,
  X_OAUTH_ACCESS_TOKEN,
  X_OAUTH_ACCESS_TOKEN_SECRET,
  X_OAUTH_CALLBACK_URL
} = process.env;

module.exports = {};
