// referral service: build referral overview up to 3 levels
const prisma = require('../utils/prisma');
const { recordTaskProgress } = require('./taskService');

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
  return { referrals, levelCounts, earnedByLevel, totalReferralPoints, unclaimReferralAwards };
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
 */
async function processReferral(newUserId, inviterId) {
  // create direct referral record
  await prisma.referral.create({ data: { inviterId, inviteeId: newUserId } });

  // record direct referral task (50 points) to be claimed later
  await recordTaskProgress(inviterId, 'referral-1', 1);
  
  // record multi-level referral tasks for levels 2–4
  let currentInvitee = newUserId;
  for (let level = 2; level <= 4; level++) {
    const parent = await prisma.referral.findUnique({ where: { inviteeId: currentInvitee }, select: { inviterId: true } });
    if (!parent?.inviterId) break;
    await recordTaskProgress(parent.inviterId, `referral-${level}`, 1);
    currentInvitee = parent.inviterId;
  }
}

module.exports = { getReferralOverview, claimReferralRewards, processReferral };