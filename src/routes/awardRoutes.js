const express = require('express');
const { getAwards, getUserAwards } = require('../controllers/awardController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// 获取所有平台奖励定义
router.get('/awards', getAwards);
// 获取当前用户所有奖励状态，需要登录
router.get('/users/awards', protect, getUserAwards);

module.exports = router;
