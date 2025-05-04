const express = require('express');
const { getAwards, getUserAwards } = require('../controllers/awardController');
const { protect } = require('../middlewares/authMiddleware');
const referralController = require('../controllers/referralController');

const router = express.Router();

// 获取所有平台奖励定义
router.get('/awards', getAwards);
// 获取当前用户所有奖励状态，需要登录
router.get('/users/awards', protect, getUserAwards);
// 获取用户推荐网络概览
router.get('/users/referrals', protect, referralController.getReferralOverview);
// 一键领取推荐奖励
router.post('/users/referrals/claim', protect, referralController.claimReferralRewards);
// Process a referral upon new user signup or manual trigger
router.post('/users/referrals/process', protect, referralController.processReferral);

module.exports = router;
