const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const crypto = require('crypto');
const { calculateAmazonDataPoints, calculateDataPoints } = require('./businessRulesService');
const { CRAWLER_MESSAGES } = require('../constants/messages');
const { distributeUplineRewards } = require('./distributionService');
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
// Each source can have multiple tasks, identified by taskId
const TASK_TEMPLATES = {
  amazon: [
    {
      taskId: 'amazon_orders',
      title: 'Amazon Order History',
      description: 'Crawl your Amazon order history to earn rewards',
      source: 'amazon'
    }
  ],
  luma: [
    {
      taskId: 'luma_events',
      title: 'Luma Events',
      description: 'Luma events history',
      source: 'luma'
    }
  ],
  airbnb: [
    {
      taskId: 'airbnb_trips',
      title: 'Airbnb Trips',
      description: 'Airbnb trips list',
      source: 'airbnb'
    },
    {
      taskId: 'airbnb_past_trips',
      title: 'Airbnb Past Trips',
      description: 'Airbnb past trips',
      source: 'airbnb'
    }
  ],
  booking: [
    {
      taskId: 'booking_past_trips',
      title: 'Booking Past Trips',
      description: 'Booking.com past trips list',
      source: 'booking'
    },
    {
      taskId: 'booking_past_trip_bookings',
      title: 'Booking Past Trip Bookings',
      description: 'Booking.com bookings list for a past trip (trip detail)',
      source: 'booking'
    },
    {
      taskId: 'booking_past_trip_booking_detail',
      title: 'Booking Past Trip Booking Detail',
      description: 'Booking.com archived booking detail (print view)',
      source: 'booking'
    }
  ]
};

// Helper function to get all task templates for a source
function getTaskTemplatesForSource(source) {
  return TASK_TEMPLATES[source] || [];
}

// Helper function to get a specific task template by source and taskId
function getTaskTemplate(source, taskId) {
  const templates = TASK_TEMPLATES[source] || [];
  return templates.find(t => t.taskId === taskId) || templates[0];
}

// Daily and monthly limits
const LIMITS = {
  DAILY: 1000,
  MONTHLY: 10000
};

/**
 * Initialize default crawler tasks for a new user
 */
async function initializeDefaultTasks(userId) {
  const sources = ['amazon', 'luma', 'airbnb', 'booking'];
  const tasks = [];
  
  for (const source of sources) {
    const templates = getTaskTemplatesForSource(source);
    
    for (const template of templates) {
      // Check if user already has this specific task
      const existingTask = await prisma.crawlerTask.findFirst({
        where: {
          userId,
          source,
          title: template.title
        }
      });
      
      if (!existingTask) {
        const task = await prisma.crawlerTask.create({
          data: {
            taskId: template.taskId, // 保存 taskId 用于关联 Award Task
            title: template.title,
            description: template.description,
            source: template.source,
            userId
          }
        });
        tasks.push(task);
      }
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
 * @param {string} userId - User ID
 * @param {string} source - Data source (amazon, luma, airbnb, booking)
 * @param {string} taskId - Optional task ID to get specific task (e.g., 'airbnb_trips', 'booking_past_trips')
 */
async function getOrCreateCrawlerTask(userId, source, taskId = null) {
  // Get task template
  const template = taskId 
    ? getTaskTemplate(source, taskId)
    : getTaskTemplatesForSource(source)[0];
  
  if (!template) {
    throw new Error(`Unsupported crawler source: ${source}`);
  }

  // Look for existing task
  const where = {
    userId,
    source,
    title: template.title
  };
  
  let task = await prisma.crawlerTask.findFirst({
    where: {
      ...where,
      status: {
        in: ['pending', 'running']
      }
    }
  });

  if (!task) {
    // Check if any task exists (even if completed)
    task = await prisma.crawlerTask.findFirst({ where });
    
    if (!task) {
      // Create new task from template
      task = await prisma.crawlerTask.create({
        data: {
          taskId: template.taskId, // 保存 taskId 用于关联 Award Task
          title: template.title,
          description: template.description,
          source: template.source,
          userId
        }
      });
    }
  }

  return task;
}

/**
 * Get or create user tasks for all sources
 */
async function getOrCreateUserTasks(userId) {
  const sources = ['amazon', 'luma', 'airbnb', 'booking'];
  const tasks = [];

  for (const source of sources) {
    const templates = getTaskTemplatesForSource(source);
    
    for (const template of templates) {
      let task = await prisma.crawlerTask.findFirst({
        where: { 
          userId, 
          source,
          title: template.title
        }
      });

      if (!task) {
        task = await prisma.crawlerTask.create({
          data: {
            title: template.title,
            description: template.description,
            source: template.source,
            userId
          }
        });
      }

      tasks.push(task);
    }
  }

  return tasks;
}

/**
 * Validate data item according to schema
 */
function validateDataItem(item) {
  const errors = [];
  const warnings = [];

  // Basic validation
  if (!item.source || !['amazon', 'luma', 'airbnb', 'booking'].includes(item.source)) {
    errors.push(CRAWLER_MESSAGES.INVALID_SOURCE);
  }

  if (!item.type) {
    errors.push(CRAWLER_MESSAGES.INVALID_TYPE);
  }

  if (!item.payload || typeof item.payload !== 'object') {
    errors.push(CRAWLER_MESSAGES.INVALID_PAYLOAD);
  }

  // Amazon-specific validation
  if (item.source === 'amazon') {
    // orderid is now a required field
    if (!item.payload.orderid && !item.payload.orderId) {
      errors.push(CRAWLER_MESSAGES.AMAZON_ORDERID_REQUIRED);
    }
    
    // Validate orderid format (Amazon order ID format: 123-1234567-1234567)
    const orderid = item.payload.orderid || item.payload.orderId;
    if (orderid && !/^\d{3}-\d{7}-\d{7}$/.test(orderid)) {
      warnings.push(CRAWLER_MESSAGES.AMAZON_ORDER_FORMAT_WARNING);
    }

    if (item.type === 'order' || item.type === 'product') {
      if (!item.payload.title) {
        warnings.push(CRAWLER_MESSAGES.SUGGEST_TITLE);
      }
      if (!item.payload.price) {
        warnings.push(CRAWLER_MESSAGES.SUGGEST_PRICE);
      }
      if (item.payload.price && !item.payload.currency) {
        warnings.push(CRAWLER_MESSAGES.SUGGEST_CURRENCY);
      }
    }
  }

  // Luma-specific validation
  if (item.source === 'luma') {
    if (!item.payload.eventId && !item.payload.taskId && !item.payload.id) {
      warnings.push(CRAWLER_MESSAGES.SUGGEST_LUMA_ID);
    }

    if (!item.payload.title) {
      warnings.push(CRAWLER_MESSAGES.SUGGEST_TITLE);
    }
  }

  // Metadata validation
  if (!item.metadata || !item.metadata.sourceUrl) {
    warnings.push(CRAWLER_MESSAGES.SUGGEST_SOURCE_URL);
  }

  // Calculate quality score
  const quality = calculateDataQuality(item);
  if (quality.score < 50) {
    warnings.push(CRAWLER_MESSAGES.LOW_QUALITY_SCORE(quality.score));
  }

  return { errors, warnings, quality };
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
  const dailyPoints = calculateAmazonDataPoints(dailyCount);
  const monthlyPoints = calculateAmazonDataPoints(monthlyCount);

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
async function uploadCrawlerData(data, userId) {
  try {
    console.log(CRAWLER_MESSAGES.UPLOAD_START(userId, data.length));

    // Validate data format
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(CRAWLER_MESSAGES.INVALID_DATA_FORMAT);
    }

    // Pre-validate items before transaction
    const preValidatedItems = [];
    const validationErrors = [];
    
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const validation = validateDataItem(item);
      
      if (validation.errors.length > 0) {
        validationErrors.push({
          index: i,
          reason: 'validation_error',
          reasonText: 'Data validation failed: ' + validation.errors.join(', '),
          errors: validation.errors,
          warnings: validation.warnings
        });
        continue;
      }
      
      // Generate content hash and source ID
      item.contentHash = generateContentHash(item.payload);
      item.sourceId = extractSourceId(item.source, item.payload);
      item.originalIndex = i;
      
      preValidatedItems.push(item);
    }
    
    if (preValidatedItems.length === 0) {
      return {
        uploadedCount: 0,
        duplicatesCount: 0,
        duplicateDetails: validationErrors,
        qualityReports: [],
        pointsEarned: 0,
        message: CRAWLER_MESSAGES.NO_VALID_DATA
      };
    }

    // Execute database transaction with all checks inside
    const result = await prisma.$transaction(async (tx) => {
      // Check upload limits inside transaction
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

      const [dailyCount, monthlyCount] = await Promise.all([
        tx.crawlerData.count({
          where: {
            userId,
            createdAt: { gte: today }
          }
        }),
        tx.crawlerData.count({
          where: {
            userId,
            createdAt: { gte: monthStart }
          }
        })
      ]);

      const dailyLimit = 1000;
      const monthlyLimit = 10000;

      if (dailyCount + preValidatedItems.length > dailyLimit) {
        throw new Error(CRAWLER_MESSAGES.DAILY_LIMIT_EXCEEDED(dailyCount, dailyLimit, preValidatedItems.length));
      }

      if (monthlyCount + preValidatedItems.length > monthlyLimit) {
        throw new Error(CRAWLER_MESSAGES.MONTHLY_LIMIT_EXCEEDED(monthlyCount, monthlyLimit, preValidatedItems.length));
      }
      
      // Check for duplicates inside transaction
      const validItems = [];
      const duplicates = [];
      const sourceIdsToCheck = preValidatedItems
        .filter(item => item.sourceId)
        .map(item => item.sourceId);
      const contentHashesToCheck = preValidatedItems.map(item => item.contentHash);
      
      // Batch check for existing duplicates
      console.log(`[DEBUG] Checking for duplicates - sourceIds: [${sourceIdsToCheck.join(', ')}]`);
      console.log(`[DEBUG] Checking ${contentHashesToCheck.length} content hashes`);
      
      const existingData = await tx.crawlerData.findMany({
        where: {
          userId,
          OR: [
            { sourceId: { in: sourceIdsToCheck } },
            { contentHash: { in: contentHashesToCheck } }
          ]
        },
        select: {
          sourceId: true,
          contentHash: true
        }
      });
      
      console.log(`[DEBUG] Found ${existingData.length} existing records:`, existingData);
      
      const existingSourceIds = new Set(existingData.map(d => d.sourceId).filter(Boolean));
      const existingHashes = new Set(existingData.map(d => d.contentHash));
      
      // Filter out duplicates
      for (const item of preValidatedItems) {
        if ((item.sourceId && existingSourceIds.has(item.sourceId)) || 
            existingHashes.has(item.contentHash)) {
          const duplicateType = item.sourceId && existingSourceIds.has(item.sourceId) ? 'order' : 'content';
          duplicates.push({
            index: item.originalIndex,
            reason: 'duplicate_data',
            reasonText: duplicateType === 'order' ? 
              `This ${item.source} order has already been uploaded` :
              'Identical content already exists in your data',
            sourceId: item.sourceId,
            contentHash: item.contentHash
          });
        } else {
          validItems.push(item);
        }
      }
      
      console.log(CRAWLER_MESSAGES.DEDUP_RESULT(validItems.length, duplicates.length));
      
      if (validItems.length === 0) {
        return {
          uploadedCount: 0,
          duplicatesCount: duplicates.length,
          duplicateDetails: duplicates.concat(validationErrors || []),
          qualityReports: [],
          pointsEarned: 0,
          insertedCount: 0,
          validItems: [],
          duplicates,
          validationErrors: validationErrors || []
        };
      }
      
      // Get or create user's crawler tasks within transaction
      const sources = ['amazon', 'luma', 'airbnb', 'booking'];
      const tasks = [];
      for (const source of sources) {
        const templates = getTaskTemplatesForSource(source);
        // For backward compatibility, use first template if multiple exist
        const template = templates[0];
        if (template) {
          let task = await tx.crawlerTask.findFirst({
            where: { userId, source, taskId: template.taskId }
          });
          if (!task) {
            task = await tx.crawlerTask.create({
              data: {
                taskId: template.taskId,
                title: template.title,
                description: template.description,
                source: template.source,
                userId
              }
            });
          }
          tasks.push(task);
        }
      }
      
      const tasksBySource = tasks.reduce((acc, task) => {
        acc[task.source] = task;
        return acc;
      }, {});

      // Prepare database insert data
      const insertData = validItems.map(item => ({
        source: item.source,
        type: item.type,
        timestamp: new Date(item.timestamp || new Date()),
        metadata: item.metadata || {},
        payload: item.payload,
        contentHash: item.contentHash,
        sourceId: item.sourceId,
        taskId: tasksBySource[item.source]?.id,
        userId
      }));

      // Insert data with skipDuplicates to handle race conditions
      const insertResult = await tx.crawlerData.createMany({
        data: insertData,
        skipDuplicates: true
      });
      
      const actualInserted = insertResult.count;
      
      // Get actual inserted items (we need to query them back to know their sources)
      // Since createMany doesn't return the inserted records, we'll use the validItems
      // and count by source based on the insertion order
      const insertedBySource = {};
      if (actualInserted > 0) {
        // Count actual insertions by source
        for (let i = 0; i < Math.min(actualInserted, validItems.length); i++) {
          const source = validItems[i].source;
          insertedBySource[source] = (insertedBySource[source] || 0) + 1;
        }
        
        // Update task record count based on actual inserted count
        for (const [source, count] of Object.entries(insertedBySource)) {
          if (tasksBySource[source]) {
            await tx.crawlerTask.update({
              where: { id: tasksBySource[source].id },
              data: { 
                recordCount: { increment: count },
                updatedAt: new Date()
              }
            });
          }
        }
      }

      // Calculate points based on actual inserted items, grouped by source
      let actualPointsEarned = 0;
      for (const [source, count] of Object.entries(insertedBySource)) {
        actualPointsEarned += calculateDataPoints(source, count);
      }

      // Calculate and award points
      if (actualPointsEarned > 0) {
        // Update user total points
        await tx.user.update({
          where: { id: userId },
          data: { totalPoints: { increment: actualPointsEarned } }
        });

        // Create point record
        await tx.point.create({
          data: {
            userId,
            amount: actualPointsEarned,
            source: 'crawler',
            sourceId: 'data_upload'
          }
        });

        console.log(CRAWLER_MESSAGES.POINTS_AWARDED(userId, actualPointsEarned));
        
        // Distribute upline rewards for the crawler points
        try {
          const distributionResult = await distributeUplineRewards(userId, actualPointsEarned, tx, 'crawler_data_upload');
          logger.info('Upline distribution completed for crawler data', {
            userId,
            baseReward: actualPointsEarned,
            distributionResult
          });
        } catch (distributionError) {
          // Distribution failure should not affect the main task completion
          logger.error('Upline distribution failed for crawler data', {
            userId,
            baseReward: actualPointsEarned,
            error: distributionError.message
          });
          // Continue execution without throwing
        }
      }

      return { 
        insertedCount: actualInserted,
        validItems,
        duplicates,
        pointsEarned: actualPointsEarned,
        validationErrors
      };
    }, {
      isolationLevel: 'Serializable' // Prevent concurrent transactions from interfering
    });

    console.log(CRAWLER_MESSAGES.UPLOAD_SUCCESS(result.insertedCount, result.pointsEarned));

    return {
      uploadedCount: result.insertedCount,
      duplicatesCount: result.duplicates.length,
      duplicateDetails: result.duplicates.concat(result.validationErrors),
      qualityReports: [],
      pointsEarned: result.pointsEarned,
      message: CRAWLER_MESSAGES.SUCCESS_MESSAGE(result.insertedCount, result.pointsEarned)
    };

  } catch (error) {
    console.error(CRAWLER_MESSAGES.UPLOAD_FAILED, error);
    throw error;
  }
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

/**
 * Generate SHA256 hash of normalized payload data
 */
function generateContentHash(payload) {
  // Normalize object: sort keys, remove null values, unify format
  const normalized = normalizeObject(payload);
  const content = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Normalize object for consistent hashing
 */
function normalizeObject(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const normalized = {};
  const sortedKeys = Object.keys(obj)
    .filter(key => obj[key] !== null && obj[key] !== undefined && obj[key] !== '')
    .sort();

  for (const key of sortedKeys) {
    const value = obj[key];
    if (typeof value === 'string') {
      // Normalize string: remove extra spaces, unify case
      normalized[key] = value.trim().toLowerCase();
    } else if (typeof value === 'number') {
      // Maintain number precision
      normalized[key] = Number(value);
    } else if (typeof value === 'object') {
      normalized[key] = normalizeObject(value);
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

/**
 * Extract source-specific ID from payload data
 */
function extractSourceId(source, payload) {
  if (source === 'amazon') {
    // Amazon now only uses orderid as unique identifier
    return payload.orderid || payload.orderId || null;
  } else if (source === 'luma') {
    // Luma identifier priority: eventId > taskId > id
    return payload.eventId || 
           payload.taskId || 
           payload.id ||
           null;
  }
  return null;
}

/**
 * Check for duplicate data before upload
 */
async function checkDuplicates(items, userId) {
  const duplicates = [];
  const validItems = [];
  const qualityReports = [];

  // 1. Check duplicates within batch
  for (let i = 0; i < items.length; i++) {
    const currentItem = items[i];
    let isDuplicate = false;
    
    // Validate data quality
    const validation = validateDataItem(currentItem);
    qualityReports.push({
      index: i,
      validation
    });

      // If there are serious errors, skip this item
  if (validation.errors.length > 0) {
    duplicates.push({
      index: i,
      reason: 'validation_error',
      reasonText: 'Data validation failed',
      errors: validation.errors,
      warnings: validation.warnings
    });
    continue;
  }

  // Validate and fix timestamp
  try {
    const timestamp = currentItem.timestamp ? new Date(currentItem.timestamp) : new Date();
    if (isNaN(timestamp.getTime())) {
      duplicates.push({
        index: i,
        reason: 'validation_error',
        reasonText: 'Invalid timestamp format',
        errors: ['Invalid timestamp format'],
        warnings: []
      });
      continue;
    }
    currentItem.timestamp = timestamp.toISOString();
  } catch (e) {
    duplicates.push({
      index: i,
      reason: 'validation_error',
      reasonText: 'Timestamp parsing failed',
      errors: ['Timestamp parsing failed'],
      warnings: []
    });
    continue;
  }

    // Generate content hash and extract source ID
    currentItem.contentHash = generateContentHash(currentItem.payload);
    currentItem.sourceId = extractSourceId(currentItem.source, currentItem.payload);
    currentItem.originalIndex = i; // Save original index

    // Check for duplicates with previous items
    for (let j = 0; j < validItems.length; j++) {
      const similarity = detectSimilarity(currentItem, validItems[j]);
      
      if (similarity.similarity > 0.8) {
        duplicates.push({
          index: i,
          reason: similarity.reason,
          reasonText: similarity.details,
          similarity: similarity.similarity,
          duplicateOfIndex: j
        });
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      validItems.push(currentItem);
    }
  }

  // 2. Check duplicates against existing database data
  if (validItems.length > 0) {
    const contentHashes = validItems.map(item => item.contentHash);
    const sourceIds = validItems
      .filter(item => item.sourceId)
      .map(item => ({ source: item.source, sourceId: item.sourceId }));

    // Query possible duplicates
    const existingByHash = await prisma.crawlerData.findMany({
      where: {
        contentHash: { in: contentHashes }
      },
      select: { contentHash: true, userId: true, createdAt: true }
    });

    const existingBySourceId = sourceIds.length > 0 ? await prisma.crawlerData.findMany({
      where: {
        userId: userId, // Only look for duplicate sourceId in current user's data
        OR: sourceIds.map(({ source, sourceId }) => ({
          source: source,
          sourceId: sourceId
        }))
      },
      select: { source: true, sourceId: true, userId: true, createdAt: true }
    }) : [];

    // Mark database duplicates
    const finalValidItems = [];
    for (let i = validItems.length - 1; i >= 0; i--) {
      const item = validItems[i];
      let isDuplicate = false;

      // Check content hash duplicates
      const hashDuplicate = existingByHash.find(existing => 
        existing.contentHash === item.contentHash
      );
      
      if (hashDuplicate) {
        duplicates.push({
          index: item.originalIndex,
          reason: 'content_hash_duplicate',
          reasonText: 'Data content is identical to existing record',
          existingUserId: hashDuplicate.userId,
          existingDate: hashDuplicate.createdAt
        });
        isDuplicate = true;
      }

      // Check source ID duplicates
      if (!isDuplicate && item.sourceId) {
        const sourceIdDuplicate = existingBySourceId.find(existing =>
          existing.source === item.source && existing.sourceId === item.sourceId
        );
        
        if (sourceIdDuplicate) {
          duplicates.push({
            index: item.originalIndex,
            reason: 'source_id_duplicate',
            reasonText: `You have already uploaded the same ${item.source === 'amazon' ? 'Amazon order' : item.source === 'luma' ? 'Luma event' : item.source === 'airbnb' ? 'Airbnb trip' : item.source === 'booking' ? 'Booking trip' : 'data item'}`,
            existingUserId: sourceIdDuplicate.userId,
            existingDate: sourceIdDuplicate.createdAt
          });
          isDuplicate = true;
        }
      }

      if (!isDuplicate) {
        finalValidItems.unshift(item);
      }
    }

    return { 
      validItems: finalValidItems, 
      duplicates,
      qualityReports
    };
  }

  return { 
    validItems: [], 
    duplicates,
    qualityReports 
  };
}

// Data quality scoring system
function calculateDataQuality(item) {
  let score = 0;
  let details = {
    hasOfficialId: false,
    hasMetadata: false,
    hasStandardFields: false,
    formatCompliance: false
  };

  // Official identifiers (40 points)
  if (item.source === 'amazon') {
    if (item.payload.orderid || item.payload.orderId) {
      score += 40;
      details.hasOfficialId = true;
    }
  } else if (item.source === 'luma') {
    if (item.payload.eventId || item.payload.taskId || item.payload.id) {
      score += 40;
      details.hasOfficialId = true;
    }
  }

  // Metadata completeness (25 points)
  if (item.metadata && typeof item.metadata === 'object') {
    if (item.metadata.sourceUrl) score += 15;
    if (item.metadata.category) score += 10;
    details.hasMetadata = score >= 15;
  }

  // Standard fields (25 points)
  if (item.source === 'amazon' && item.type === 'product') {
    if (item.payload.title && item.payload.price) score += 15;
    if (item.payload.currency) score += 10;
    details.hasStandardFields = score >= 15;
  } else if (item.source === 'luma') {
    if (item.payload.title) score += 15;
    if (item.payload.date || item.payload.dueDate) score += 10;
    details.hasStandardFields = score >= 15;
  }

  // Format standards (10 points)
  try {
    if (item.timestamp && new Date(item.timestamp).toISOString()) {
      score += 10;
      details.formatCompliance = true;
    }
  } catch (e) {
    // Invalid timestamp format
  }

  return { score, details };
}

// Intelligent duplicate detection algorithm
function detectSimilarity(item1, item2) {
  // 1. Content hash matching (highest priority) - prevent identical content
  if (item1.contentHash === item2.contentHash) {
    return {
      similarity: 1.0,
      reason: 'content_hash_match',
      details: 'Data content is completely identical'
    };
  }

  // Note: Removed official identifier match detection, allowing same ASIN in same batch
  // This allows different users to upload different experience data for the same product

  // 2. Title and key field similarity detection (medium priority)
  if (item1.source === item2.source && item1.type === item2.type) {
    const title1 = item1.payload.title?.toLowerCase().trim();
    const title2 = item2.payload.title?.toLowerCase().trim();
    
    if (title1 && title2) {
      const titleSimilarity = calculateTextSimilarity(title1, title2);
      
      // Amazon products: similar title + same price
      if (item1.source === 'amazon' && item1.type === 'product') {
        const price1 = Number(item1.payload.price);
        const price2 = Number(item2.payload.price);
        
        if (titleSimilarity > 0.8 && price1 === price2 && price1 > 0) {
          return {
            similarity: 0.9,
            reason: 'title_price_match',
            details: `Product title and price match detected (${(titleSimilarity * 100).toFixed(0)}% similarity, price: $${price1})`
          };
        }
      }
      
      // High similarity title match
      if (titleSimilarity > 0.9) {
        return {
          similarity: titleSimilarity,
          reason: 'title_similarity',
          details: `Product title is highly similar (${(titleSimilarity * 100).toFixed(0)}% match)`
        };
      }
    }
  }

  return {
    similarity: 0,
    reason: 'no_match',
    details: 'No duplicate detected'
  };
}

// Text similarity calculation (simplified Levenshtein)
function calculateTextSimilarity(text1, text2) {
  if (text1 === text2) return 1.0;
  
  const longer = text1.length > text2.length ? text1 : text2;
  const shorter = text1.length > text2.length ? text2 : text1;
  
  if (longer.length === 0) return 1.0;
  
  // Calculate edit distance
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1, str2) {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
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
  TASK_TEMPLATES,
  generateContentHash
}; 