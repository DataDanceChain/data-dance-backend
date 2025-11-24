const { createLogger } = require('../utils/logger');
const ddcNFTMetadataService = require('../services/ddcNFTMetadataService');

const logger = createLogger('ddcNFTMetadataController');

/**
 * 获取 DDC NFT Metadata
 * @route GET /metadata/ddcnft/:tokenId
 * @access Private (需要后端权限控制)
 */
exports.getDDCNFTMetadata = async (req, res) => {
  try {
    const { tokenId } = req.params;
    
    const config = ddcNFTMetadataService.getConfig();
    
    // 如果没有提供 tokenId，返回支持的 token 列表
    if (!tokenId || tokenId === 'undefined' || tokenId === 'null') {
      return res.status(200).json({
        status: 'success',
        data: {
          supportedTokenIds: config.supportedTokenIds,
          contractAddress: config.contractAddress,
          baseUrl: config.baseUrl,
          message: 'Please specify a token ID. Supported token IDs: ' + config.supportedTokenIds.join(', ')
        }
      });
    }
    
    const tokenIdNum = parseInt(tokenId, 10);

    // 验证 tokenId
    if (!tokenIdNum || isNaN(tokenIdNum)) {
      return res.status(400).json({
        status: 'fail',
        code: 'INVALID_TOKEN_ID',
        message: 'Invalid token ID format. Token ID must be a number.',
        supportedTokenIds: config.supportedTokenIds
      });
    }

    // 检查 tokenId 是否支持
    if (!ddcNFTMetadataService.isTokenIdSupported(tokenIdNum)) {
      return res.status(404).json({
        status: 'fail',
        code: 'TOKEN_NOT_FOUND',
        message: `Token ID ${tokenIdNum} is not supported`,
        supportedTokenIds: config.supportedTokenIds
      });
    }

    logger.info('Fetching DDC NFT metadata', { tokenId: tokenIdNum, userId: req.user?.id });

    // 根据 tokenId 返回对应的 metadata
    const metadata = await ddcNFTMetadataService.getMetadataByTokenId(tokenIdNum, req.user);

    if (!metadata) {
      return res.status(404).json({
        status: 'fail',
        code: 'METADATA_NOT_FOUND',
        message: `Metadata for token ID ${tokenIdNum} not found`
      });
    }

    res.status(200).json({
      status: 'success',
      data: metadata
    });
  } catch (error) {
    logger.error('Error fetching DDC NFT metadata', {
      error: error.message,
      stack: error.stack,
      tokenId: req.params.tokenId
    });

    res.status(500).json({
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'Failed to fetch DDC NFT metadata',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


/**
 * 获取所有支持的 token IDs
 * @route GET /metadata/ddcnft
 * @access Private
 */
exports.getSupportedTokenIds = async (req, res) => {
  try {
    const config = ddcNFTMetadataService.getConfig();
    res.status(200).json({
      status: 'success',
      data: {
        supportedTokenIds: config.supportedTokenIds,
        contractAddress: config.contractAddress,
        baseUrl: config.baseUrl,
        keyHash: config.keyHash
      }
    });
  } catch (error) {
    logger.error('Error fetching supported token IDs', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch supported token IDs'
    });
  }
};

module.exports = exports;

