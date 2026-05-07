// referral service: build referral overview up to 3 levels
const prisma = require('../utils/prisma');
const { recordTaskProgress } = require('./taskService');
const { REFERRAL_MESSAGES } = require('../constants/messages');
const { createLogger } = require('../utils/logger');
const { distributeUplineRewards } = require('./distributionService');
const {
  MOTHERS_DAY_2026_SLUG,
  MOTHERS_DAY_2026,
  normalizeReferralCampaignInput,
  assertCampaignActive,
} = require('../constants/referralCampaigns');

const logger = createLogger('referralService');

async function fetchReferrals(userId, level, maxLevel) {
  if (level > maxLevel) return [];
  const refs = await prisma.referral.findMany({
    where: { inviterId: userId },
    include: { invitee: { select: { id: true, email: true, name: true } } }
  });
  const result = [];
  for (const r of refs) {
    const node = {
      id: r.invitee.id,
      email: r.invitee.email,
      nickname: r.invitee.name,
      level,
      referrals: await fetchReferrals(r.invitee.id, level + 1, maxLevel)
    };
    result.push(node);
  }
  return result;
}

async function getReferralOverview(userId) {
  // fetch nested referrals up to 4 levels for user info
  const referrals = await fetchReferrals(userId, 1, 4);
  // flatten to count network size
  const flatten = (nodes) => nodes.reduce((acc, n) => acc + 1 + flatten(n.referrals), 0);
  // count referrals per level (levels 1-4)
  const levelCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  function countLevels(nodes) {
    nodes.forEach(n => {
      if (levelCounts[n.level] != null) levelCounts[n.level]++;
      countLevels(n.referrals);
    });
  }
  countLevels(referrals);
  // compute claimed points by level from point records
  const pointRecords = await prisma.point.findMany({
    where: { userId, source: { in: ['REFERRAL_DIRECT','REFERRAL_LEVEL_2','REFERRAL_LEVEL_3','REFERRAL_LEVEL_4'] } },
    select: { amount: true, source: true }
  });
  const claimedByLevel = { level1: 0, level2: 0, level3: 0, level4: 0 };
  pointRecords.forEach(record => {
    switch (record.source) {
      case 'REFERRAL_DIRECT': claimedByLevel.level1 += record.amount; break;
      case 'REFERRAL_LEVEL_2': claimedByLevel.level2 += record.amount; break;
      case 'REFERRAL_LEVEL_3': claimedByLevel.level3 += record.amount; break;
      case 'REFERRAL_LEVEL_4': claimedByLevel.level4 += record.amount; break;
    }
  });
  // fetch referral task point values
  const referralTasks = await prisma.task.findMany({ where: { id: { in: ['referral-1','referral-2','referral-3','referral-4'] } }, select: { id: true, points: true } });
  const levelPoints = {};
  referralTasks.forEach(t => {
    const lvl = parseInt(t.id.split('-')[1], 10) || 1;
    levelPoints[`level${lvl}`] = t.points;
  });
  // compute unclaimed points per level based on referrals count
  const unclaimedByLevel = {};
  [1,2,3,4].forEach(lvl => {
    const key = `level${lvl}`;
    const totalRefs = levelCounts[lvl] || 0;
    const claimedCount = levelPoints[key] ? claimedByLevel[key] / levelPoints[key] : 0;
    const unclaimedCount = Math.max(totalRefs - claimedCount, 0);
    unclaimedByLevel[key] = unclaimedCount * (levelPoints[key] || 0);
  });
  // combine claimed and unclaimed
  const earnedByLevel = [
    claimedByLevel.level1 + unclaimedByLevel.level1,
    claimedByLevel.level2 + unclaimedByLevel.level2,
    claimedByLevel.level3 + unclaimedByLevel.level3,
    claimedByLevel.level4 + unclaimedByLevel.level4
  ];
  const totalReferralPoints = earnedByLevel.reduce((a, b) => a + b, 0);
  const unclaimReferralAwards = Object.values(unclaimedByLevel).reduce((a, b) => a + b, 0);
  // prepare levelPoints mapping from referralTasks
  const levelPointsMap = {};
  referralTasks.forEach(t => {
    const lvl = parseInt(t.id.split('-')[1], 10);
    levelPointsMap[lvl] = t.points;
  });
  // annotate each referral node with theirPoints
  // 注意：yourReward现在由新的通用分润系统在任务完成时动态计算，基于百分比而非固定分值
  function annotate(nodes) {
    nodes.forEach(n => {
      const cnt = n.referrals.length;
      // theirPoints: child count * 50 (保留原有计算逻辑用于展示)
      n.theirPoints = cnt * 50;
      // yourReward已移除：现在使用基于百分比的动态分润系统
      // 实际分润金额会根据下级完成的具体任务和其积分值来计算
      annotate(n.referrals);
    });
  }
  annotate(referrals);
  // compute networkActivity: totalReferralPoints + sum of levelCounts 2-4 * 50
  const lvl234Count = (levelCounts[2] || 0) + (levelCounts[3] || 0) + (levelCounts[4] || 0);
  const networkActivity = totalReferralPoints + lvl234Count * 50;

  return {
    referrals,
    levelCounts,
    earnedByLevel,
    totalReferralPoints,
    unclaimReferralAwards,
    networkActivity
  };
}

async function claimReferralRewards(userId) {
  // 批量领取所有已完成且未领取的邀请任务奖励
  const uts = await prisma.userTask.findMany({
    where: { userId, status: 'LIVE', claimed: false, task: { awardId: 'referral-rewards' } },
    include: { task: true }
  });
  if (uts.length === 0) throw new Error('No referral rewards to claim');
  // 更新为已领取
  await prisma.userTask.updateMany({
    where: { userId, status: 'LIVE', claimed: false, task: { awardId: 'referral-rewards' } },
    data: { claimed: true }
  });
  // 记录积分流水，按层级设置正确的 source
  const now = new Date();
  for (const ut of uts) {
    const [, levelStr] = ut.taskId.split('-');
    const level = parseInt(levelStr, 10) || 1;
    const source = level === 1 ? 'REFERRAL_DIRECT' : `REFERRAL_LEVEL_${level}`;
    await prisma.point.create({ data: { userId, amount: ut.task.points, source, sourceId: ut.taskId, createdAt: now } });
  }
  return { claimedAt: now, totalPoints: uts.reduce((sum, ut) => sum + ut.task.points, 0), count: uts.length };
}

/**
 * Process a new referral: create Referral row and propagate progress up to 4 levels
 * @param {string} newUserId - the invitee user ID
 * @param {string} inviterId - the direct inviter user ID
 * @param {string} referralCode - the referral code used
 */
/**
 * Mother's Day (and similar) flat bonuses — no multi-level tasks or upline distribution.
 */
async function processCampaignReferral(newUserId, inviterId, campaignSlug) {
  let inviterAmount = 0;
  let inviteeAmount = 0;
  if (campaignSlug === MOTHERS_DAY_2026_SLUG) {
    inviterAmount = MOTHERS_DAY_2026.inviterPoints;
    inviteeAmount = MOTHERS_DAY_2026.inviteePoints;
  } else {
    throw new Error(`Unsupported campaign for referral rewards: ${campaignSlug}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: inviterId },
      data: { totalPoints: { increment: inviterAmount } },
    });
    await tx.point.create({
      data: {
        userId: inviterId,
        amount: inviterAmount,
        source: 'REFERRAL_CAMPAIGN_MOTHERS_DAY_INVITER',
        sourceId: newUserId,
      },
    });
    await tx.user.update({
      where: { id: newUserId },
      data: { totalPoints: { increment: inviteeAmount } },
    });
    await tx.point.create({
      data: {
        userId: newUserId,
        amount: inviteeAmount,
        source: 'REFERRAL_CAMPAIGN_MOTHERS_DAY_INVITEE',
        sourceId: inviterId,
      },
    });
  });

  logger.info('Campaign referral rewards issued', {
    campaignSlug,
    inviterId,
    inviteeId: newUserId,
    inviterAmount,
    inviteeAmount,
  });
}

async function processReferral(newUserId, inviterId, referralCode) {
  try {
    // Award immediate 50-point direct referral bonus
    await prisma.$transaction(async (tx) => {
      // Update inviter's total points
      await tx.user.update({
        where: { id: inviterId },
        data: { totalPoints: { increment: 50 } }
      });
      
      // Create point record for the direct referral bonus
      await tx.point.create({
        data: {
          userId: inviterId,
          amount: 50,
          source: 'REFERRAL_DIRECT',
          sourceId: newUserId // Track who triggered this reward
        }
      });
      
      logger.info(REFERRAL_MESSAGES.DIRECT_REWARD_AWARDED(inviterId, 50));
      
      // Distribute upline rewards for the 50-point direct referral bonus
      try {
        const distributionResult = await distributeUplineRewards(inviterId, 50, tx, `referral_direct_${newUserId}`);
        logger.info('Upline distribution completed for direct referral bonus', {
          inviterId,
          inviteeId: newUserId,
          baseReward: 50,
          distributionResult
        });
      } catch (distributionError) {
        // Distribution failure should not affect the main referral process
        logger.error('Upline distribution failed for direct referral bonus', {
          inviterId,
          inviteeId: newUserId,
          baseReward: 50,
          error: distributionError.message
        });
        // Continue execution without throwing
      }
    });
    
    // Also record the referral task for tracking (but it's already paid)
    await recordTaskProgress(inviterId, 'referral-1', 1);
    
    // Record multi-level referral tasks for levels 2–4
    let currentInvitee = newUserId;
    for (let level = 2; level <= 4; level++) {
      const parent = await prisma.referral.findUnique({ where: { inviteeId: currentInvitee }, select: { inviterId: true } });
      if (!parent?.inviterId) break;
      await recordTaskProgress(parent.inviterId, `referral-${level}`, 1);
      logger.info(REFERRAL_MESSAGES.MULTILEVEL_PROGRESS(parent.inviterId, level));
      currentInvitee = parent.inviterId;
    }
  } catch (error) {
    logger.error('Error processing referral', { error: error.message, newUserId, inviterId });
    throw error;
  }
}

/**
 * Get user's referral status including invitation info
 * @param {string} userId - The user ID to get status for
 */
async function getReferralStatus(userId) {
  // Check if user has been invited by someone
  const asInvitee = await prisma.referral.findUnique({
    where: { inviteeId: userId },
    include: {
      inviter: {
        select: {
          id: true,
          name: true,
          referralCode: true
        }
      }
    }
  });

  // Get information about people this user has invited
  const asInviter = await prisma.referral.findMany({
    where: { inviterId: userId },
    select: {
      inviteeId: true,
      createdAt: true,
      invitee: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  // Get user's own referral code
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { 
      referralCode: true,
      name: true
    }
  });

  if (!user) {
    throw new Error('User not found');
  }

  return {
    hasBeenInvited: !!asInvitee,
    inviterInfo: asInvitee && asInvitee.inviter ? {
      id: asInvitee.inviter.id,
      name: asInvitee.inviter.name,
      code: asInvitee.inviter.referralCode,
      inviteTime: asInvitee.createdAt
    } : null,
    ownReferralCode: user.referralCode,
    invitedUsers: asInviter.map(ref => ({
      id: ref.inviteeId,
      name: ref.invitee?.name || 'Unknown',
      inviteTime: ref.createdAt
    }))
  };
}

/**
 * Use a referral code
 * @param {string} userId - The user ID who is using the code
 * @param {string} code - The referral code to use
 * @throws {Error} with code property for specific error cases
 */
async function countCampaignInvitesAsInviter(userId, campaignSlug) {
  if (!campaignSlug) return 0;
  return prisma.referral.count({
    where: { inviterId: userId, campaignSlug },
  });
}

async function useReferralCode(userId, code, referralCampaignRaw = null) {
  let campaignSlug = null;
  try {
    campaignSlug = normalizeReferralCampaignInput(referralCampaignRaw);
  } catch (e) {
    if (e.code) throw e;
    throw e;
  }
  assertCampaignActive(campaignSlug);

  if (campaignSlug && !code) {
    const err = new Error('Referral code is required for campaign invites');
    err.code = 'MISSING_CODE';
    throw err;
  }

  // Check if user has already been referred
  const existingReferral = await prisma.referral.findUnique({
    where: { inviteeId: userId },
    include: { inviter: { select: { id: true, name: true } } }
  });

  if (existingReferral) {
    const error = new Error('User has already been referred');
    error.code = 'ALREADY_REFERRED';
    error.data = {
      inviterId: existingReferral.inviterId,
      inviterName: existingReferral.inviter?.name,
      code: existingReferral.code,
      createdAt: existingReferral.createdAt
    };
    throw error;
  }

  // Find inviter
  const inviter = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true, name: true, referralCode: true }
  });

  if (!inviter) {
    const error = new Error('Invalid referral code');
    error.code = 'INVALID_CODE';
    throw error;
  }

  // Prevent self-referral
  if (inviter.id === userId) {
    const error = new Error('Cannot use your own referral code');
    error.code = 'SELF_REFERRAL_NOT_ALLOWED';
    throw error;
  }

  try {
    // Create referral relationship and process rewards in a transaction
    const referralData = await prisma.$transaction(async (tx) => {
      // Create the referral record
      const referral = await tx.referral.create({
        data: {
          inviterId: inviter.id,
          inviteeId: userId,
          code,
          campaignSlug,
        }
      });
      
      if (campaignSlug === MOTHERS_DAY_2026_SLUG) {
        await processCampaignReferral(userId, inviter.id, campaignSlug);
      } else {
        await processReferral(userId, inviter.id, code);
      }
      
      return referral;
    });

    return {
      inviterId: inviter.id,
      inviterName: inviter.name,
      inviteeId: userId,
      code: code,
      createdAt: referralData.createdAt
    };
  } catch (error) {
    console.error('Transaction error in useReferralCode:', error);
    if (error.code === 'P2002') {
      const err = new Error('User has already been referred');
      err.code = 'ALREADY_REFERRED';
      throw err;
    }
    throw error;
  }
}

module.exports = {
  getReferralOverview,
  claimReferralRewards,
  processReferral,
  processCampaignReferral,
  getReferralStatus,
  useReferralCode,
  countCampaignInvitesAsInviter,
};