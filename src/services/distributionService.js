const prisma = require('../utils/prisma');
const businessRules = require('../../config/business-rules.json');
const { createLogger } = require('../utils/logger');
const { DISTRIBUTION_MESSAGES } = require('../constants/messages');

const logger = createLogger('distributionService');

/**
 * Universal reward distribution service
 * 
 * Handles upline distribution logic after all task completions, replacing hardcoded invitation reward distribution
 * 
 * Features:
 * - Configurable distribution percentages and levels
 * - Transaction safety
 * - Detailed audit logging
 * - Decimal precision handling
 */

/**
 * Calculate and distribute upline rewards
 * @param {string} userId - User ID who earned the base reward
 * @param {number} baseRewardAmount - Base reward points earned by the user
 * @param {object} tx - Prisma transaction client to ensure atomic operations
 * @param {string} sourceTaskId - Original task ID that triggered distribution (for audit)
 * @param {object} [options]
 * @param {(since: Date) => Promise<boolean>} [options.activityCountsSince] - For points whose
 *   qualifying activity may predate the moment of payment (a task claimed now but completed
 *   earlier). Called per level with the latest bind time (Referral.createdAt) on the path from the
 *   earner up to that level's referrer; the walk stops at the first level for which the activity
 *   does not count. Late-bound relations only earn from activity at or after the bind
 *   (Sloan, 2026-09-28: 后绑码的邀请关系方面的奖励只算绑定后的). Omit it when the activity is
 *   happening now (an upload, a bonus paid for an upload): the chain as it stands already only
 *   contains relations bound before that activity.
 * @returns {Promise<{distributedRewards: Array, totalDistributed: number}>}
 */
async function distributeUplineRewards(userId, baseRewardAmount, tx, sourceTaskId = null, options = {}) {
  const { activityCountsSince } = options;
  const { uplineRewardPercentages, maxLevels, roundingMode } = businessRules.rewardDistribution;
  logger.info(DISTRIBUTION_MESSAGES.START_DISTRIBUTION(userId, baseRewardAmount, maxLevels), { 
    sourceTaskId,
    config: businessRules.rewardDistribution 
  });
  const distributedRewards = [];
  let currentUserId = userId;
  let totalDistributed = 0;
  let pathBoundAt = null; // latest bind on the path from the earner to the current referrer
  let passedBoundAt = null; // last cutoff activityCountsSince accepted; skip re-asking for the same one

  try {
    for (let level = 0; level < Math.min(uplineRewardPercentages.length, maxLevels); level++) {
      const percentage = uplineRewardPercentages[level];
      
      // Find current user's referral record to locate their direct upline
      logger.info(`Attempting to find referral for inviteeId: ${currentUserId}`);
      const referral = await tx.referral.findUnique({
        where: { inviteeId: currentUserId },
        include: {
          inviter: {
            select: { id: true, name: true, email: true }
          }
        }
      });
      logger.info(`Referral found: ${JSON.stringify(referral)}`);

      // If no referral record, means no upline, distribution chain breaks
      if (!referral) {
        logger.info(DISTRIBUTION_MESSAGES.NO_REFERRER(currentUserId), { 
          level: level + 1,
          totalLevelsProcessed: level 
        });
        break; 
      }

      const referrerId = referral.inviterId;

      if (activityCountsSince) {
        const boundAt = referral.createdAt ? new Date(referral.createdAt) : null;
        if (boundAt && (!pathBoundAt || boundAt > pathBoundAt)) pathBoundAt = boundAt;
        // The cutoff only moves later going up, so once the activity predates it no higher level counts.
        const alreadyPassed = passedBoundAt && pathBoundAt && passedBoundAt.getTime() === pathBoundAt.getTime();
        if (pathBoundAt && !alreadyPassed) {
          if (!(await activityCountsSince(pathBoundAt))) {
            logger.info('Upline distribution stopped: activity predates the referral bind', {
              userId,
              sourceTaskId,
              level: level + 1,
              referrerId,
              boundAt: pathBoundAt,
            });
            break;
          }
          passedBoundAt = pathBoundAt;
        }
      }

      const rawReward = baseRewardAmount * percentage;
      
      // Apply decimal rounding based on configuration
      const uplineReward = roundingMode === 'round' 
        ? Math.round(rawReward * 100) / 100  // Keep 2 decimal places and round
        : Math.floor(rawReward * 100) / 100; // Keep 2 decimal places and floor

      logger.info(DISTRIBUTION_MESSAGES.PROCESS_LEVEL(level + 1, referrerId, percentage * 100, uplineReward), {
        referrerName: referral.inviter.name,
        rawReward,
        finalReward: uplineReward
      });

      // Add total points for upline
      await tx.user.update({
        where: { id: referrerId },
        data: { totalPoints: { increment: uplineReward } },
      });
      
      // Create detailed point source record for upline for tracking
      const pointRecord = await tx.point.create({
        data: {
          userId: referrerId,
          amount: uplineReward,
          source: 'upline_reward', // Mark as "upline reward"
          sourceId: sourceTaskId || userId, // Record original task ID or user ID that triggered distribution
        },
      });

      // Record distribution details
      const rewardInfo = {
        level: level + 1,
        referrerId,
        referrerName: referral.inviter.name,
        amount: uplineReward,
        percentage,
        pointRecordId: pointRecord.id
      };
      
      distributedRewards.push(rewardInfo);
      totalDistributed += uplineReward;
      
      logger.info(DISTRIBUTION_MESSAGES.AWARD_SUCCESS(referrerId, uplineReward, level + 1), rewardInfo);

      // Update current user ID to upline's ID to continue tracing up in next iteration
      currentUserId = referrerId;
    }

    logger.info(DISTRIBUTION_MESSAGES.DISTRIBUTION_COMPLETE(totalDistributed, distributedRewards.length), {
      originalUserId: userId,
      levelsProcessed: distributedRewards.length,
      totalDistributed,
      distributionBreakdown: distributedRewards.map(r => ({
        level: r.level,
        amount: r.amount,
        percentage: (r.percentage * 100) + '%'
      }))
    });

    return {
      distributedRewards,
      totalDistributed
    };

  } catch (error) {
    logger.error(DISTRIBUTION_MESSAGES.DISTRIBUTION_ERROR(error.message), {
      error: error.message,
      stack: error.stack,
      userId,
      baseRewardAmount,
      currentLevel: distributedRewards.length + 1
    });
    throw error; // Re-throw error for caller's transaction handling
  }
}

/**
 * Get user's distribution configuration info
 * @returns {object} Current distribution configuration
 */
function getDistributionConfig() {
  return businessRules.rewardDistribution;
}

/**
 * Validate distribution configuration
 * @returns {boolean} Whether configuration is valid
 */
function validateDistributionConfig() {
  const config = businessRules.rewardDistribution;
  
  if (!config || !Array.isArray(config.uplineRewardPercentages)) {
    logger.error(DISTRIBUTION_MESSAGES.INVALID_PERCENTAGES);
    return false;
  }
  
  if (config.uplineRewardPercentages.some(p => typeof p !== 'number' || p < 0 || p > 1)) {
    logger.error('Invalid distribution config: percentage values must be between 0-1');
    return false;
  }
  
  if (typeof config.maxLevels !== 'number' || config.maxLevels < 1) {
    logger.error('Invalid distribution config: maxLevels must be a positive integer');
    return false;
  }
  
  if (!['round', 'floor'].includes(config.roundingMode)) {
    logger.error('Invalid distribution config: roundingMode must be round or floor');
    return false;
  }
  
  return true;
}

module.exports = {
  distributeUplineRewards,
  getDistributionConfig,
  validateDistributionConfig
};