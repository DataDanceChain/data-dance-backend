const prisma = require('../utils/prisma');
const { recordTaskProgress, getTasksByAward } = require('./taskService');
const { getReferralOverview } = require('./referralService');
const assetService = require('./assetService');

/**
 * Fetch platform award definitions (id, title, description, icon, color, status, metadata)
 */
async function getAwardDefinitions() {
  return prisma.award.findMany({
    select: {
      id: true,
      title: true,
      description: true,
      icon: true,
      color: true,
      status: true,
      metadata: true
    }
  });
}

/**
 * Fetch and process all awards and tasks for a user.
 * All business logic (progress checks, status updates) happens here.
 * Returns final award/task statuses and referral overview.
 */
async function getUserAwards(userId) {
  // load user profile
  const user = await prisma.user.findUnique({ where: { id: userId } });

  // 1. Profile completion
  if (user.name && user.email && user.avatar) {
    await recordTaskProgress(userId, 'profile-1', 1);
  }

  // 2. Early registration
  const cutoff = new Date('2025-06-01');
  if (user.createdAt < cutoff) {
    await recordTaskProgress(userId, 'early-1', 1);
  }

  // 3. Invite friends: referral progress happens in processReferral on signup
  const referralOverview = await getReferralOverview(userId);

  // 4. NFT collection
  const nftCount = await assetService.getUserNFTCount(userId);
  [1, 3, 5].forEach(async (n, i) => {
    if (nftCount >= n) await recordTaskProgress(userId, `assets-${i+1}`, 1);
  });

  // 5. Badge collection
  const badgeCount = await assetService.getUserBadgeCount(userId);
  [1, 3, 5].forEach(async (n, i) => {
    if (badgeCount >= n) await recordTaskProgress(userId, `badge-${i+1}`, 1);
  });

  // 6. DDC holdings
  const balance = await assetService.getDDCBalance(userId);
  [50, 100, 200, 500, 1000].forEach(async (threshold, idx) => {
    if (balance >= threshold) await recordTaskProgress(userId, `ddc-${threshold}`, 1);
  });

  // 7. Social engagement: implementation depends on external hook, assume ut updated elsewhere

  // assemble final awards
  const awards = await prisma.award.findMany({ where: { status: 'LIVE' } });
  const result = [];
  for (const award of awards) {
    const tasks = await getTasksByAward(userId, award.id);
    result.push({
      awardId: award.id,
      title: award.title,
      description: award.description,
      status: award.status,
      tasks
    });
  }

  return { awards: result, referralOverview };
}

module.exports = { getUserAwards, getAwardDefinitions };
