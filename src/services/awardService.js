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
    const completedCount = tasks.filter(t => t.finalStatus === 'COMPLETED').length;
    
    // Calculate progress based on requirements
    let progress;
    if (total === 1) {
      // If only one task, use its progress directly
      progress = tasks[0].progress || 0;
    } else {
      // For multiple tasks, use completed tasks / total tasks
      progress = total > 0 ? completedCount / total : 0;
    }

    // find userAward record
    const ua = userAwards.find(u => u.awardId === award.id) || { status: 'LOCKED', claimed: false };
    
    // compute finalStatus per award based on task statuses
    let finalStatus;
    if (claimedCount === total && total > 0) {
      finalStatus = 'CLAIMED';
    } else if (completedCount === total && total > 0) {
      finalStatus = 'COMPLETED';
    } else if (completedCount > 0 || claimedCount > 0) {
      finalStatus = 'IN_PROGRESS';
    } else if (award.status === 'LIVE' && ua.status === 'LOCKED') {
      finalStatus = 'PARTICIPATE';
    } else if (award.status === 'LOCKED') {
      finalStatus = 'COMING_SOON';
    } else {
      finalStatus = 'PARTICIPATE';
    }

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
