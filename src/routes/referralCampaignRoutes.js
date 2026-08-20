const express = require('express');
const router = express.Router();
const {
  getMothersDay2026,
  getSummerTravel2026,
} = require('../controllers/referralCampaignController');
const { referralRewardsRouterGate } = require('../middlewares/referralRewardsApiGate');

router.use(referralRewardsRouterGate);

router.get('/mothers-day-2026', getMothersDay2026);
router.get('/summer-travel-2026', getSummerTravel2026);

module.exports = router;
