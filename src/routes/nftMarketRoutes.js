const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const nftMarketController = require('../controllers/nftMarketController');
const dataNFTController = require('../controllers/dataNFTController');
const router = express.Router();

router.use(protect);

// 获取市场 NFT 数据资产列表
router.get('/', nftMarketController.getMarketList);
// 获取市场 NFT 数据资产详情
router.get('/:id', nftMarketController.getMarketDetail);
// 购买市场 NFT 数据资产
router.post('/:id/purchase', dataNFTController.purchaseDataNFT);
// 获取我购买的 NFT 数据资产
router.get('/my-purchases', nftMarketController.getMyPurchases);
// 获取我发售的 NFT 数据资产及销售情况
router.get('/my-sales', nftMarketController.getMySales);

module.exports = router; 