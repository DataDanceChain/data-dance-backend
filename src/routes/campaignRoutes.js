const express = require('express');
const { listActive } = require('../controllers/campaignPublicController');
const { getApply, submitApply, getRaffle, getTourismMap } = require('../controllers/campaignUserController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();
router.get('/active', listActive);
router.get('/apply', protect, getApply);
router.post('/apply', protect, submitApply);
router.get('/raffle', protect, getRaffle);
router.get('/tourism-map', protect, getTourismMap);

module.exports = router;
