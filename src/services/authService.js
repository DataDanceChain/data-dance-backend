const prisma = require('../utils/prisma');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createLogger } = require('../utils/logger');
const { xApiClient } = require('../utils/xClient');

const logger = createLogger('authService');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET_KEY = process.env.X_API_SECRET_KEY;
const X_OAUTH_CALLBACK_URL = process.env.X_OAUTH_CALLBACK_URL;

module.exports = {};
