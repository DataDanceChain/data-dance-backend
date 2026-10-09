const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const nftMarketController = require('../controllers/nftMarketController');
const dataNFTController = require('../controllers/dataNFTController');
const router = express.Router();

router.use(protect);

router.get('/', nftMarketController.getMarketList);
router.get('/tags', nftMarketController.getMarketTags);
router.get('/my-purchases', nftMarketController.getMyPurchases);
router.get('/my-sales', nftMarketController.getMySales);
router.get('/:id', nftMarketController.getMarketDetail);
router.post('/:id/purchase', dataNFTController.purchaseDataNFT);

module.exports = router;
