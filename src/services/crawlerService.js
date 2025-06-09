const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const logger = createLogger('crawlerService');

// Data validation schema for different data types
const DATA_SCHEMAS = {
  product: ['title', 'price'],
  price: ['price', 'currency'],
  review: ['rating', 'content'],
  event: ['title', 'date'],
  task: ['title', 'status'],
  custom: [] // No required fields for custom type
};

// Crawler task templates
const TASK_TEMPLATES = {
  amazon: {
    title: 'Amazon Order History',
    description: 'Crawl your Amazon order history to earn rewards',
    source: 'amazon'
  },
  luma: {
    title: 'Luma Task History', 
    description: 'Crawl your Luma task history to earn rewards',
    source: 'luma'
  }
};

// Daily and monthly limits
const LIMITS = {
  DAILY: 1000,
  MONTHLY: 10000,
  POINTS_PER_10_RECORDS: 100
};

/**
 * Initialize default crawler tasks for a new user
 */
async function initializeDefaultTasks(userId) {
  const sources = ['amazon', 'luma'];
  const tasks = [];
  
  for (const source of sources) {
    // Check if user already has a task for this source
    const existingTask = await prisma.crawlerTask.findFirst({
      where: {
        userId,
        source
      }
    });
    
    if (!existingTask) {
      const template = TASK_TEMPLATES[source];
      const task = await prisma.crawlerTask.create({
        data: {
          ...template,
          userId
        }
      });
      tasks.push(task);
    }
  }
  
  return tasks;
}

/**
 * Get crawler tasks for a user with filtering and pagination
 */
async function getCrawlerTasks(userId, filters = {}) {
  // Initialize default tasks if user has none
  const userTaskCount = await prisma.crawlerTask.count({ where: { userId } });
  if (userTaskCount === 0) {
    await initializeDefaultTasks(userId);
  }

  const {
    source,
    status,
    search,
    page = 1,
    limit = 10
  } = filters;

  // Build where clause
  const where = { userId };
  if (source) where.source = source;
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }

  // Get total count
  const total = await prisma.crawlerTask.count({ where });

  // Get paginated tasks
  const tasks = await prisma.crawlerTask.findMany({
    where,
    select: {
      id: true,
      title: true,
      description: true,
      source: true,
      status: true,
      recordCount: true,
      createdAt: true,
      updatedAt: true
    },
    orderBy: { updatedAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit
  });

  // Add mock tags for API compatibility
  const tasksWithTags = tasks.map(task => ({
    ...task,
    tags: [
      { id: task.source, name: task.source.charAt(0).toUpperCase() + task.source.slice(1) },
      { id: 'orders', name: 'Orders' }
    ]
  }));

  return {
    tasks: tasksWithTags,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

/**
 * Create or get existing crawler task for user
 */
async function getOrCreateCrawlerTask(userId, source) {
  // Look for existing task for this specific source
  let task = await prisma.crawlerTask.findFirst({
    where: {
      userId,
      source,
      status: {
        in: ['pending', 'running']
      }
    }
  });

  if (!task) {
    // Create new task from template
    const template = TASK_TEMPLATES[source];
    if (!template) {
      throw new Error(`Unsupported crawler source: ${source}`);
    }

    task = await prisma.crawlerTask.create({
      data: {
        ...template,
        userId
      }
    });
  }

  return task;
}

/**
 * Validate data item according to schema
 */
function validateDataItem(dataItem) {
  const errors = [];

  // Check required fields
  if (!dataItem.source || !['amazon', 'luma'].includes(dataItem.source)) {
    errors.push('Invalid or missing source field');
  }

  if (!dataItem.type || !['product', 'price', 'review', 'event', 'task', 'custom'].includes(dataItem.type)) {
    errors.push('Invalid or missing type field');
  }

  if (!dataItem.timestamp) {
    errors.push('Missing timestamp field');
  } else {
    // Validate ISO8601 format
    const date = new Date(dataItem.timestamp);
    if (isNaN(date.getTime())) {
      errors.push('Invalid timestamp format (should be ISO8601)');
    }
  }

  if (!dataItem.payload || typeof dataItem.payload !== 'object') {
    errors.push('Missing or invalid payload field');
  }

  // Validate metadata if present
  if (dataItem.metadata && typeof dataItem.metadata !== 'object') {
    errors.push('Invalid metadata field (should be object)');
  }

  // Validate payload fields based on type
  if (dataItem.type && dataItem.payload) {
    const requiredFields = DATA_SCHEMAS[dataItem.type] || [];
    for (const field of requiredFields) {
      if (!(field in dataItem.payload)) {
        errors.push(`Missing required field '${field}' in payload for type '${dataItem.type}'`);
      }
    }
  }

  return errors;
}

/**
 * Check user's daily and monthly upload limits
 */
async function checkUploadLimits(userId) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Get daily count
  const dailyCount = await prisma.crawlerData.count({
    where: {
      userId,
      createdAt: {
        gte: today
      }
    }
  });

  // Get monthly count
  const monthlyCount = await prisma.crawlerData.count({
    where: {
      userId,
      createdAt: {
        gte: thisMonth
      }
    }
  });

  // Calculate points for daily and monthly counts
  const dailyPoints = Math.floor(dailyCount / 10) * LIMITS.POINTS_PER_10_RECORDS;
  const monthlyPoints = Math.floor(monthlyCount / 10) * LIMITS.POINTS_PER_10_RECORDS;

  return {
    daily: {
      count: dailyCount,
      limit: LIMITS.DAILY,
      remaining: Math.max(0, LIMITS.DAILY - dailyCount),
      points: dailyPoints
    },
    monthly: {
      count: monthlyCount,
      limit: LIMITS.MONTHLY,
      remaining: Math.max(0, LIMITS.MONTHLY - monthlyCount),
      points: monthlyPoints
    }
  };
}

/**
 * Upload crawler data with validation and reward calculation
 */
async function uploadCrawlerData(userId, taskId, dataItems) {
  logger.info(`Starting data upload for user ${userId}, task ${taskId}`);

  // Ensure dataItems is an array
  const items = Array.isArray(dataItems) ? dataItems : [dataItems];
  
  // Validate task exists and belongs to user
  const task = await prisma.crawlerTask.findFirst({
    where: {
      id: taskId,
      userId
    }
  });

  if (!task) {
    throw new Error('Task not found or does not belong to user');
  }

  // Check upload limits
  const limits = await checkUploadLimits(userId);
  if (limits.daily.remaining === 0) {
    const error = new Error('Daily upload limit reached');
    error.statusCode = 429;
    throw error;
  }
  if (limits.monthly.remaining === 0) {
    const error = new Error('Monthly upload limit reached');
    error.statusCode = 429;
    throw error;
  }

  // Limit items to remaining quota
  const maxItems = Math.min(items.length, limits.daily.remaining, limits.monthly.remaining);
  const limitedItems = items.slice(0, maxItems);

  // Validate all items
  const validItems = [];
  const validationErrors = [];

  for (let i = 0; i < limitedItems.length; i++) {
    const item = limitedItems[i];
    const errors = validateDataItem(item);
    
    if (errors.length > 0) {
      validationErrors.push(`Item ${i + 1}: ${errors.join(', ')}`);
      continue;
    }

    // Check if data source matches task source
    if (item.source !== task.source) {
      validationErrors.push(`Item ${i + 1}: Data source '${item.source}' does not match task source '${task.source}'`);
      continue;
    }

    validItems.push(item);
  }

  // If there are validation errors but some valid items, proceed with valid items
  if (validItems.length === 0 && validationErrors.length > 0) {
    const error = new Error(`Validation failed: ${validationErrors.join('; ')}`);
    error.statusCode = 400;
    throw error;
  }

  // Create database records for valid items
  const dataRecords = validItems.map(item => ({
    source: item.source,
    type: item.type,
    timestamp: new Date(item.timestamp),
    metadata: item.metadata || {},
    payload: item.payload,
    taskId,
    userId
  }));

  // Use transaction to ensure consistency
  const result = await prisma.$transaction(async (tx) => {
    // Get current total count BEFORE inserting new data
    const currentTotal = await tx.crawlerData.count({
      where: { userId }
    });
    
    // Insert data records
    await tx.crawlerData.createMany({
      data: dataRecords
    });

    // Update task record count and status
    const updatedTask = await tx.crawlerTask.update({
      where: { id: taskId },
      data: {
        recordCount: {
          increment: validItems.length
        },
        status: 'running',
        updatedAt: new Date()
      }
    });

    // Calculate points based on cumulative total
    const newTotal = currentTotal + validItems.length;
    
    // Calculate how many complete 10-item groups we now have
    const currentGroups = Math.floor(currentTotal / 10);
    const newGroups = Math.floor(newTotal / 10);
    const additionalGroups = newGroups - currentGroups;
    
    const pointsEarned = additionalGroups * LIMITS.POINTS_PER_10_RECORDS;
    
    if (pointsEarned > 0) {
      // Add points to user
      await tx.user.update({
        where: { id: userId },
        data: {
          totalPoints: {
            increment: pointsEarned
          }
        }
      });

      // Create point record
      await tx.point.create({
        data: {
          userId,
          amount: pointsEarned,
          source: 'crawler',
          sourceId: taskId
        }
      });
    }

    return { updatedTask, pointsEarned };
  });

  // Get updated limits
  const updatedLimits = await checkUploadLimits(userId);

  logger.info(`Data upload completed: ${validItems.length} items uploaded, ${result.pointsEarned} points earned`);

  return {
    uploadedCount: validItems.length,
    pointsEarned: result.pointsEarned,
    dailyProgress: updatedLimits.daily,
    monthlyProgress: updatedLimits.monthly,
    validationErrors: validationErrors.length > 0 ? validationErrors : undefined
  };
}

/**
 * Get crawler data for a task with pagination
 */
async function getCrawlerData(userId, taskId, page = 1, limit = 50) {
  // Validate task belongs to user
  const task = await prisma.crawlerTask.findFirst({
    where: {
      id: taskId,
      userId
    }
  });

  if (!task) {
    throw new Error('Task not found or does not belong to user');
  }

  const total = await prisma.crawlerData.count({
    where: { taskId }
  });

  const data = await prisma.crawlerData.findMany({
    where: { taskId },
    select: {
      id: true,
      source: true,
      type: true,
      timestamp: true,
      metadata: true,
      payload: true,
      createdAt: true
    },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit
  });

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

/**
 * Get user's crawler statistics
 */
async function getCrawlerStats(userId) {
  const limits = await checkUploadLimits(userId);
  
  const totalUploaded = await prisma.crawlerData.count({
    where: { userId }
  });

  const totalPoints = await prisma.point.aggregate({
    where: {
      userId,
      source: 'crawler'
    },
    _sum: {
      amount: true
    }
  });

  const taskCounts = await prisma.crawlerTask.groupBy({
    by: ['status'],
    where: { userId },
    _count: {
      status: true
    }
  });

  const taskStats = taskCounts.reduce((acc, item) => {
    acc[item.status] = item._count.status;
    return acc;
  }, {});

  return {
    totalUploaded,
    totalPoints: totalPoints._sum.amount || 0,
    dailyProgress: limits.daily,
    monthlyProgress: limits.monthly,
    taskStats
  };
}

module.exports = {
  getCrawlerTasks,
  getOrCreateCrawlerTask,
  uploadCrawlerData,
  getCrawlerData,
  getCrawlerStats,
  validateDataItem,
  checkUploadLimits,
  initializeDefaultTasks,
  LIMITS,
  TASK_TEMPLATES
}; 