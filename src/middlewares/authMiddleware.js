const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { createLogger } = require('../utils/logger');
const {
  classifyAuthError,
  logAuthError,
  sendDatabaseUnavailable,
} = require('./authErrors');
const prisma = new PrismaClient();
const logger = createLogger('authMiddleware');

const UNAUTHORIZED_MESSAGE = 'Unauthorized access. Please login again.';

/**
 * 验证用户是否已登录
 *
 * 401 only for a missing/malformed header, a token the JWT library rejects, or a
 * token whose user no longer exists. A database failure during the user lookup
 * is 503 + Retry-After (the client keeps its token); anything else goes to the
 * app's error handler (500). See ./authErrors.js.
 */
const protect = async (req, res, next) => {
  let token;
  try {
    // 从请求头中获取 token
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'Authentication required. Please login first.'
      });
    }

    // 验证 token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // A token without a user id (e.g. an ops token signed with the same secret)
    // is an auth failure, not a query to run.
    if (!decoded || typeof decoded.id !== 'string' || !decoded.id) {
      return res.status(401).json({
        status: 'fail',
        message: UNAUTHORIZED_MESSAGE
      });
    }

    // 检查用户是否存在
    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id }
    });

    if (!currentUser) {
      return res.status(401).json({
        status: 'fail',
        message: 'User associated with this token does not exist'
      });
    }

    if (currentUser.disabledAt) {
      return res.status(403).json({
        status: 'fail',
        code: 'ACCOUNT_DISABLED',
        message: 'This account has been disabled.'
      });
    }

    // 将用户信息添加到请求对象
    req.user = currentUser;
    req.authClaims = decoded;
    next();
  } catch (error) {
    const kind = classifyAuthError(error);
    if (kind === 'jwt') {
      return res.status(401).json({
        status: 'fail',
        message: UNAUTHORIZED_MESSAGE
      });
    }
    logAuthError(logger, error, req, token);
    if (kind === 'db_unavailable') {
      return sendDatabaseUnavailable(res, 'Service temporarily unavailable. Please try again shortly.');
    }
    return next(error);
  }
};

/**
 * 检查用户是否为组织用户
 */
const isOrganization = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized access'
    });
  }
  
  if (!req.user.isOrganization) {
    return res.status(403).json({
      status: 'error',
      message: 'Only organization users can access this resource'
    });
  }
  
  next();
};

/**
 * 只允许特定角色访问
 */
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        status: 'fail',
        message: 'Insufficient permissions to access this resource'
      });
    }
    next();
  };
};

const authenticateToken = (req, res, next) => {
  // TODO: 实现你的鉴权逻辑。当前为开发环境默认放行。
  // 生产环境请替换为真实的 token 校验逻辑。
  next();
};

module.exports = {
  authenticateToken,
  protect,
  isOrganization,
  restrictTo
}; 