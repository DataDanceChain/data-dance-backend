const prisma = require('../utils/prisma');
const assetService = require('./assetService');

// Strategy map for award-specific unlock and progress logic
const awardStrategies = {
  'profile-awards': {
    unlock: async (userId) => {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user.name && user.email && user.avatar) await recordTaskProgress(userId, 'profile-1', 1);
    },
    prepare: async (userId) => ({ user: await prisma.user.findUnique({ where: { id: userId } }) }),
    computeProgress: async (task, userId, { user }) => {
      const filled = ['name','email','avatar'].reduce((c,f) => c + (user[f] ? 1 : 0), 0);
      return filled / 3;
    }
  },
  'early-registration': {
    unlock: async (userId) => {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user.createdAt < new Date('2025-06-01')) await recordTaskProgress(userId, 'early-1', 1);
    },
    // prepare user date for progress calculation
    prepare: async (userId) => ({ user: await prisma.user.findUnique({ where: { id: userId } }) }),
    // progress is 1 if user created before cutoff, else 0
    computeProgress: async (task, userId, { user }) => {
      return user.createdAt < new Date('2025-06-01') ? 1 : 0;
    }
  },
  'referral-rewards': {
    unlock: async (userId) => {
      // always create a live record so the referral task/card is visible with progress 0
      await recordTaskProgress(userId, 'referral-1', 1);
    },
    prepare: async (userId) => {
      // dynamically require to avoid circular dependency
      const { getReferralOverview } = require('./referralService');
      return { referralOverview: await getReferralOverview(userId) };
    },
    computeProgress: async (task, userId, { referralOverview }) => referralOverview.networkSize || 0
  },
  'assets-collection': {
    unlock: async (userId) => { const count = await assetService.getUserNFTCount(userId);
      [1,3,5].forEach(async (n,i) => count>=n && await recordTaskProgress(userId, `assets-${i+1}`,1));
    },
    prepare: async (userId) => ({ nftCount: await assetService.getUserNFTCount(userId) }),
    computeProgress: async (task, userId, { nftCount }) => {
      // thresholds per task index: assets-1=3, assets-2=10, assets-3=20, assets-4=50, assets-5=100
      const thresholds = [3, 10, 20, 50, 100];
      const idx = parseInt(task.id.split('-')[1], 10) - 1;
      const threshold = thresholds[idx] || (task.claimLimit || 1);
      return Math.min(nftCount / threshold, 1);
    }
  },
  'badge-collection': {
    unlock: async (userId) => { const count = await assetService.getUserBadgeCount(userId);
      [1,3,5].forEach(async (n,i) => count>=n && await recordTaskProgress(userId, `badge-${i+1}`,1));
    },
    prepare: async (userId) => ({ badgeCount: await assetService.getUserBadgeCount(userId) }),
    computeProgress: async (task, userId, { badgeCount }) => {
      // thresholds per task index: badge-1=3, badge-2=5, badge-3=10, badge-4=20
      const thresholds = [3, 5, 10, 20];
      const idx = parseInt(task.id.split('-')[1], 10) - 1;
      const threshold = thresholds[idx] || (task.claimLimit || 1);
      return Math.min(badgeCount / threshold, 1);
    }
  },
  'ddc-holdings': {
    unlock: async (userId) => { const bal = await assetService.getDDCBalance(userId);
      [50,100,200,500,1000].forEach(async t => bal>=t && await recordTaskProgress(userId, `ddc-${t}`,1));
    },
    prepare: async (userId) => ({ ddcBalance: await assetService.getDDCBalance(userId) }),
    computeProgress: async (task, userId, { ddcBalance }) => {
      // thresholds per task index: ddc-1=10, ddc-2=50, ddc-3=100, ddc-4=200, ddc-5=500, ddc-6=1000, ddc-7=2000, ddc-8=5000
      const thresholds = [10, 50, 100, 200, 500, 1000, 2000, 5000];
      const idx = parseInt(task.id.split('-')[1], 10) - 1;
      const threshold = thresholds[idx] || (task.claimLimit || 1);
      return Math.min(ddcBalance / threshold, 1);
    }
  }
};

async function getTasksByAward(userId, awardId) {
  // Unlock tasks based on award-specific conditions
  await updateProgressForAwardTasks(userId, awardId);
  // Fetch static tasks and userTask records
  const tasks = await prisma.task.findMany({ where: { awardId }, select: { id:true, title:true, description:true, points:true, claimLimit:true, prerequisiteTaskId:true }});
  const userTasks = await prisma.userTask.findMany({ where: { userId } });
  const strategy = awardStrategies[awardId] || {};
  // Prepare shared context if needed
  const context = strategy.prepare ? await strategy.prepare(userId) : {};
  // Compute progress and finalStatus for each task
  return Promise.all(tasks.map(async task => {
    const ut = userTasks.find(u => u.taskId === task.id);
    const claimRecords = ut?.claimRecords || [];
    const limit = task.claimLimit ?? 1;
    // Compute progress via strategy or default
    const progress = strategy.computeProgress
      ? await strategy.computeProgress(task, userId, { ...context })
      : (limit > 0 ? Math.min(claimRecords.length / limit, 1) : null);
    const claimed = claimRecords.length >= limit;
    // determine if prerequisite task is done
    const prereqDone = !task.prerequisiteTaskId || (userTasks.find(u => u.taskId === task.prerequisiteTaskId)?.claimRecords.length > 0);

    // determine finalStatus per task
    let finalStatus;
    if (claimed) {
      finalStatus = 'CLAIMED';
    } else if (!prereqDone) {
      finalStatus = 'LOCKED';
    } else if (awardId === 'referral-rewards' && progress >= 0 && progress < 1) {
      // referral-rewards: always show IN_PROGRESS even at 0
      finalStatus = 'IN_PROGRESS';
    } else if (progress > 0 && progress < 1) {
      finalStatus = 'IN_PROGRESS';
    } else if (progress >= 1) {
      finalStatus = 'COMPLETED';
    } else {
      finalStatus = 'LOCKED';
    }

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      points: task.points,
      claimLimit: task.claimLimit,
      prerequisiteTaskId: task.prerequisiteTaskId,
      claimRecords,
      claimed,
      progress,
      finalStatus
    };
  }));
}

async function updateProgressForAwardTasks(userId, awardId) {
  const strategy = awardStrategies[awardId]?.unlock;
  if (strategy) await strategy(userId);
}

async function recordTaskProgress(userId, taskId, delta) {
  const ut = await prisma.userTask.upsert({
    where: { userId_taskId: { userId, taskId } },
    update: { status: 'LIVE', claimed: false },
    create: { userId, taskId, status: 'LIVE', claimed: false }
  });
  return ut;
}

async function claimTask(userId, taskId) {
  const ut = await prisma.userTask.findUnique({ where: { userId_taskId: { userId, taskId } }, include: { task: true } });
  if (!ut || ut.status !== 'LIVE') throw new Error('Task not claimable');
  const now = new Date();
  // append claim timestamp and update status if limit reached
  const isFinal = ut.task.claimLimit != null && (ut.claimRecords.length + 1) >= ut.task.claimLimit;
  const updates = { claimRecords: { push: now }, claimed: true };
  if (isFinal) updates.status = 'INVALID';
  await prisma.userTask.update({ where: { userId_taskId: { userId, taskId } }, data: updates });

  // award points
  await prisma.point.create({ data: { userId, amount: ut.task.points, source: 'TASK_CLAIM', sourceId: taskId } });
  // unlock dependent tasks whose prerequisite is this task
  const dependents = await prisma.task.findMany({ where: { prerequisiteTaskId: taskId }, select: { id: true } });
  for (const dt of dependents) {
    await recordTaskProgress(userId, dt.id, 1);
  }
  return { claimedAt: now, points: ut.task.points };
}

module.exports = { getTasksByAward, recordTaskProgress, claimTask };