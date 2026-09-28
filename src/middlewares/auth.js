const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { createLogger } = require('../utils/logger');
const {
  classifyAuthError,
  logAuthError,
  sendDatabaseUnavailable,
} = require('./authErrors');
const prisma = new PrismaClient();
const logger = createLogger('auth');

/**
 * Same contract as authMiddleware.protect: 401 only for header/JWT/user-missing
 * failures, 503 + Retry-After when the database cannot be reached, otherwise
 * the app's error handler. See ./authErrors.js.
 */
exports.authenticate = async (req, res, next) => {
  let token;
  try {
    // 从请求头获取 token
    const authHeader = req.header('Authorization');
    if (!authHeader) {
      return res.status(401).json({
        status: 'fail',
        message: '未提供认证令牌'
      });
    }

    // 验证 token 格式
    token = authHeader.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: '无效的认证令牌格式'
      });
    }

    // 验证 token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // A token without a user id is an auth failure, not a query to run.
    if (!decoded || typeof decoded.id !== 'string' || !decoded.id) {
      return res.status(401).json({
        status: 'fail',
        message: '无效的认证令牌'
      });
    }

    // 获取用户信息
    const user = await prisma.user.findUnique({
      where: { id: decoded.id }
    });

    if (!user) {
      return res.status(401).json({
        status: 'fail',
        message: '用户不存在'
      });
    }

    if (user.disabledAt) {
      return res.status(403).json({
        status: 'fail',
        code: 'ACCOUNT_DISABLED',
        message: '账号已停用'
      });
    }

    // 将用户信息添加到请求对象
    req.user = user;
    req.authClaims = decoded;
    next();
  } catch (error) {
    const kind = classifyAuthError(error);
    if (kind === 'jwt') {
      return res.status(401).json({
        status: 'fail',
        message: error.name === 'TokenExpiredError' ? '认证令牌已过期' : '无效的认证令牌'
      });
    }
    logAuthError(logger, error, req, token);
    if (kind === 'db_unavailable') {
      return sendDatabaseUnavailable(res, '数据库暂时不可用，请稍后重试');
    }
    return next(error);
  }
};

exports.isOrganization = (req, res, next) => {
  if (req.user && (req.user.isOrganization || req.user.userType === 'organization')) {
    console.log('req.user in isOrganization:', req.user);
    return next();
  }
  return res.status(403).json({
    status: 'fail',
    message: 'Only organization users are allowed.',
    userId: req.user ? req.user.id : null,
    userType: req.user ? req.user.userType : null,
    isOrganization: req.user ? req.user.isOrganization : null
  });
}; 