const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.authenticate = async (req, res, next) => {
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
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: '无效的认证令牌格式'
      });
    }

    // 验证 token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
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

    // 将用户信息添加到请求对象
    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        status: 'fail',
        message: '无效的认证令牌'
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'fail',
        message: '认证令牌已过期'
      });
    }
    console.error('认证中间件错误:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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