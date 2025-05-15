const { getPostDetails, clearCache } = require('../utils/xClient');
const { createLogger } = require('../utils/logger');

const logger = createLogger('xPostController');

/**
 * Get X post details
 * @route GET /api/x/posts/:postId
 */
exports.getPost = async (req, res) => {
  const { postId } = req.params;
  const ip = req.ip;

  // Validate postId
  if (!postId || !/^\d+$/.test(postId)) {
    logger.warn('Invalid postId', { postId, ip });
    return res.status(400).json({
      status: 'fail',
      message: 'Invalid post ID format'
    });
  }

  const startTime = Date.now();
  logger.info('Fetching post details', { postId, ip });

  try {
    const post = await getPostDetails(postId, ip);
    
    // Log success with timing
    const duration = Date.now() - startTime;
    logger.info('Post details fetched successfully', {
      postId,
      ip,
      duration,
      cached: post._cached
    });

    // Remove internal fields before sending response
    delete post._cached;

    return res.json({
      status: 'success',
      data: post
    });
  } catch (error) {
    // Log error with timing
    const duration = Date.now() - startTime;
    logger.error('Error fetching post details', {
      postId,
      ip,
      duration,
      error: error.message,
      status: error.status
    });

    // Send appropriate error response
    return res.status(error.status || 500).json({
      status: 'fail',
      message: error.message,
      ...(error.retryAfter && { retryAfter: error.retryAfter })
    });
  }
};

/**
 * Clear post cache (admin only)
 * @route DELETE /api/x/posts/:postId/cache
 */
exports.clearPostCache = async (req, res) => {
  const { postId } = req.params;
  
  try {
    await clearCache(postId);
    logger.info('Post cache cleared', { postId, userId: req.user.id });
    
    return res.json({
      status: 'success',
      message: 'Cache cleared successfully'
    });
  } catch (error) {
    logger.error('Error clearing post cache', {
      postId,
      userId: req.user.id,
      error: error.message
    });
    
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to clear cache'
    });
  }
}; 