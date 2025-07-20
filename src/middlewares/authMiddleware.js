const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * 验证用户是否已登录
 */
const protect = async (req, res, next) => {
  try {
    let token;

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

    // 将用户信息添加到请求对象
    req.user = currentUser;
    next();
  } catch (error) {
    return res.status(401).json({
      status: 'fail',
      message: 'Unauthorized access. Please login again.'
    });
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