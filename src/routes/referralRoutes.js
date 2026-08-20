const express = require('express');
const router = express.Router();
const { 
  useReferralCode, 
  getReferralOverview, 
  getReferralStatus,
  claimReferralRewards,
  getMothersDay2026Stats,
  getSummerTravel2026Stats,
} = require('../controllers/referralController');
const { protect } = require('../middlewares/authMiddleware');
const { referralRewardsRouterGate } = require('../middlewares/referralRewardsApiGate');

// All referral routes require authentication
router.use(protect);
router.use(referralRewardsRouterGate);

// Use referral code
router.post('/use-code', useReferralCode);

router.get('/campaign/mothers-day-2026/stats', getMothersDay2026Stats);
router.get('/campaign/summer-travel-2026/stats', getSummerTravel2026Stats);

// Get referral overview (summary)
router.get('/overview', getReferralOverview);

// Get detailed referral status
router.get('/status', getReferralStatus);

// Claim referral rewards
router.post('/claim-rewards', claimReferralRewards);

module.exports = router;
