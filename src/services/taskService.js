const prisma = require('../utils/prisma');
const assetService = require('./assetService');
const xService = require('./xService'); // New: use xService
const { distributeUplineRewards } = require('./distributionService'); // Import distribution service
const { createLogger } = require('../utils/logger');
const logger = createLogger('taskService');

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
    prepare: async (userId) => {
      const ddcBalance = await assetService.getDDCBalance(userId);
      return { ddcBalance };
    },
    unlock: async (userId, { ddcBalance }) => {
      // fetch all DDC tasks and mark those with requirementCount <= balance as unlocked
      const tasks = await prisma.task.findMany({
        where: { awardId: 'ddc-holdings', requirementCount: { not: null } },
        select: { id: true, requirementCount: true }
      });
      for (const t of tasks) {
        if (t.requirementCount != null && ddcBalance >= t.requirementCount) {
          await recordTaskProgress(userId, t.id, 1);
        }
      }
    },
    computeProgress: async (task, userId, { ddcBalance }) => {
      // Progress is ddcBalance relative to requirementCount
      if (!task.requirementCount) return 0;
      return Math.min(ddcBalance / task.requirementCount, 1);
    }
  },
  'social-engagement': {
    // ensure social tasks visible immediately
    unlock: async (userId) => {
      const tasks = await prisma.task.findMany({ where: { awardId: 'social-engagement' }, select: { id: true } });
      for (const t of tasks) {
        await recordTaskProgress(userId, t.id, 1);
      }
    }
  },
  'amazon-data-collection': {
    unlock: async (userId) => {
      // Amazon tasks are always unlocked for users
      await recordTaskProgress(userId, 'amazon-order-submit', 1);
    },
    prepare: async (userId) => {
      // Get user's Amazon data submission count
      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      
      const dailyCount = await prisma.crawlerData.count({
        where: {
          userId,
          source: 'amazon',
          createdAt: { gte: startOfDay }
        }
      });
      
      const totalCount = await prisma.crawlerData.count({
        where: {
          userId,
          source: 'amazon'
        }
      });
      
      return { dailyCount, totalCount };
    },
    computeProgress: async (task, userId, { dailyCount, totalCount }) => {
      // Progress represents total number of data items submitted (unlimited task)
      // Return total count as integer representing completion quantity
      return totalCount;
    }
  }
};

async function getTasksByAward(userId, awardId) {
  const strategy = awardStrategies[awardId] || {};
  // Prepare context (e.g., ddcBalance) once
  const context = strategy.prepare ? await strategy.prepare(userId) : {};
  // Unlock tasks using context
  if (strategy.unlock) await strategy.unlock(userId, context);
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
      prerequisiteTaskId: true,
      picture: true,
      metadata: true
    }
  });
  const userTasks = await prisma.userTask.findMany({ where: { userId } });
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
    } else if (awardId === 'amazon-data-collection' && progress > 0) {
      // Amazon data collection: unlimited task, always IN_PROGRESS when has submissions
      finalStatus = 'IN_PROGRESS';
    } else if ((awardId === 'referral-rewards' || awardId === 'social-engagement') && progress >= 0 && progress < 1) {
      // referral and social tasks: always show IN_PROGRESS even at 0
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
        case 'amazon-data-collection':
          // For unlimited tasks, doneCount equals progress (total submissions)
          doneCount = progress;
          break;
        default:
          doneCount = Math.min(Math.floor(progress * task.requirementCount), task.requirementCount);
      }
    } else {
      // For tasks without requirementCount (like Amazon data collection)
      if (awardId === 'amazon-data-collection') {
        doneCount = progress; // progress is already the total count for unlimited tasks
      } else {
        // fallback: either fully claimed or zero
        const total = task.claimLimit ?? 1;
        doneCount = claimed ? total : 0;
      }
    }
    return {
      id: task.id,
      title: task.title,
      // always include core fields
      points: task.points,
      doneCount,
      claimRecords,
      claimed,
      progress,
      finalStatus,
      // include optional fields only when they have content
      ...(task.description ? { description: task.description } : {}),
      ...(task.claimLimit != null ? { claimLimit: task.claimLimit } : {}),
      ...(task.requirementCount != null ? { requirementCount: task.requirementCount } : {}),
      ...(task.picture ? { picture: task.picture } : {}),
      ...(task.metadata && Object.keys(task.metadata).length > 0 ? { metadata: task.metadata } : {})
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
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Check task status (and include userTasks for claimed check)
      const task = await tx.task.findUnique({
        where: { id: taskId },
        include: { UserTasks: { where: { userId } } }
      });
      logger.info('Loaded task for claim', { userId, taskId, metadata: task?.metadata });
      if (!task) {
        logger.error('Task not found during claim', { userId, taskId });
        throw new Error("Task not found");
      }
      if (task.UserTasks[0]?.claimed) {
        logger.error('Task already claimed', { userId, taskId });
        throw new Error("Task already claimed");
      }

      // 1.5. 校验业务完成条件（progress >= 1）
      const strategy = awardStrategies[task.awardId];
      const context = strategy?.prepare ? await strategy.prepare(userId) : {};
      const progress = strategy?.computeProgress
        ? await strategy.computeProgress(task, userId, context)
        : 1; // 默认为1，兼容无策略的任务
      if (progress < 1) {
        logger.error('Task not completed, cannot claim', { userId, taskId, progress });
        throw new Error('Task not completed, cannot claim');
      }

      // 2. For social engagement (X repost/quote) tasks, verify engagement using xService
      if (task.metadata?.type === "X_RETWEET") {
        logger.info('Processing X_RETWEET social engagement task', { userId, taskId, metadata: task.metadata });
        const targetPostId = task.metadata.targetPostId;

        try {
          const isEngaged = await xService.verifyUserEngagement(userId, targetPostId);
          if (!isEngaged) {
            logger.warn('User X engagement verification failed (via xService)', { userId, targetPostId });
            throw new Error('Public X engagement (retweet or quote) not detected');
          }
          logger.info('User X engagement verified successfully (via xService)', { userId, targetPostId });
        } catch (error) {
          // Errors from xService.verifyUserEngagement (e.g., X account not bound, targetPostId missing, or X API client errors)
          logger.error('Error during X engagement verification (via xService)', { userId, targetPostId, error: error.message });
          // Re-throw to be caught by the main try-catch of claimTask
          // Ensure the error message is one that handleClaimError can interpret or pass a generic one.
          throw new Error(error.message || 'X engagement verification failed'); 
        }
      }
      // Log that social engagement check passed or was skipped
      logger.info('Social engagement verification passed or not applicable', { userId, taskId, type: task.metadata?.type });

      // 3. Update userTask with claimRecords and claimed flag, then userAward and points
      logger.info('Processing claimRecords for task', { userId, taskId, claimLimit: task.claimLimit });
      const existingUserTask = await tx.userTask.findUnique({
        where: { userId_taskId: { userId, taskId } },
        select: { claimRecords: true }
      });
      const now = new Date();
      const newClaimRecords = [...(existingUserTask?.claimRecords || []), now];
      // For continuous tasks, flip claimed when reach limit; for one-time default to true
      const isClaimedFlag = task.claimLimit != null ? newClaimRecords.length >= task.claimLimit : true;
      logger.info('New claimRecords and computed claimed flag', { userId, taskId, newClaimRecords, claimed: isClaimedFlag });

      let updatedUserTask;
      if (existingUserTask) {
        updatedUserTask = await tx.userTask.update({
          where: { userId_taskId: { userId, taskId } },
          data: { claimRecords: newClaimRecords, claimed: isClaimedFlag }
        });
      } else {
        updatedUserTask = await tx.userTask.create({
          data: { userId, taskId, claimRecords: newClaimRecords, claimed: isClaimedFlag }
        });
      }

      // Upsert userAward
      const updatedUserAward = await tx.userAward.upsert({
        where: { userId_awardId: { userId, awardId: task.awardId } },
        update: {},
        create: { userId, awardId: task.awardId }
      });

      // 发放积分流水
      await tx.point.create({ data: {
        userId,
        amount: task.points,
        source: 'TASK_CLAIM',
        sourceId: taskId
      }});

      // 新增: 处理上级分润奖励（所有任务都享受分润）
      try {
        const distributionResult = await distributeUplineRewards(userId, task.points, tx, taskId);
        logger.info('上级分润处理完成', {
          userId,
          taskId,
          baseReward: task.points,
          distributionResult
        });
      } catch (distributionError) {
        // 分润失败不影响主任务完成，但需要记录错误
        logger.error('上级分润处理失败', {
          userId,
          taskId,
          baseReward: task.points,
          error: distributionError.message
        });
        // 这里选择继续执行而不是抛出错误，确保用户的主要奖励不受影响
        // 生产环境中可能需要更严格的错误处理策略
      }

      // Return enriched response with claimedAt and points
      return { success: true, data: { taskId, claimedAt: updatedUserTask.updatedAt, points: task.points } };
    });
    // Log successful claim or validation result
    logger.info('claimTask result', { userId, taskId, result: result.data });
    return { status: "success", data: result.data };
  } catch (error) {
    // Log error details for failed claim (e.g., X repost check failure)
    logger.error('claimTask error', { userId, taskId, message: error.message, stack: error.stack });
    const { status, message } = handleClaimError(error);
    return { status, error: { code: error.code || "UNKNOWN", message, details: error.message } }; // Pass error.message to details
  }
}

function handleClaimError(error) {
  if (error.code === "P2025") { return { status: 404, message: "Task not found" }; }
  if (error.code === "P2002") { return { status: 409, message: "Task already claimed" }; }
  if (error.message === "X account not bound") { return { status: 400, message: "X account not bound" }; }
  // Updated error message check for a more generic engagement failure from xService
  if (error.message === "Public X engagement (retweet or quote) not detected" || error.message === 'X engagement verification failed') { 
    return { status: 400, message: "Public X engagement (retweet or quote) not detected" }; 
  }
  if (error.message === "Target post ID not defined") { return { status: 400, message: "Target post ID not defined for X task"}; }
  return { status: 500, message: error.message || "Internal server error" }; // Return the actual error message if not one of the above
}

/**
 * Check Christmas shopping tasks completion status for a user
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Task status object with canClaim, tasksCompleted, totalTasks, missingTasks
 */
async function checkChristmasShoppingTasks(userId) {
  const CHRISTMAS_AWARD_ID = 'christmas-shopping';
  
  try {
    const tasks = await getTasksByAward(userId, CHRISTMAS_AWARD_ID);
    
    if (!tasks || tasks.length === 0) {
      // If no tasks found, assume not eligible
      return {
        canClaim: false,
        tasksCompleted: 0,
        totalTasks: 0,
        missingTasks: []
      };
    }
    
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.finalStatus === 'COMPLETED' || t.claimed);
    const tasksCompleted = completedTasks.length;
    const canClaim = tasksCompleted === totalTasks && totalTasks > 0;
    
    // Get missing tasks (not completed and not claimed)
    const missingTasks = tasks
      .filter(t => t.finalStatus !== 'COMPLETED' && !t.claimed)
      .map(t => ({
        taskId: t.id,
        title: t.title,
        currentCount: t.doneCount || 0,
        requiredCount: t.requirementCount || 1,
        progress: t.progress || 0
      }));
    
    return {
      canClaim,
      tasksCompleted,
      totalTasks,
      missingTasks
    };
  } catch (error) {
    logger.error('Error checking Christmas shopping tasks:', error);
    // Return safe default
    return {
      canClaim: false,
      tasksCompleted: 0,
      totalTasks: 0,
      missingTasks: []
    };
  }
}

module.exports = { getTasksByAward, recordTaskProgress, claimTask, checkChristmasShoppingTasks };