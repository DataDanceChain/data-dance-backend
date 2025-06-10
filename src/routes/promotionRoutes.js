const express = require('express');
const router = express.Router();
const promotionController = require('../controllers/promotionController');
const { protect } = require('../middlewares/authMiddleware');

// Get DataNFTs by tags
router.get('/data-nfts/by-tags', protect, promotionController.getDataNFTsByTags);

// Create a new promotion
router.post('/', protect, promotionController.createPromotion);

// Get all promotions
router.get('/', protect, promotionController.getPromotions);

// Get promotion by ID
router.get('/:id', protect, promotionController.getPromotionById);

module.exports = router; 