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
 * @returns {Promise<{distributedRewards: Array, totalDistributed: number}>}
 */
async function distributeUplineRewards(userId, baseRewardAmount, tx, sourceTaskId = null) {
  const { uplineRewardPercentages, maxLevels, roundingMode } = businessRules.rewardDistribution;
  logger.info(DISTRIBUTION_MESSAGES.START_DISTRIBUTION(userId, baseRewardAmount, maxLevels), { 
    sourceTaskId,
    config: businessRules.rewardDistribution 
  });
  const distributedRewards = [];
  let currentUserId = userId;
  let totalDistributed = 0;

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