const express = require('express');
const router = express.Router();
const ddcNFTMetadataController = require('../controllers/ddcNFTMetadataController');
const { protect } = require('../middlewares/authMiddleware');

/**
 * DDC NFT Metadata 路由
 * 
 * 所有路由都需要认证（后端权限控制）
 * 使用 protect 中间件确保只有已登录的用户可以访问
 * 
 * 路由说明：
 * - GET /metadata/ddcnft/:tokenId - 获取特定 token ID 的 metadata
 * - GET /metadata/ddcnft/list/supported - 获取支持的 token IDs 列表
 */

// 获取特定 token ID 的 metadata
// 如果没有提供 tokenId 或 tokenId 无效，控制器会返回支持的 token 列表
router.get('/:tokenId', protect, ddcNFTMetadataController.getDDCNFTMetadata);

// 获取支持的 token IDs 列表（可选的路由）
router.get('/list/supported', protect, ddcNFTMetadataController.getSupportedTokenIds);

module.exports = router;

