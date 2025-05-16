const xClient = require('../utils/xClient');
const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const logger = createLogger('xService');

/**
 * Fetches details for a specific X post.
 * @param {string} postId The ID of the X post.
 * @param {string} ip The IP address of the requester (for rate limiting).
 * @returns {Promise<object>} The post details.
 */
async function getPostDetails(postId, ip) {
  // xClient already handles caching and rate limiting internally
  try {
    const post = await xClient.getPostDetails(postId, ip);
    // Remove internal caching field before returning
    const { _cached, ...restOfPost } = post;
    return restOfPost;
  } catch (error) {
    logger.error('Error in xService.getPostDetails', { postId, error: error.message, status: error.status });
    throw error; // Re-throw to be handled by controller
  }
}

/**
 * Verifies if a user has retweeted or quoted a specific X post.
 * @param {string} userId The platform user ID.
 * @param {string} targetPostId The ID of the X post to check.
 * @returns {Promise<boolean>} True if verified, false otherwise.
 * @throws {Error} If X account is not bound or target post ID is missing.
 */
async function verifyUserEngagement(userId, targetPostId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { xid: true } });
  if (!user?.xid) {
    logger.warn('X account not bound for verification', { userId });
    throw new Error("X account not bound");
  }
  if (!targetPostId) {
    logger.error('Target post ID missing for verification', { userId, xid: user.xid });
    throw new Error("Target post ID not defined");
  }

  logger.info('Verifying X engagement', { userId, xid: user.xid, targetPostId });

  // 1. Check for retweets
  try {
    const retweets = await xClient.postRetweetedBy(targetPostId);
    if (Array.isArray(retweets?.data) && retweets.data.some(u => u.id === user.xid)) {
      logger.info('Retweet verified', { userId, xid: user.xid, targetPostId });
      return true;
    }
  } catch (error) {
    logger.error('Error checking retweets via xClient', { userId, xid: user.xid, targetPostId, error: error.message });
    // Do not re-throw yet, proceed to check quotes
  }

  // 2. If not retweeted, check for quotes
  try {
    const quoteSearch = await xClient.search(
      `from:${user.xid} is:quote`,
      { 'tweet.fields': 'referenced_tweets' }
    );
    if (Array.isArray(quoteSearch?.data) && quoteSearch.data.some(tweet =>
      tweet.referenced_tweets?.some(ref => ref.type === 'quoted' && ref.id === targetPostId)
    )) {
      logger.info('Quote verified', { userId, xid: user.xid, targetPostId });
      return true;
    }
  } catch (error) {
    logger.error('Error checking quotes via xClient', { userId, xid: user.xid, targetPostId, error: error.message });
    // Do not re-throw, let it fall through to return false if both checks fail
  }

  logger.warn('X engagement not verified (no retweet or quote found)', { userId, xid: user.xid, targetPostId });
  return false;
}

module.exports = {
  getPostDetails,
  verifyUserEngagement,
};
