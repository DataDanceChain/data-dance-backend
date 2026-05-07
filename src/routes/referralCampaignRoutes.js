const express = require('express');
const router = express.Router();
const { getMothersDay2026 } = require('../controllers/referralCampaignController');

router.get('/mothers-day-2026', getMothersDay2026);

module.exports = router;
