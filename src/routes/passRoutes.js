const express = require('express');
const router = express.Router();
const passController = require('../controllers/passController');
const { authenticate } = require('../middlewares/auth');

// 所有路由都需要认证
router.use(authenticate);

// 生成 Pass
router.post('/generate', passController.generatePass);

// 获取用户的所有 Pass
router.get('/', passController.getUserPasses);

// 获取单个 Pass 详情
router.get('/:passId', passController.getPassDetail);

// 更新 Pass 状态
router.patch('/:passId/status', passController.updatePassStatus);

module.exports = router; 