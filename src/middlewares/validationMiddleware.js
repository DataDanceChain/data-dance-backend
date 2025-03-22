const { validationResult } = require('express-validator');

/**
 * 验证请求数据
 */
exports.validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'fail',
      message: '请求数据验证失败',
      errors: errors.array()
    });
  }
  next();
}; 