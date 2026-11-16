const express = require('express');
const { listActive } = require('../controllers/campaignPublicController');
const { getApply, submitApply, getRaffle, getWheel, spinWheel, claimWheel, getCalendar, openCalendarDay, claimCalendarGift, getTourismMap } = require('../controllers/campaignUserController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();
router.get('/active', listActive);
router.get('/apply', protect, getApply);
router.post('/apply', protect, submitApply);
router.get('/raffle', protect, getRaffle);
router.get('/wheel', protect, getWheel);
router.post('/wheel/spin', protect, spinWheel);
router.post('/wheel/spins/:spinId/claim', protect, claimWheel);
router.get('/calendar', protect, getCalendar);
router.post('/calendar/days/:day/open', protect, openCalendarDay);
router.post('/calendar/opens/:openId/claim', protect, claimCalendarGift);
router.get('/tourism-map', protect, getTourismMap);

module.exports = router;
