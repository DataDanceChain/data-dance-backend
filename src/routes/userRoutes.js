const express = require('express');
const { 
  getMe, 
  updateMe, 
  updateLanguage, 
  updatePassword, 
  getUserPoints, 
  updateWalletAddress, 
  generateWallet, 
  importWallet, 
  rewardPoints, 
  getReferralCode, 
  getRegistrationTime
} = require('../controllers/userController');
const { getReferralOverview, claimReferralRewards, useReferralCode } = require('../controllers/referralController');
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

// 生成钱包
router.post('/wallet/generate', generateWallet);

// 导入钱包
router.post('/wallet/import', importWallet);

// Get user's referral code
router.get('/referral-code', getReferralCode);

// 获取邀请概览
router.get('/referrals', getReferralOverview);

// 获取当前用户注册时间
router.get('/registered-at', getRegistrationTime);

// 领取邀请奖励
router.post('/referrals/claim', claimReferralRewards);

// 使用邀请码
router.post('/referrals/use-code', useReferralCode);

module.exports = router;