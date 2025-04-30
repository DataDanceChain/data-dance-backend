// referral service: build referral overview up to 4 levels
const prisma = require('../utils/prisma');

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
  // fetch nested referrals up to 4 levels
  const referrals = await fetchReferrals(userId, 1, 4);
  // flatten to count network size
  const flatten = (nodes) => nodes.reduce((acc, n) => acc + 1 + flatten(n.referrals), 0);
  const networkSize = flatten(referrals);
  // referral earnings and activity: placeholder zeros
  const referralTotalEarning = 0;
  const networkActivity = 0;
  const unclaimReferralAwards = 0;
  return { referrals, networkSize, referralTotalEarning, networkActivity, unclaimReferralAwards };
}

async function claimReferralRewards(userId) {
  // 批量领取所有已完成且未领取的邀请任务奖励
  const uts = await prisma.userTask.findMany({
    where: { userId, completed: true, claimed: false, task: { awardId: 'referral-rewards' } },
    include: { task: true }
  });
  if (uts.length === 0) throw new Error('No referral rewards to claim');
  const totalPoints = uts.reduce((sum, ut) => sum + ut.task.points, 0);
  // 更新为已领取
  await prisma.userTask.updateMany({
    where: { userId, completed: true, claimed: false, task: { awardId: 'referral-rewards' } },
    data: { claimed: true }
  });
  // 记录积分流水
  const now = new Date();
  for (const ut of uts) {
    await prisma.point.create({ data: { userId, amount: ut.task.points, source: 'REFERRAL_CLAIM', sourceId: ut.taskId, createdAt: now } });
  }
  return { claimedAt: now, totalPoints, count: uts.length };
}

module.exports = { getReferralOverview, claimReferralRewards };