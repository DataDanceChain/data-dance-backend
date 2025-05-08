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
      const total = task.requirementCount ?? 3;
      return total > 0 ? filled / total : 0;
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
      // use requirementCount if defined, otherwise fallback thresholds
      const thresholds = [3, 10, 20, 50, 100];
      const idx = parseInt(task.id.split('-')[1], 10) - 1;
      const threshold = task.requirementCount ?? thresholds[idx] ?? (task.claimLimit || 1);
      return threshold > 0 ? Math.min(nftCount / threshold, 1) : 0;
    }
  },
  'badge-collection': {
    unlock: async (userId) => { const count = await assetService.getUserBadgeCount(userId);
      [1,3,5].forEach(async (n,i) => count>=n && await recordTaskProgress(userId, `badge-${i+1}`,1));
    },
    prepare: async (userId) => ({ badgeCount: await assetService.getUserBadgeCount(userId) }),
    computeProgress: async (task, userId, { badgeCount }) => {
      const thresholds = [3, 5, 10, 20];
      const idx = parseInt(task.id.split('-')[1], 10) - 1;
      const threshold = task.requirementCount ?? thresholds[idx] ?? (task.claimLimit || 1);
      return threshold > 0 ? Math.min(badgeCount / threshold, 1) : 0;
    }
  },
  'ddc-holdings': {
    unlock: async (userId) => { const bal = await assetService.getDDCBalance(userId);
      [50,100,200,500,1000].forEach(async t => bal>=t && await recordTaskProgress(userId, `ddc-${t}`,1));
    },
    prepare: async (userId) => ({ ddcBalance: await assetService.getDDCBalance(userId) }),
    computeProgress: async (task, userId, { ddcBalance }) => {
      const thresholds = [10, 50, 100, 200, 500, 1000, 2000, 5000];
      const idx = parseInt(task.id.split('-')[1], 10) - 1;
      const threshold = task.requirementCount ?? thresholds[idx] ?? (task.claimLimit || 1);
      return threshold > 0 ? Math.min(ddcBalance / threshold, 1) : 0;
    }
  }
};

async function getTasksByAward(userId, awardId) {
  // Unlock tasks based on award-specific conditions
  await updateProgressForAwardTasks(userId, awardId);
  // Fetch static tasks and userTask records
  const tasks = await prisma.task.findMany({
    where: { awardId },
    select: {
      id: true,
      title: true,
      description: true,
      points: true,
      claimLimit: true,
      requirementCount: true,
      prerequisiteTaskId: true
    }
  });
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

    // compute doneCount based on requirementCount and context per award type
    let doneCount;
    if (task.requirementCount != null) {
      switch (awardId) {
        case 'profile-awards': {
          // count filled profile fields
          const filled = ['name','email','avatar'].reduce((c, f) => c + (context.user[f] ? 1 : 0), 0);
          doneCount = Math.min(filled, task.requirementCount);
          break;
        }
        case 'assets-collection':
          doneCount = Math.min(context.nftCount, task.requirementCount);
          break;
        case 'badge-collection':
          doneCount = Math.min(context.badgeCount, task.requirementCount);
          break;
        case 'ddc-holdings':
          doneCount = Math.min(context.ddcBalance, task.requirementCount);
          break;
        default:
          doneCount = Math.min(Math.floor(progress * task.requirementCount), task.requirementCount);
      }
    } else {
      // fallback: either fully claimed or zero
      const total = task.claimLimit ?? 1;
      doneCount = claimed ? total : 0;
    }
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      points: task.points,
      claimLimit: task.claimLimit,
      requirementCount: task.requirementCount,
      doneCount,
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
    update: { status: 'LIVE' },
    create: { userId, taskId, status: 'LIVE' }
  });
  return ut;
}

async function claimTask(userId, taskId) {
  // fetch userTask with claimRecords and claimed flag
  const ut = await prisma.userTask.findUnique({
    where: { userId_taskId: { userId, taskId } },
    select: {
      claimRecords: true,
      claimed: true,
      status: true,
      task: { select: { claimLimit: true, points: true } }
    }
  });
  // only allow claim if live, not already claimed, and below limit
  // treat null claimLimit as unlimited
  const limit = ut.task.claimLimit != null ? ut.task.claimLimit : Infinity;
  if (!ut || ut.status !== 'LIVE' || ut.claimed || ut.claimRecords.length >= limit) {
    throw new Error('Task not claimable');
  }
  const now = new Date();
  // append claim timestamp and set claimed flag; if last claim, mark invalid
  const newCount = ut.claimRecords.length + 1;
  // only finalize if claimLimit is defined
  const isFinal = ut.task.claimLimit != null && newCount >= ut.task.claimLimit;
  await prisma.userTask.update({
    where: { userId_taskId: { userId, taskId } },
    data: {
      claimRecords: { push: now },
      claimed: true,
      ...(isFinal ? { status: 'INVALID' } : {})
    }
  });

  // award points
  await prisma.point.create({ data: { userId, amount: ut.task.points, source: 'TASK_CLAIM', sourceId: taskId } });
  // unlock dependent tasks whose prerequisite is this task
  const dependents = await prisma.task.findMany({ where: { prerequisiteTaskId: taskId }, select: { id: true } });
  for (const dt of dependents) {
    await recordTaskProgress(userId, dt.id, 1);
  }
  // If all tasks under this award are now claimed, mark the UserAward as claimed and invalid
  const { awardId } = await prisma.task.findUnique({ where: { id: taskId }, select: { awardId: true } });
  const totalTasks = await prisma.task.count({ where: { awardId } });
  const claimedTasks = await prisma.userTask.count({ where: { userId, task: { awardId }, claimed: true } });
  if (claimedTasks >= totalTasks) {
    await prisma.userAward.update({
      where: { userId_awardId: { userId, awardId } },
      data: { claimed: true, status: 'INVALID' }
    });
  }
  return { claimedAt: now, points: ut.task.points };
}

module.exports = { getTasksByAward, recordTaskProgress, claimTask };