const prisma = require('../utils/prisma');
const assetService = require('./assetService');
const xService = require('./xService'); // New: use xService
const { distributeUplineRewards } = require('./distributionService'); // Import distribution service
const { TASK_TEMPLATES } = require('./crawlerService'); // For resolving crawler task URLs
const { createLogger } = require('../utils/logger');
const logger = createLogger('taskService');

/**
 * Look up the crawler task URL by crawlerTaskId (e.g. "luma_events").
 * Returns origin + path (e.g. "https://lu.ma/home?period=past") or null.
 */
function getCrawlerTaskUrl(crawlerTaskId) {
  if (!crawlerTaskId) return null;
  for (const templates of Object.values(TASK_TEMPLATES)) {
    const tpl = templates.find(t => t.taskId === crawlerTaskId);
    if (tpl) return `${tpl.origin}${tpl.path}`;
  }
  return null;
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function hasDailyEvent(userId, type, day = startOfUtcDay(new Date())) {
  const existing = await prisma.userDailyEvent.findUnique({
    where: { userId_type_day: { userId, type, day } },
    select: { id: true }
  });
  return !!existing;
}

async function getConsecutiveCheckInStreak(userId, today = startOfUtcDay(new Date())) {
  // Fetch recent check-ins (enough to cover the 7-day cap)
  const recent = await prisma.userDailyEvent.findMany({
    where: { userId, type: 'CHECK_IN', day: { lte: today } },
    orderBy: { day: 'desc' },
    take: 10,
    select: { day: true }
  });
  const set = new Set(recent.map(r => r.day.toISOString()));
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    if (set.has(d.toISOString())) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

async function countCheckInsSince(userId, sinceDay) {
  return prisma.userDailyEvent.count({
    where: {
      userId,
      type: 'CHECK_IN',
      day: { gte: sinceDay }
    }
  });
}

function isRecurringDailyTask(task) {
  return task?.metadata?.recurring === 'DAILY' || task?.metadata?.type === 'DAILY_CHECK_IN' || task?.metadata?.type === 'REWARDS_HUB_VISIT' || task?.metadata?.type === 'DAILY_FIRST_UPLOAD';
}

function hasClaimRecordOnDay(claimRecords, day) {
  const dayIso = day.toISOString();
  return (claimRecords || []).some((ts) => startOfUtcDay(new Date(ts)).toISOString() === dayIso);
}

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
  'new-user-bonus': {
    prepare: async (userId) => {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
      const campaignStart = startOfUtcDay(user?.createdAt || new Date());
      const campaignEnd = new Date(campaignStart);
      campaignEnd.setUTCDate(campaignEnd.getUTCDate() + 30);

      const checkInCount = await countCheckInsSince(userId, campaignStart);

      const sources = ['amazon', 'booking', 'airbnb', 'luma'];
      const uploadedSources = await Promise.all(
        sources.map(async (source) => {
          const count = await prisma.crawlerData.count({ where: { userId, source } });
          return count > 0 ? source : null;
        })
      );
      const distinctUploads = uploadedSources.filter(Boolean);

      return { campaignStart, campaignEnd, checkInCount, distinctUploadCount: distinctUploads.length };
    },
    unlock: async (userId, ctx) => {
      const now = new Date();
      if (now > ctx.campaignEnd) return;
      // Ensure tasks exist as visible records (so finalStatus is not LOCKED)
      await recordTaskProgress(userId, 'new-user-welcome-bonus', 1);
      await recordTaskProgress(userId, 'new-user-3day-checkin', 1);
      await recordTaskProgress(userId, 'new-user-first-upload', 1);
      await recordTaskProgress(userId, 'new-user-explore-more', 1);
    },
    computeProgress: async (task, userId, ctx) => {
      const now = new Date();
      if (now > ctx.campaignEnd) return 0;
      if (task.id === 'new-user-welcome-bonus') return 1;
      if (task.id === 'new-user-3day-checkin') {
        const required = task.requirementCount || 3;
        return required > 0 ? Math.min(ctx.checkInCount / required, 1) : 0;
      }
      if (task.id === 'new-user-first-upload') {
        return ctx.distinctUploadCount >= 1 ? 1 : 0;
      }
      if (task.id === 'new-user-explore-more') {
        const required = task.requirementCount || 2;
        return required > 0 ? Math.min(ctx.distinctUploadCount / required, 1) : 0;
      }
      return 0;
    }
  },
  'daily-tasks': {
    prepare: async (userId) => {
      const today = startOfUtcDay(new Date());
      const [checkedInToday, visitedToday, streak] = await Promise.all([
        hasDailyEvent(userId, 'CHECK_IN', today),
        hasDailyEvent(userId, 'REWARDS_HUB_VISIT', today),
        getConsecutiveCheckInStreak(userId, today)
      ]);
      const uploadsToday = await prisma.crawlerData.count({
        where: { userId, createdAt: { gte: today } }
      });
      return { today, checkedInToday, visitedToday, streak, uploadsToday };
    },
    computeProgress: async (task, userId, ctx) => {
      if (task.id === 'daily-check-in') return ctx.checkedInToday ? 1 : 0;
      if (task.id === 'daily-open-rewards-hub') return ctx.visitedToday ? 1 : 0;
      if (task.id === 'daily-upload-bonus') return ctx.uploadsToday > 0 ? 1 : 0;
      return 0;
    }
  },
  'amazon-data-collection': {
    unlock: async (userId) => {
      // Amazon tasks are always unlocked for users
      await recordTaskProgress(userId, 'amazon-order-submit', 1);
    },
    prepare: async (userId) => {
      // Get Amazon CrawlerTask with taskId (may be missing if created before taskId was set)
      const crawlerTask = await prisma.crawlerTask.findFirst({
        where: { userId, source: 'amazon', taskId: 'amazon_orders' },
        select: { id: true, taskId: true }
      });
      
      let countByTaskId = 0;
      if (crawlerTask) {
        countByTaskId = await prisma.crawlerData.count({
          where: {
            userId,
            source: 'amazon',
            taskId: crawlerTask.id
          }
        });
      }
      
      const totalCount = await prisma.crawlerData.count({
        where: { userId, source: 'amazon' }
      });
      
      // When no CrawlerTask with taskId exists, use totalCount so doneCount is not stuck at 0
      const effectiveCount = crawlerTask ? countByTaskId : totalCount;
      return { countsByTaskId: { 'amazon_orders': effectiveCount }, totalCount };
    },
    computeProgress: async (task, userId, { countsByTaskId, totalCount }) => {
      // If task has crawlerTaskId, count by specific task
      const crawlerTaskId = task.metadata?.crawlerTaskId;
      if (crawlerTaskId && countsByTaskId[crawlerTaskId] != null) {
        return countsByTaskId[crawlerTaskId];
      }
      
      // Fallback: use total count (backward compatibility)
      return totalCount || 0;
    }
  },
  'airbnb-data-collection': {
    unlock: async (userId) => {
      // Unlock all Airbnb tasks
      const tasks = ['airbnb-trips-submit', 'airbnb-past-trips-submit'];
      for (const taskId of tasks) {
        await recordTaskProgress(userId, taskId, 1);
      }
    },
    prepare: async (userId) => {
      // Get all Airbnb CrawlerTasks with taskId
      const crawlerTasks = await prisma.crawlerTask.findMany({
        where: { userId, source: 'airbnb' },
        select: { id: true, taskId: true }
      });
      
      // Count data by taskId
      const countsByTaskId = {};
      for (const ct of crawlerTasks) {
        if (ct.taskId) {
          const count = await prisma.crawlerData.count({
            where: {
              userId,
              source: 'airbnb',
              taskId: ct.id
            }
          });
          countsByTaskId[ct.taskId] = count;
        }
      }
      
      // Fallback: total count by source (for backward compatibility)
      const totalCount = await prisma.crawlerData.count({
        where: { userId, source: 'airbnb' }
      });
      
      return { countsByTaskId, totalCount };
    },
    computeProgress: async (task, userId, { countsByTaskId, totalCount }) => {
      // If task has crawlerTaskId, count by specific task
      const crawlerTaskId = task.metadata?.crawlerTaskId;
      if (crawlerTaskId && countsByTaskId[crawlerTaskId] != null) {
        return countsByTaskId[crawlerTaskId];
      }
      
      // Fallback: use total count (backward compatibility)
      return totalCount || 0;
    }
  },
  'booking-data-collection': {
    unlock: async (userId) => {
      const tasks = ['booking-past-bookings-submit'];
      for (const taskId of tasks) {
        await recordTaskProgress(userId, taskId, 1);
      }
    },
    prepare: async (userId) => {
      const crawlerTasks = await prisma.crawlerTask.findMany({
        where: { userId, source: 'booking' },
        select: { id: true, taskId: true }
      });
      const countsByTaskId = {};
      for (const ct of crawlerTasks) {
        if (ct.taskId) {
          const count = await prisma.crawlerData.count({
            where: {
              userId,
              source: 'booking',
              taskId: ct.id
            }
          });
          countsByTaskId[ct.taskId] = count;
        }
      }
      const totalCount = await prisma.crawlerData.count({
        where: { userId, source: 'booking' }
      });
      return { countsByTaskId, totalCount };
    },
    computeProgress: async (task, userId, { countsByTaskId, totalCount }) => {
      // If task has crawlerTaskId, count by specific task
      const crawlerTaskId = task.metadata?.crawlerTaskId;
      if (crawlerTaskId && countsByTaskId[crawlerTaskId] != null) {
        return countsByTaskId[crawlerTaskId];
      }
      
      // Fallback: use total count (backward compatibility)
      return totalCount || 0;
    }
  },
  'luma-data-collection': {
    unlock: async (userId) => {
      // Luma tasks are always unlocked for users
      await recordTaskProgress(userId, 'luma-event-submit', 1);
    },
    prepare: async (userId) => {
      // Get Luma CrawlerTask with taskId
      const crawlerTask = await prisma.crawlerTask.findFirst({
        where: { userId, source: 'luma', taskId: 'luma_events' },
        select: { id: true, taskId: true }
      });
      
      let countByTaskId = 0;
      if (crawlerTask) {
        countByTaskId = await prisma.crawlerData.count({
          where: {
            userId,
            source: 'luma',
            taskId: crawlerTask.id
          }
        });
      }
      
      // Fallback: total count by source
      const totalCount = await prisma.crawlerData.count({
        where: { userId, source: 'luma' }
      });
      
      return { countsByTaskId: { 'luma_events': countByTaskId }, totalCount };
    },
    computeProgress: async (task, userId, { countsByTaskId, totalCount }) => {
      // If task has crawlerTaskId, count by specific task
      const crawlerTaskId = task.metadata?.crawlerTaskId;
      if (crawlerTaskId && countsByTaskId[crawlerTaskId] != null) {
        return countsByTaskId[crawlerTaskId];
      }
      
      // Fallback: use total count
      return totalCount || 0;
    }
  },
  'christmas-shopping': {
    unlock: async (userId) => {
      // Christmas shopping tasks are unlocked for all users during December 2025
      const now = new Date();
      const CHRISTMAS_START = new Date('2025-12-01T00:00:00Z');
      const CHRISTMAS_END = new Date('2025-12-31T23:59:59Z');
      
      if (now >= CHRISTMAS_START && now <= CHRISTMAS_END) {
        // Unlock all Christmas shopping tasks
        const tasks = await prisma.task.findMany({
          where: { awardId: 'christmas-shopping' },
          select: { id: true }
        });
        for (const task of tasks) {
          await recordTaskProgress(userId, task.id, 1);
        }
      }
    },
    prepare: async (userId) => {
      // Get count of December 2025 Amazon orders
      const DECEMBER_2025_START = new Date('2025-12-01T00:00:00Z');
      const DECEMBER_2025_END = new Date('2025-12-31T23:59:59Z');
      
      // Count orders where timestamp is in December 2025
      const decemberOrders = await prisma.crawlerData.findMany({
        where: {
          userId,
          source: 'amazon',
          type: 'order',
          timestamp: {
            gte: DECEMBER_2025_START,
            lte: DECEMBER_2025_END
          }
        },
        select: { id: true, timestamp: true }
      });
      
      // Check manual verification tasks (follow-x, join-telegram)
      const userTasks = await prisma.userTask.findMany({
        where: {
          userId,
          task: {
            awardId: 'christmas-shopping',
            id: { in: ['follow-x', 'join-telegram'] }
          }
        },
        select: {
          taskId: true,
          claimed: true,
          claimRecords: true
        }
      });
      
      const followXCompleted = userTasks.find(ut => ut.taskId === 'follow-x')?.claimed || 
                               userTasks.find(ut => ut.taskId === 'follow-x')?.claimRecords?.length > 0;
      const telegramCompleted = userTasks.find(ut => ut.taskId === 'join-telegram')?.claimed || 
                                userTasks.find(ut => ut.taskId === 'join-telegram')?.claimRecords?.length > 0;
      
      return { 
        decemberOrderCount: decemberOrders.length,
        followXCompleted: followXCompleted ? 1 : 0,
        telegramCompleted: telegramCompleted ? 1 : 0
      };
    },
    computeProgress: async (task, userId, { decemberOrderCount, followXCompleted, telegramCompleted }) => {
      // For "Upload 3+ December Orders" task
      if (task.id === 'upload-3-orders' || task.id?.includes('upload') || task.id?.includes('order')) {
        const requiredCount = task.requirementCount || 3;
        if (decemberOrderCount >= requiredCount) {
          return 1; // Completed
        }
        return requiredCount > 0 ? decemberOrderCount / requiredCount : 0;
      }
      
      // For "Follow X" task
      if (task.id === 'follow-x') {
        return followXCompleted || 0;
      }
      
      // For "Join Telegram" task
      if (task.id === 'join-telegram') {
        return telegramCompleted || 0;
      }
      
      // Default: check if task is claimed
      const userTask = await prisma.userTask.findUnique({
        where: { userId_taskId: { userId, taskId: task.id } },
        select: { claimed: true, claimRecords: true }
      });
      
      if (userTask?.claimed || (userTask?.claimRecords && userTask.claimRecords.length > 0)) {
        return 1;
      }
      
      return 0;
    }
  }
};

async function getTasksByAward(userId, awardId) {
  const strategy = awardStrategies[awardId] || {};
  // Prepare context (e.g., ddcBalance) once
  const context = strategy.prepare ? await strategy.prepare(userId) : {};
  // Unlock tasks using context (pass context if unlock accepts it)
  if (strategy.unlock) {
    if (strategy.unlock.length > 1) {
      await strategy.unlock(userId, context);
    } else {
      await strategy.unlock(userId);
    }
  }
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
  const taskResults = await Promise.all(tasks.map(async task => {
    const ut = userTasks.find(u => u.taskId === task.id);
    const claimRecords = ut?.claimRecords || [];
    const today = startOfUtcDay(new Date());

    const limit = task.claimLimit ?? 1;
    // Compute progress via strategy or default
    const progress = strategy.computeProgress
      ? await strategy.computeProgress(task, userId, { ...context })
      : (limit > 0 ? Math.min(claimRecords.length / limit, 1) : null);

    // Recurring daily tasks are considered "claimed" only for the current day.
    const claimedToday = isRecurringDailyTask(task) ? hasClaimRecordOnDay(claimRecords, today) : false;
    const claimed = isRecurringDailyTask(task) ? claimedToday : (claimRecords.length >= limit);
    // determine if prerequisite task is done
    const prereqDone = !task.prerequisiteTaskId || (userTasks.find(u => u.taskId === task.prerequisiteTaskId)?.claimRecords?.length > 0);

    // determine finalStatus per task
    let finalStatus;
    if (claimed) {
      finalStatus = 'CLAIMED';
    } else if (!prereqDone) {
      finalStatus = 'LOCKED';
    } else if (awardId === 'daily-tasks' && isRecurringDailyTask(task)) {
      // Daily tasks should always be visible as actionable, even before any check-in/visit/upload happens.
      // Avoid depending on userTask upsert side-effects in GET /awards/:awardId/tasks.
      finalStatus = 'IN_PROGRESS';
    } else if (awardId === 'amazon-data-collection' || awardId === 'airbnb-data-collection' || awardId === 'booking-data-collection' || awardId === 'luma-data-collection') {
      // Data collection tasks: unlimited task, always IN_PROGRESS if unlocked (ut exists means unlocked)
      // Show IN_PROGRESS even at 0 progress, as these tasks are always available
      finalStatus = ut ? 'IN_PROGRESS' : 'LOCKED';
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
        case 'airbnb-data-collection':
        case 'booking-data-collection':
        case 'luma-data-collection':
          // For unlimited tasks, doneCount equals progress (total submissions)
          doneCount = progress;
          break;
        case 'christmas-shopping':
          // For Christmas shopping tasks, doneCount is the actual count (e.g., December orders)
          doneCount = Math.min(context.decemberOrderCount || 0, task.requirementCount || 3);
          break;
        default:
          doneCount = Math.min(Math.floor(progress * task.requirementCount), task.requirementCount);
      }
    } else {
      // For tasks without requirementCount (like data collection tasks)
      if (awardId === 'amazon-data-collection' || awardId === 'airbnb-data-collection' || awardId === 'booking-data-collection' || awardId === 'luma-data-collection') {
        doneCount = progress; // progress is already the total count for unlimited tasks
      } else {
        // fallback: either fully claimed or zero
        const total = task.claimLimit ?? 1;
        doneCount = claimed ? total : 0;
      }
    }
    // Resolve crawler task URL from metadata.crawlerTaskId
    const url = getCrawlerTaskUrl(task.metadata?.crawlerTaskId);

    // Optional: provide a points preview for tasks with dynamic points.
    // This supports UX like showing the exact Points for today's check-in.
    let pointsPreview;
    if (task?.metadata?.dynamicPoints === 'CHECKIN_STREAK_1_7') {
      // For daily check-in streak points:
      // - `context.streak` from prepare() is the current consecutive streak up to today.
      // - if user has not checked in today, claiming after check-in would increase streak by 1.
      const currentStreak = typeof context.streak === 'number' ? context.streak : 0;
      const checkedInToday = !!context.checkedInToday;
      const effectiveStreakForToday = checkedInToday ? currentStreak : currentStreak + 1;
      pointsPreview = Math.max(1, Math.min(effectiveStreakForToday, 7));
    }

    return {
      id: task.id,
      title: task.title,
      // always include core fields
      points: task.points,
      ...(pointsPreview != null ? { pointsPreview } : {}),
      doneCount,
      claimRecords,
      claimed,
      progress,
      finalStatus,
      // include optional fields only when they have content
      ...(url ? { url } : {}),
      ...(task.description ? { description: task.description } : {}),
      ...(task.claimLimit != null ? { claimLimit: task.claimLimit } : {}),
      ...(task.requirementCount != null ? { requirementCount: task.requirementCount } : {}),
      ...(task.picture ? { picture: task.picture } : {}),
      ...(task.metadata && Object.keys(task.metadata).length > 0 ? { metadata: task.metadata } : {})
    };
  }));
  
  // Special handling: Auto-claim Christmas badge when all tasks are completed (not just claimed)
  if (awardId === 'christmas-shopping' && taskResults.length > 0) {
    try {
      const allCompleted = taskResults.every(t => t.finalStatus === 'COMPLETED' || t.claimed);
      
      if (allCompleted) {
        const CHRISTMAS_BADGE_ID = 'christmas-badge-2025';
        const CHRISTMAS_POINTS = 5;
        
        // Check if badge exists and user hasn't collected it
        const badge = await prisma.badge.findUnique({
          where: { id: CHRISTMAS_BADGE_ID }
        });
        
        if (badge) {
          const existingUserBadge = await prisma.userBadge.findUnique({
            where: {
              userId_badgeId: {
                userId,
                badgeId: CHRISTMAS_BADGE_ID
              }
            }
          });
          
          if (!existingUserBadge) {
            // Auto-claim Christmas badge in a separate transaction
            await prisma.$transaction(async (tx) => {
              await tx.userBadge.create({
                data: {
                  userId,
                  badgeId: CHRISTMAS_BADGE_ID,
                  acquiredAt: new Date()
                }
              });
              
              // Award 5 points for badge
              await tx.user.update({
                where: { id: userId },
                data: { totalPoints: { increment: CHRISTMAS_POINTS } }
              });
              
              await tx.point.create({
                data: {
                  userId,
                  amount: CHRISTMAS_POINTS,
                  source: 'BADGE_CLAIM',
                  sourceId: CHRISTMAS_BADGE_ID
                }
              });
              
              // Create notification
              await tx.notification.create({
                data: {
                  userId,
                  type: 'BADGE',
                  title: 'Christmas Badge Auto-claimed!',
                  content: `Congratulations! You've completed all Christmas tasks and automatically earned the Exclusive DDC Christmas Badge and ${CHRISTMAS_POINTS} Points!`,
                  isRead: false
                }
              });
            });
            
            logger.info('Christmas badge auto-claimed via getTasksByAward', { userId, badgeId: CHRISTMAS_BADGE_ID });
          }
        }
      }
    } catch (badgeError) {
      // Badge auto-claim failure should not affect task retrieval
      logger.error('Failed to auto-claim Christmas badge in getTasksByAward', {
        userId,
        awardId,
        error: badgeError.message
      });
    }
  }
  
  return taskResults;
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
      // For recurring daily tasks, allow multiple claims over time but prevent duplicates in the same day.
      const isDailyRecurring = isRecurringDailyTask(task);
      const today = startOfUtcDay(new Date());
      if (isDailyRecurring) {
        const existing = task.UserTasks[0];
        if (existing?.claimRecords && hasClaimRecordOnDay(existing.claimRecords, today)) {
          logger.error('Task already claimed today', { userId, taskId });
          throw new Error("Task already claimed");
        }
      } else if (task.UserTasks[0]?.claimed) {
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
      // For recurring daily tasks: never flip permanent claimed=true (claimRecords tracks history)
      // For others: flip claimed when reach limit; for claimLimit=null default to true
      const isClaimedFlag = isDailyRecurring
        ? false
        : (task.claimLimit != null ? newClaimRecords.length >= task.claimLimit : true);
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

      // Determine points awarded (supports dynamic points for some tasks)
      let pointsAwarded = task.points;
      if (task.metadata?.dynamicPoints === 'CHECKIN_STREAK_1_7') {
        const streak = await getConsecutiveCheckInStreak(userId, today);
        pointsAwarded = Math.max(1, Math.min(streak, 7));
      }

      // 发放积分流水
      await tx.point.create({ data: {
        userId,
        amount: pointsAwarded,
        source: 'TASK_CLAIM',
        sourceId: taskId
      }});

      // 新增: 处理上级分润奖励（所有任务都享受分润）
      try {
        const distributionResult = await distributeUplineRewards(userId, pointsAwarded, tx, taskId);
        logger.info('上级分润处理完成', {
          userId,
          taskId,
          baseReward: pointsAwarded,
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

      // Special handling: Auto-claim Christmas badge when all Christmas shopping tasks are completed
      if (task.awardId === 'christmas-shopping') {
        try {
          // Check if all Christmas shopping tasks are completed
          const allTasks = await tx.task.findMany({
            where: { awardId: 'christmas-shopping' },
            select: { id: true, requirementCount: true }
          });
          
          // Get strategy to compute progress for all tasks
          const strategy = awardStrategies['christmas-shopping'];
          const context = strategy?.prepare ? await strategy.prepare(userId) : {};
          
          // Check if all tasks are completed (progress >= 1)
          let allCompleted = true;
          for (const t of allTasks) {
            // Compute progress to check if task is completed
            if (strategy?.computeProgress) {
              const progress = await strategy.computeProgress(t, userId, context);
              if (progress < 1) {
                allCompleted = false;
                break;
              }
            } else {
              // If no strategy, assume not completed
              allCompleted = false;
              break;
            }
          }
          
          if (allCompleted && allTasks.length > 0) {
            const CHRISTMAS_BADGE_ID = 'christmas-badge-2025';
            const CHRISTMAS_POINTS = 5;
            
            // Check if badge exists and user hasn't collected it
            const badge = await tx.badge.findUnique({
              where: { id: CHRISTMAS_BADGE_ID }
            });
            
            if (badge) {
              const existingUserBadge = await tx.userBadge.findUnique({
                where: {
                  userId_badgeId: {
                    userId,
                    badgeId: CHRISTMAS_BADGE_ID
                  }
                }
              });
              
              if (!existingUserBadge) {
                // Auto-claim Christmas badge
                await tx.userBadge.create({
                  data: {
                    userId,
                    badgeId: CHRISTMAS_BADGE_ID,
                    acquiredAt: new Date()
                  }
                });
                
                // Award 5 points for badge
                await tx.user.update({
                  where: { id: userId },
                  data: { totalPoints: { increment: CHRISTMAS_POINTS } }
                });
                
                await tx.point.create({
                  data: {
                    userId,
                    amount: CHRISTMAS_POINTS,
                    source: 'BADGE_CLAIM',
                    sourceId: CHRISTMAS_BADGE_ID
                  }
                });
                
                // Create notification
                await tx.notification.create({
                  data: {
                    userId,
                    type: 'BADGE',
                    title: 'Christmas Badge Auto-claimed!',
                    content: `Congratulations! You've completed all Christmas tasks and automatically earned the Exclusive DDC Christmas Badge and ${CHRISTMAS_POINTS} Points!`,
                    isRead: false
                  }
                });
                
                logger.info('Christmas badge auto-claimed', { userId, badgeId: CHRISTMAS_BADGE_ID });
              }
            }
          }
        } catch (badgeError) {
          // Badge auto-claim failure should not affect task claim
          logger.error('Failed to auto-claim Christmas badge', {
            userId,
            taskId,
            error: badgeError.message
          });
        }
      }

      // Return enriched response with claimedAt and points
      return { success: true, data: { taskId, claimedAt: updatedUserTask.updatedAt, points: pointsAwarded } };
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