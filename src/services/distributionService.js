const prisma = require('../utils/prisma');
const businessRules = require('../../config/business-rules.json');
const { createLogger } = require('../utils/logger');

const logger = createLogger('distributionService');

/**
 * 通用奖励分润服务
 * 
 * 负责处理所有任务完成后的上级分润逻辑，替代原有的硬编码邀请奖励分润
 * 
 * 支持:
 * - 可配置的分润比例和层级
 * - 事务安全
 * - 详细的审计日志
 * - 小数精度处理
 */

/**
 * 计算并分发上级奖励
 * @param {string} userId - 获得基础奖励的用户ID
 * @param {number} baseRewardAmount - 该用户获得的基础奖励积分数
 * @param {object} tx - Prisma事务客户端，确保所有数据库操作的原子性
 * @param {string} sourceTaskId - 触发分润的原始任务ID（用于审计）
 * @returns {Promise<{distributedRewards: Array, totalDistributed: number}>}
 */
async function distributeUplineRewards(userId, baseRewardAmount, tx, sourceTaskId = null) {
  logger.info('开始分发上级奖励', { 
    userId, 
    baseRewardAmount, 
    sourceTaskId,
    config: businessRules.rewardDistribution 
  });

  const { uplineRewardPercentages, maxLevels, roundingMode } = businessRules.rewardDistribution;
  const distributedRewards = [];
  let currentUserId = userId;
  let totalDistributed = 0;

  try {
    for (let level = 0; level < Math.min(uplineRewardPercentages.length, maxLevels); level++) {
      const percentage = uplineRewardPercentages[level];
      
      // 查找当前用户的邀请记录以找到其直接上级
      const referral = await tx.referral.findUnique({
        where: { inviteeId: currentUserId },
        include: {
          inviter: {
            select: { id: true, name: true, email: true }
          }
        }
      });

      // 如果没有邀请记录，意味着没有上级了，分润链中断
      if (!referral) {
        logger.info('分润链中断，未找到上级', { 
          currentUserId, 
          level: level + 1,
          totalLevelsProcessed: level 
        });
        break; 
      }

      const referrerId = referral.inviterId;
      const rawReward = baseRewardAmount * percentage;
      
      // 根据配置进行小数处理
      const uplineReward = roundingMode === 'round' 
        ? Math.round(rawReward * 100) / 100  // 保留2位小数并四舍五入
        : Math.floor(rawReward * 100) / 100; // 保留2位小数并向下取整

      logger.info('计算上级奖励', {
        level: level + 1,
        referrerId,
        referrerName: referral.inviter.name,
        percentage: percentage * 100 + '%',
        rawReward,
        finalReward: uplineReward
      });

      // 为上级增加总积分
      await tx.user.update({
        where: { id: referrerId },
        data: { totalPoints: { increment: uplineReward } },
      });
      
      // 为上级创建一条详细的积分来源记录，便于追踪
      const pointRecord = await tx.point.create({
        data: {
          userId: referrerId,
          amount: uplineReward,
          source: 'upline_reward', // 标记为"上级分润"
          sourceId: sourceTaskId || userId, // 记录触发分润的原始任务ID或用户ID
        },
      });

      // 记录分润详情
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
      
      logger.info('成功分发上级奖励', rewardInfo);

      // 将当前用户ID更新为上级的ID，以便在下一次循环中继续向上追溯
      currentUserId = referrerId;
    }

    logger.info('分润分发完成', {
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
    logger.error('分润分发过程中发生错误', {
      error: error.message,
      stack: error.stack,
      userId,
      baseRewardAmount,
      currentLevel: distributedRewards.length + 1
    });
    throw error; // 重新抛出错误，让调用方的事务处理
  }
}

/**
 * 获取用户的分润配置信息
 * @returns {object} 当前的分润配置
 */
function getDistributionConfig() {
  return businessRules.rewardDistribution;
}

/**
 * 验证分润配置的有效性
 * @returns {boolean} 配置是否有效
 */
function validateDistributionConfig() {
  const config = businessRules.rewardDistribution;
  
  if (!config || !Array.isArray(config.uplineRewardPercentages)) {
    logger.error('分润配置无效：缺少uplineRewardPercentages数组');
    return false;
  }
  
  if (config.uplineRewardPercentages.some(p => typeof p !== 'number' || p < 0 || p > 1)) {
    logger.error('分润配置无效：百分比值必须在0-1之间');
    return false;
  }
  
  if (typeof config.maxLevels !== 'number' || config.maxLevels < 1) {
    logger.error('分润配置无效：maxLevels必须是正整数');
    return false;
  }
  
  if (!['round', 'floor'].includes(config.roundingMode)) {
    logger.error('分润配置无效：roundingMode必须是round或floor');
    return false;
  }
  
  return true;
}

module.exports = {
  distributeUplineRewards,
  getDistributionConfig,
  validateDistributionConfig
};