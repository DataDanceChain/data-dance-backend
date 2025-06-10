const express = require('express');
const router = express.Router();
const dataNFTController = require('../controllers/dataNFTController');
const { protect } = require('../middlewares/authMiddleware');
const { uploadNFTImage } = require('../middlewares/uploadMiddleware');

// Create a DataNFT bundle from snapshots (支持图片上传)
router.post('/merge', protect, uploadNFTImage.single('image'), dataNFTController.mergeSnapshots);

// Get all DataNFTs (with pagination and filters)
router.get('/', protect, dataNFTController.getDataNFTs);

// 静态路由优先
router.get('/merchant/:merchantId', protect, dataNFTController.getDataNFTsByMerchant);
router.get('/purchased', protect, dataNFTController.getPurchasedDataNFTs);

// 动态路由最后
router.get('/:id', protect, dataNFTController.getDataNFTById);

// Update a DataNFT (支持图片上传)
router.put('/:id', protect, uploadNFTImage.single('image'), dataNFTController.updateDataNFT);

// Delete a DataNFT
router.delete('/:id', protect, dataNFTController.deleteDataNFT);

// Publish a DataNFT
router.post('/:id/publish', protect, dataNFTController.publishDataNFT);

// Unpublish a DataNFT
router.post('/:id/unpublish', protect, dataNFTController.unpublishDataNFT);

// Purchase a DataNFT
router.post('/:id/purchase', protect, dataNFTController.purchaseDataNFT);

// Get DataNFT holders
router.get('/:id/holders', protect, dataNFTController.getDataNFTHolders);

module.exports = router; 