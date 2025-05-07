const prisma = require('../utils/prisma');
const { getTasksByAward } = require('./taskService');
const { getReferralOverview } = require('./referralService');

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
  // progress updates delegated to taskService.updateProgressForAwardTasks in getTasksByAward
  // fetch referral overview separately
  const referralOverview = await getReferralOverview(userId);

  // fetch all awards and user's awards
  const awardsRaw = await prisma.award.findMany({ select: { id: true, title: true, description: true, icon: true, color: true, metadata: true, status: true } });
  const userAwards = await prisma.userAward.findMany({ where: { userId }, select: { awardId: true, status: true, claimed: true } });
  const result = [];
  for (const award of awardsRaw) {
    const tasks = await getTasksByAward(userId, award.id);
    const total = tasks.length;
    const claimedCount = tasks.filter(t => t.claimed).length;
    const progress = total > 0 ? claimedCount / total : 0;
    // find userAward record
    const ua = userAwards.find(u => u.awardId === award.id) || { status: 'LOCKED', claimed: false };
    // compute finalStatus per award
    let finalStatus;
    if (ua.claimed) finalStatus = 'CLAIMED';
    else if (award.status === 'INVALID') finalStatus = 'INVALID';
    else if (award.status === 'LIVE' && ua.status === 'LOCKED') finalStatus = 'PARTICIPATE';
    else if (award.status === 'LOCKED' && ua.status === 'LOCKED') finalStatus = 'COMING_SOON';
    else if (ua.status === 'LIVE') {
      finalStatus = progress >= 1 ? 'COMPLETED' : 'IN_PROGRESS';
    } else finalStatus = 'COMING_SOON';
    result.push({
      awardId: award.id,
      title: award.title,
      description: award.description,
      icon: award.icon,
      color: award.color,
      metadata: award.metadata,
      totalTasks: total,
      claimedTasks: claimedCount,
      progress,
      finalStatus,
      tasks
    });
  }

  return { awards: result, referralOverview };
}

/**
 * Initialize UserAward entries for a new user, default LOCKED, claimed=false
 */
async function initializeUserAwards(userId) {
  const awards = await prisma.award.findMany({ select: { id: true } });
  const data = awards.map(a => ({ userId, awardId: a.id, status: 'LOCKED', claimed: false }));
  await prisma.userAward.createMany({ data, skipDuplicates: true });
}

module.exports = { getUserAwards, getAwardDefinitions, initializeUserAwards };
