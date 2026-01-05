const prisma = require('../utils/prisma');
const { getTasksByAward } = require('./taskService');
const { getReferralOverview } = require('./referralService');
const { awards: awardConfig } = require('../../config/awards.json');

/**
 * Fetch platform award definitions (id, title, description, icon, color, status, metadata)
 * Returns awards in the same order as defined in awards.json
 */
async function getAwardDefinitions() {
  // First get all awards from database
  const awards = await prisma.award.findMany({
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

  // Create a map for quick lookup
  const awardMap = new Map(awards.map(award => [award.id, award]));

  // Return awards in the order defined in awards.json, filtering out disabled awards and null values
  return awardConfig
    .filter(config => config.enabled !== false)
    .map(config => awardMap.get(config.id))
    .filter(award => award !== null && award !== undefined); // Filter out null/undefined awards
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
  const awardsRaw = await prisma.award.findMany({ 
    select: { id: true, title: true, description: true, icon: true, color: true, metadata: true, status: true } 
  });
  const userAwards = await prisma.userAward.findMany({ 
    where: { userId }, 
    select: { awardId: true, status: true, claimed: true } 
  });

  // Create a map for quick lookup
  const awardMap = new Map(awardsRaw.map(award => [award.id, award]));
  const userAwardMap = new Map(userAwards.map(ua => [ua.awardId, ua]));

  // Process awards in the order defined in awards.json, filtering out disabled awards
  const result = [];
  for (const config of awardConfig) {
    if (config.enabled === false) continue; // Skip disabled awards
    const award = awardMap.get(config.id);
    if (!award) continue; // Skip if award not found in database

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
    const ua = userAwardMap.get(award.id) || { status: 'DISABLED', claimed: false };
    
    // compute finalStatus per award based on task statuses
    let finalStatus;
    if (claimedCount === total && total > 0) {
      finalStatus = 'CLAIMED';
    } else if (completedCount === total && total > 0) {
      finalStatus = 'COMPLETED';
    } else if (completedCount > 0 || claimedCount > 0) {
      finalStatus = 'IN_PROGRESS';
    } else if (award.status === 'LIVE' && ua.status === 'DISABLED') {
      finalStatus = 'PARTICIPATE';
    } else if (award.status === 'DISABLED') {
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
 * Initialize UserAward entries for a new user, default DISABLED, claimed=false
 */
async function initializeUserAwards(userId) {
  const awards = await prisma.award.findMany({ select: { id: true } });
  const data = awards.map(a => ({ userId, awardId: a.id, status: 'DISABLED', claimed: false }));
  await prisma.userAward.createMany({ data, skipDuplicates: true });
}

module.exports = { getUserAwards, getAwardDefinitions, initializeUserAwards };
