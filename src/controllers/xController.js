const xService = require('../services/xService'); // New import
const { createLogger } = require('../utils/logger');

const logger = createLogger('xController'); // Corrected logger name

/**
 * Get X post details
 * @route GET /api/x/posts/:postId
 */
exports.getPost = async (req, res) => {
  const { postId } = req.params;
  const ip = req.ip; // For potential rate limiting or logging

  if (!postId || !/^\d+$/.test(postId)) {
    logger.warn('Invalid postId format in getPost', { postId, ip });
    return res.status(400).json({
      status: 'fail',
      message: 'Invalid post ID format'
    });
  }

  const startTime = Date.now();
  logger.info('Fetching post details via xService', { postId, ip });

  try {
    // Call the service layer
    const post = await xService.getPostDetails(postId, ip);
    
    const duration = Date.now() - startTime;
    logger.info('Post details fetched successfully via xService', {
      postId,
      ip,
      duration,
      // _cached was handled by the service, no longer in controller
    });

    return res.json({
      status: 'success',
      data: post
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Error in xController.getPost', {
      postId,
      ip,
      duration,
      error: error.message,
      status: error.status // if the error has a status property
    });

    return res.status(error.status || 500).json({
      status: 'fail',
      message: error.message || 'Error fetching post details',
      ...(error.retryAfter && { retryAfter: error.retryAfter })
    });
  }
};