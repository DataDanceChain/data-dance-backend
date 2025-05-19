const express = require('express');
const router = express.Router();
const { 
  useReferralCode, 
  getReferralOverview, 
  getReferralStatus,
  claimReferralRewards 
} = require('../controllers/referralController');
const { protect } = require('../middlewares/authMiddleware');

// All referral routes require authentication
router.use(protect);

// Use referral code
router.post('/use-code', useReferralCode);

// Get referral overview (summary)
router.get('/overview', getReferralOverview);

// Get detailed referral status
router.get('/status', getReferralStatus);

// Claim referral rewards
router.post('/claim-rewards', claimReferralRewards);

module.exports = router;
