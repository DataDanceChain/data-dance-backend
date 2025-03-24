const express = require('express');
const { getMe, updateMe, updateLanguage, updatePassword, getUserPoints, updateWalletAddress } = require('../controllers/userController');
const { protect } = require('../middlewares/authMiddleware');
const router = express.Router();

// 所有路由都需要认证
router.use(protect);

// 获取当前用户信息
router.get('/me', getMe);

// 更新用户信息
router.put('/me', updateMe);

// 更新语言设置
router.put('/language', updateLanguage);

// 更新密码
router.put('/password', updatePassword);

// 更新钱包地址
router.put('/wallet', updateWalletAddress);

// 获取用户积分
router.get('/points', getUserPoints);

module.exports = router; 