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
const { getReferralRulesPayload } = require('../constants/referralCopy');
const {
  hasCompletedFirstValidUpload,
  getUsersWithValidUploads,
} = require('../utils/firstValidUpload');

const logger = createLogger('referralService');

/** Standard (non-campaign) direct referral — immediate inviter bonus and upline distribution base */
const DIRECT_REFERRAL_BONUS_POINTS = 150;

async function fetchReferrals(userId, level, maxLevel) {
  if (level > maxLevel) return [];
  // Standard referral rewards UI / tasks only apply to non-campaign invites.
  // Mother's Day (campaignSlug set) uses separate Point sources and skips referral-* tasks.
  const refs = await prisma.referral.findMany({
    where: { inviterId: userId, campaignSlug: null },
    include: { invitee: { select: { id: true, email: true, name: true } } }
  });
  const inviteeIds = refs.map((r) => r.invitee.id);
  const withUploads = await getUsersWithValidUploads(inviteeIds);
  const result = [];
  for (const r of refs) {
    const node = {
      id: r.invitee.id,
      email: r.invitee.email,
      nickname: r.invitee.name,
      level,
      qualified: withUploads.has(r.invitee.id),
      referrals: await fetchReferrals(r.invitee.id, level + 1, maxLevel)
    };
    result.push(node);
  }
  return result;
}

function countQualifiedReferralsByLevel(nodes, counts = { 1: 0, 2: 0, 3: 0, 4: 0 }) {
  nodes.forEach((n) => {
    if (n.qualified && counts[n.level] != null) counts[n.level]++;
    countQualifiedReferralsByLevel(n.referrals, counts);
  });
  return counts;
}

async function hasReferralRewardsBeenProcessedForInvitee(inviteeId) {
  const existing = await prisma.point.findFirst({
    where: { source: 'REFERRAL_DIRECT', sourceId: inviteeId },
    select: { id: true },
  });
  return Boolean(existing);
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
  const qualifiedLevelCounts = countQualifiedReferralsByLevel(referrals);
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
  // compute unclaimed points per level based on qualified referrals (first valid upload)
  const unclaimedByLevel = {};
  [1,2,3,4].forEach(lvl => {
    const key = `level${lvl}`;
    const totalRefs = qualifiedLevelCounts[lvl] || 0;
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
      const qualifiedChildren = n.referrals.filter((child) => child.qualified).length;
      n.theirPoints = qualifiedChildren * DIRECT_REFERRAL_BONUS_POINTS;
      annotate(n.referrals);
    });
  }
  annotate(referrals);
  // Display heuristic for downstream depth (not tied to direct-invite bonus amount).
  const lvl234Count = (levelCounts[2] || 0) + (levelCounts[3] || 0) + (levelCounts[4] || 0);
  const networkActivity = totalReferralPoints + lvl234Count * 50;

  return {
    referrals,
    levelCounts,
    qualifiedLevelCounts,
    earnedByLevel,
    totalReferralPoints,
    unclaimReferralAwards,
    networkActivity,
    rules: getReferralRulesPayload(),
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

async function processReferralRewardsForInvitee(newUserId, inviterId, referralCode) {
  if (await hasReferralRewardsBeenProcessedForInvitee(newUserId)) {
    logger.info('Referral rewards already processed for invitee', { newUserId, inviterId });
    return { alreadyProcessed: true };
  }

  try {
    // Award direct referral bonus (standard / non-campaign) after first valid upload
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: inviterId },
        data: { totalPoints: { increment: DIRECT_REFERRAL_BONUS_POINTS } }
      });

      await tx.point.create({
        data: {
          userId: inviterId,
          amount: DIRECT_REFERRAL_BONUS_POINTS,
          source: 'REFERRAL_DIRECT',
          sourceId: newUserId
        }
      });

      logger.info(REFERRAL_MESSAGES.DIRECT_REWARD_AWARDED(inviterId, DIRECT_REFERRAL_BONUS_POINTS));

      try {
        const distributionResult = await distributeUplineRewards(
          inviterId,
          DIRECT_REFERRAL_BONUS_POINTS,
          tx,
          `referral_direct_${newUserId}`
        );
        logger.info('Upline distribution completed for direct referral bonus', {
          inviterId,
          inviteeId: newUserId,
          baseReward: DIRECT_REFERRAL_BONUS_POINTS,
          distributionResult
        });
      } catch (distributionError) {
        logger.error('Upline distribution failed for direct referral bonus', {
          inviterId,
          inviteeId: newUserId,
          baseReward: DIRECT_REFERRAL_BONUS_POINTS,
          error: distributionError.message
        });
      }
    });

    await recordTaskProgress(inviterId, 'referral-1', 1);

    let currentInvitee = newUserId;
    for (let level = 2; level <= 4; level++) {
      const parent = await prisma.referral.findUnique({ where: { inviteeId: currentInvitee }, select: { inviterId: true } });
      if (!parent?.inviterId) break;
      await recordTaskProgress(parent.inviterId, `referral-${level}`, 1);
      logger.info(REFERRAL_MESSAGES.MULTILEVEL_PROGRESS(parent.inviterId, level));
      currentInvitee = parent.inviterId;
    }

    return { processed: true };
  } catch (error) {
    logger.error('Error processing referral rewards for invitee', { error: error.message, newUserId, inviterId });
    throw error;
  }
}

/**
 * Standard referral: link at signup, pay inviter only after invitee's first valid upload.
 */
async function tryProcessReferralRewardsIfEligible(newUserId, inviterId, referralCode) {
  if (!(await hasCompletedFirstValidUpload(newUserId))) {
    logger.info('Referral rewards deferred until invitee first valid upload', {
      inviteeId: newUserId,
      inviterId,
    });
    return { deferred: true };
  }
  return processReferralRewardsForInvitee(newUserId, inviterId, referralCode);
}

async function onInviteeFirstValidUpload(userId) {
  const referral = await prisma.referral.findUnique({
    where: { inviteeId: userId },
    select: { inviterId: true, code: true, campaignSlug: true },
  });
  if (!referral || referral.campaignSlug) {
    return { skipped: true };
  }
  return tryProcessReferralRewardsIfEligible(userId, referral.inviterId, referral.code);
}

async function processReferral(newUserId, inviterId, referralCode) {
  return tryProcessReferralRewardsIfEligible(newUserId, inviterId, referralCode);
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
  // Invites listed for referral UX: standard links only (campaigns use separate economics).
  const asInviter = await prisma.referral.findMany({
    where: { inviterId: userId, campaignSlug: null },
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
    })),
    rules: getReferralRulesPayload(),
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
    const referralData = await prisma.referral.create({
      data: {
        inviterId: inviter.id,
        inviteeId: userId,
        code,
        campaignSlug,
      },
    });

    if (campaignSlug === MOTHERS_DAY_2026_SLUG) {
      await processCampaignReferral(userId, inviter.id, campaignSlug);
    } else {
      await processReferral(userId, inviter.id, code);
    }

    return {
      inviterId: inviter.id,
      inviterName: inviter.name,
      inviteeId: userId,
      code: code,
      createdAt: referralData.createdAt,
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
  processReferralRewardsForInvitee,
  tryProcessReferralRewardsIfEligible,
  onInviteeFirstValidUpload,
  processCampaignReferral,
  getReferralStatus,
  useReferralCode,
  countCampaignInvitesAsInviter,
};