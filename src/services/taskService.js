const prisma = require('../utils/prisma');
const assetService = require('./assetService');
const xClient = require('../utils/xClient');
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
      
      // 2. For social engagement (X repost) tasks, check if the user has reposted (or quoted) the target post.
      if (task.metadata?.type === "X_RETWEET") {
        logger.info('Processing social engagement task', { userId, taskId, metadata: task.metadata });
        // Get bound X ID
        const user = await tx.user.findUnique({ where: { id: userId }, select: { xid: true } });
        if (!user?.xid) {
          logger.error('X account not bound', { userId });
          throw new Error("X account not bound");
        }
        const targetPostId = task.metadata.targetPostId;
        logger.info('Retrieved targetPostId', { targetPostId, xid: user.xid });
        if (!targetPostId) {
          logger.error('Target post ID missing in metadata', { metadata: task.metadata });
          throw new Error("Target post ID not defined");
        }
        // Check for repost
        let reposts;
        try {
          reposts = await xClient.postRetweetedBy(targetPostId);
          logger.info('Repost check response', { targetPostId, repostsData: reposts?.data });
        } catch (e) {
          logger.error('X API repost error', { postId: targetPostId, error: e });
        }
        // Check repost list
        const reposted = Array.isArray(reposts?.data) && reposts.data.some(u => {
          logger.info('Checking repost user', { repostUserId: u.id, userXid: user.xid });
          return u.id === user.xid;
        });
        logger.info('Repost check result', { reposted, xid: user.xid });
        
        if (!reposted) {
          logger.info('User not in repost list, performing quote search');
          // Perform quote search
          let quoteSearch;
          try {
            quoteSearch = await xClient.search(
              `from:${user.xid} is:quote`,
              { 'tweet.fields': 'referenced_tweets' }
            );
            logger.info('Quote search response', { 
              xid: user.xid, 
              quotesFound: quoteSearch?.data?.length,
              quotes: quoteSearch?.data?.map(t => ({ 
                id: t.id, 
                refs: t.referenced_tweets
              }))
            });
          } catch (e) {
            logger.error('X API quote error', { xid: user.xid, error: e });
          }
          const quoted = Array.isArray(quoteSearch?.data) && quoteSearch.data.some(tweet => {
            const hasQuote = tweet.referenced_tweets?.some(ref => {
              const isQuote = ref.type === 'quoted' && ref.id === targetPostId;
              logger.info('Checking quote reference', { 
                tweetId: tweet.id,
                refType: ref.type,
                refId: ref.id,
                targetId: targetPostId,
                isQuote
              });
              return isQuote;
            });
            logger.info('Quote check result', { tweetId: tweet.id, hasQuote });
            return hasQuote;
          });
          
          if (!quoted) {
            logger.error('User failed public repost verification', { userId, xid: user.xid, targetPostId });
            throw new Error('Public repost not detected');
          } else {
            logger.info('User passed quote verification', { userId, xid: user.xid, targetPostId });
          }
        } else {
          logger.info('User passed repost verification', { userId, xid: user.xid, targetPostId });
        }
      }
      // Log that social engagement check passed or was skipped
      logger.info('Social engagement verification passed', { userId, taskId, type: task.metadata?.type });

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
    return { status, error: { code: error.code || "UNKNOWN", message, details: error } };
  }
}

function handleClaimError(error) {
  if (error.code === "P2025") { return { status: 404, message: "Task not found" }; }
  if (error.code === "P2002") { return { status: 409, message: "Task already claimed" }; }
  if (error.message === "X account not bound") { return { status: 400, message: "X account not bound" }; }
  if (error.message === "Public repost not detected") { return { status: 400, message: "Public repost not detected" }; }
  return { status: 500, message: "Internal server error" };
}

module.exports = { getTasksByAward, recordTaskProgress, claimTask };