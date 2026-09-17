const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const crypto = require('crypto');
const { calculateAmazonDataPoints, calculateDataPoints } = require('./businessRulesService');
const { CRAWLER_MESSAGES } = require('../constants/messages');
const {
  CORE_SOURCES,
  isAcceptedCrawlerSource,
  isCatalogCrawlerSource,
  normalizeCrawlerSource,
  catalogTaskTemplates,
} = require('../constants/crawlerSources');
const {
  calculateDataQuality,
  extractSourceId,
  hasRecordIdentity,
  isClientSmoothedRecord,
  isTitleBackedSourceId,
  sourceIdentityKey,
} = require('../utils/crawlerRecordIdentity');
const { distributeUplineRewards } = require('./distributionService');
const { POINT_SOURCE_SUMMER_TRAVEL_BONUS } = require('../constants/referralCampaigns');
const { countStayBonusItems } = require('../utils/summerTravelEligibility');
const { resolveStayBonusRules } = require('../utils/stayBonus');
const { awardConnectBoosts } = require('./campaignEffects');
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

// Crawler task templates — match frontend mockup: id, title, description, source, origin, path
// Only Airbnb has 2 tasks (past + current); others have 1 each.
const TASK_TEMPLATES = {
  amazon: [
    {
      taskId: 'amazon_orders',
      title: 'Amazon Order History',
      description: 'Crawl your Amazon order history to earn rewards',
      source: 'amazon',
      origin: 'https://www.amazon.com',
      path: '/gp/css/order-history'
    }
  ],
  luma: [
    {
      taskId: 'luma_events',
      title: 'events',
      description: 'Luma events history',
      source: 'luma',
      origin: 'https://lu.ma',
      path: '/home?period=past'
    }
  ],
  airbnb: [
    {
      taskId: 'airbnb_trips',
      title: 'Airbnb Past Trips',
      description: 'Airbnb past trips',
      source: 'airbnb',
      origin: 'https://www.airbnb.com.sg',
      path: '/users/profile/past-trips'
    },
    {
      taskId: 'airbnb_current_trips',
      title: 'Airbnb Trips',
      description: 'Airbnb trips list',
      source: 'airbnb',
      origin: 'https://www.airbnb.com.sg',
      path: '/trips/v1'
    }
  ],
  booking: [
    {
      taskId: 'booking_past_bookings',
      title: 'Booking.com Past Bookings',
      description: 'One-click crawl: Automatically fetch all past trips and their booking details',
      source: 'booking',
      origin: 'https://secure.booking.com',
      path: '/mytrips.en-gb.html'
    }
  ],
  ...catalogTaskTemplates(),
};

// Helper function to get all task templates for a source
function getTaskTemplatesForSource(source) {
  return TASK_TEMPLATES[normalizeCrawlerSource(source)] || [];
}

// Helper function to get a specific task template by source and taskId
function getTaskTemplate(source, taskId) {
  const templates = TASK_TEMPLATES[normalizeCrawlerSource(source)] || [];
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
  const sources = CORE_SOURCES;
  const tasks = [];
  
  for (const source of sources) {
    const templates = getTaskTemplatesForSource(source);
    
    for (const template of templates) {
      const existingTask = await prisma.crawlerTask.findFirst({
        where: {
          userId,
          source,
          ...(template.taskId ? { taskId: template.taskId } : { title: template.title })
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
  if (source) where.source = normalizeCrawlerSource(source);
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }

  // Get total count
  const total = await prisma.crawlerTask.count({ where });

  // Get paginated tasks (include taskId for template lookup)
  const tasks = await prisma.crawlerTask.findMany({
    where,
    select: {
      id: true,
      taskId: true,
      title: true,
      description: true,
      source: true,
      status: true,
      recordCount: true,
      dataUrl: true,
      log: true,
      createdAt: true,
      updatedAt: true
    },
    orderBy: { updatedAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit
  });

  // Enrich with template origin/path and frontend shape: id = taskId, tags
  const tasksWithTags = tasks.map(task => {
    const template = getTaskTemplate(task.source, task.taskId);
    return {
      ...task,
      id: task.taskId || task.id,
      origin: template?.origin ?? null,
      path: template?.path ?? null,
      tags: [
        { id: task.source, name: task.source.charAt(0).toUpperCase() + task.source.slice(1) },
        { id: 'orders', name: 'Orders' }
      ]
    };
  });

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
 * @param {string} source - Data source (accepted Connect source)
 * @param {string} taskId - Optional task ID to get specific task (e.g., 'airbnb_trips', 'booking_past_trips')
 */
async function getOrCreateCrawlerTask(userId, source, taskId = null) {
  source = normalizeCrawlerSource(source);
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
  const sources = CORE_SOURCES;
  const tasks = [];

  for (const source of sources) {
    const templates = getTaskTemplatesForSource(source);
    for (const template of templates) {
      let task = await prisma.crawlerTask.findFirst({
        where: {
          userId,
          source,
          ...(template.taskId ? { taskId: template.taskId } : { title: template.title })
        }
      });
      if (!task) {
        task = await prisma.crawlerTask.create({
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

  return tasks;
}

/**
 * Validate data item according to schema
 */
function validateDataItem(item) {
  const errors = [];
  const warnings = [];

  if (item && item.source) {
    item.source = normalizeCrawlerSource(item.source);
  }

  // Basic validation
  if (!item.source || !isAcceptedCrawlerSource(item.source)) {
    errors.push(CRAWLER_MESSAGES.INVALID_SOURCE);
  }

  if (!item.type) {
    errors.push(CRAWLER_MESSAGES.INVALID_TYPE);
  }

  if (!item.payload || typeof item.payload !== 'object') {
    errors.push(CRAWLER_MESSAGES.INVALID_PAYLOAD);
  }

  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};

  // Amazon-specific validation
  if (item.source === 'amazon') {
    // orderid is now a required field
    if (!payload.orderid && !payload.orderId) {
      errors.push(CRAWLER_MESSAGES.AMAZON_ORDERID_REQUIRED);
    }
    
    // Validate orderid format (Amazon order ID format: 123-1234567-1234567)
    const orderid = payload.orderid || payload.orderId;
    if (orderid && !/^\d{3}-\d{7}-\d{7}$/.test(orderid)) {
      warnings.push(CRAWLER_MESSAGES.AMAZON_ORDER_FORMAT_WARNING);
    }

    if (item.type === 'order' || item.type === 'product') {
      if (!payload.title) {
        warnings.push(CRAWLER_MESSAGES.SUGGEST_TITLE);
      }
      if (!payload.price) {
        warnings.push(CRAWLER_MESSAGES.SUGGEST_PRICE);
      }
      if (payload.price && !payload.currency) {
        warnings.push(CRAWLER_MESSAGES.SUGGEST_CURRENCY);
      }
    }
  } else if (isCatalogCrawlerSource(item.source) && !hasRecordIdentity(item.source, payload)) {
    // Client Earn upload already dropped dirty rows; accept title-only catalog shapes.
    errors.push(CRAWLER_MESSAGES.CONNECT_IDENTITY_REQUIRED);
  }

  // Luma-specific validation
  if (item.source === 'luma') {
    if (!payload.eventId && !payload.taskId && !payload.id) {
      warnings.push(CRAWLER_MESSAGES.SUGGEST_LUMA_ID);
    }

    if (!payload.title) {
      warnings.push(CRAWLER_MESSAGES.SUGGEST_TITLE);
    }
  }

  // Metadata validation
  if (!item.metadata || !item.metadata.sourceUrl) {
    warnings.push(CRAWLER_MESSAGES.SUGGEST_SOURCE_URL);
  }

  // Calculate quality score. Client-smoothed shop rows are not Amazon HTML —
  // do not warn for missing Amazon-only fields once a title or order id exists.
  const quality = calculateDataQuality(item);
  if (quality.score < 50 && !(isClientSmoothedRecord(item) && quality.details.hasOfficialId)) {
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
      item.sourceId = extractSourceId(item.source, item.payload, item.metadata);
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

    const stayRules = await resolveStayBonusRules();

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
      const officialPairs = preValidatedItems
        .filter((item) => item.sourceId && !isTitleBackedSourceId(item.sourceId))
        .map((item) => ({ source: item.source, sourceId: item.sourceId }));
      const titlePairs = preValidatedItems
        .filter((item) => isTitleBackedSourceId(item.sourceId))
        .map((item) => ({ source: item.source, sourceId: item.sourceId }));
      const contentHashesToCheck = preValidatedItems.map(item => item.contentHash);
      
      // Official ids are global within a source (same SHEIN order cannot be
      // claimed twice). Title-backed shop ids and content hashes are per-user
      // so two people buying "Linen shirt" do not collide.
      const [existingOfficial, existingTitle, existingByHash] = await Promise.all([
        officialPairs.length > 0
          ? tx.crawlerData.findMany({
              where: {
                OR: officialPairs.map(({ source, sourceId }) => ({ source, sourceId })),
              },
              select: { source: true, sourceId: true },
            })
          : [],
        titlePairs.length > 0
          ? tx.crawlerData.findMany({
              where: {
                userId,
                OR: titlePairs.map(({ source, sourceId }) => ({ source, sourceId })),
              },
              select: { source: true, sourceId: true },
            })
          : [],
        tx.crawlerData.findMany({
          where: { userId, contentHash: { in: contentHashesToCheck } },
          select: { contentHash: true }
        })
      ]);
      
      const existingOfficialKeys = new Set(
        existingOfficial.map((row) => sourceIdentityKey(row.source, row.sourceId)),
      );
      const existingTitleKeys = new Set(
        existingTitle.map((row) => sourceIdentityKey(row.source, row.sourceId)),
      );
      const existingHashes = new Set(existingByHash.map((row) => row.contentHash));
      const seenSourceKeys = new Set();
      const seenHashes = new Set();
      
      // Filter out duplicates
      for (const item of preValidatedItems) {
        const identityKey = sourceIdentityKey(item.source, item.sourceId);
        const officialHit =
          item.sourceId &&
          !isTitleBackedSourceId(item.sourceId) &&
          (existingOfficialKeys.has(identityKey) || seenSourceKeys.has(identityKey));
        const titleHit =
          isTitleBackedSourceId(item.sourceId) &&
          (existingTitleKeys.has(identityKey) || seenSourceKeys.has(identityKey));
        const hashHit = existingHashes.has(item.contentHash) || seenHashes.has(item.contentHash);
        if (officialHit || titleHit || hashHit) {
          const duplicateType = officialHit || titleHit ? 'order' : 'content';
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
          if (identityKey) seenSourceKeys.add(identityKey);
          seenHashes.add(item.contentHash);
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
      
      // Resolve (source, taskId) -> CrawlerTask for each item; support optional item.taskId for correct task
      const taskKey = (source, templateTaskId) => `${source}:${templateTaskId || ''}`;
      const tasksByKey = {};
      const getOrCreateTask = async (source, templateTaskId) => {
        const key = taskKey(source, templateTaskId);
        if (tasksByKey[key]) return tasksByKey[key];
        const template = templateTaskId
          ? getTaskTemplate(source, templateTaskId)
          : getTaskTemplatesForSource(source)[0];
        if (!template) return null;
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
        tasksByKey[key] = task;
        return task;
      };

      // Resolve task for each item: use item.taskId if present and valid for source, else first template
      const itemTasks = [];
      for (const item of validItems) {
        const templateTaskId = item.taskId && getTaskTemplate(item.source, item.taskId)
          ? item.taskId
          : null;
        const task = await getOrCreateTask(item.source, templateTaskId);
        itemTasks.push(task);
      }

      // Prepare database insert data (each record tied to its CrawlerTask)
      const insertData = validItems.map((item, i) => ({
        source: item.source,
        type: item.type,
        timestamp: new Date(item.timestamp || new Date()),
        metadata: item.metadata || {},
        payload: item.payload,
        contentHash: item.contentHash,
        sourceId: item.sourceId,
        taskId: itemTasks[i]?.id ?? null,
        userId
      })).filter(row => row.taskId != null);

      if (insertData.length === 0) {
        return {
          insertedCount: 0,
          validItems: [],
          duplicates,
          pointsEarned: 0,
          validationErrors
        };
      }

      // Insert data with skipDuplicates to handle race conditions
      const insertResult = await tx.crawlerData.createMany({
        data: insertData,
        skipDuplicates: true
      });
      
      const actualInserted = insertResult.count;
      
      // Attribute inserted count to tasks/sources (first actualInserted items with a task)
      const insertedBySource = {};
      const insertedByTaskDbId = {};
      let attributed = 0;
      for (let i = 0; i < validItems.length && attributed < actualInserted; i++) {
        if (!itemTasks[i]) continue;
        attributed += 1;
        const item = validItems[i];
        const task = itemTasks[i];
        insertedByTaskDbId[task.id] = (insertedByTaskDbId[task.id] || 0) + 1;
        insertedBySource[item.source] = (insertedBySource[item.source] || 0) + 1;
      }
      
      // Update recordCount per task (so each task's doneCount / 分数归集 is correct)
      for (const [taskDbId, count] of Object.entries(insertedByTaskDbId)) {
        await tx.crawlerTask.update({
          where: { id: taskDbId },
          data: { recordCount: { increment: count }, updatedAt: new Date() }
        });
      }

      // Calculate points based on actual inserted items, grouped by source
      let actualPointsEarned = 0;
      const pointsBySource = {};
      for (const [source, count] of Object.entries(insertedBySource)) {
        const sourcePoints = calculateDataPoints(source, count);
        pointsBySource[source] = sourcePoints;
        actualPointsEarned += sourcePoints;
      }

      // Stay bonus: extra points per newly inserted eligible stay (base crawler points stay as-is)
      let summerBonusPoints = 0;
      if (stayRules && actualInserted > 0) {
        const newlyInsertedItems = [];
        let attributedForBonus = 0;
        for (let i = 0; i < validItems.length && attributedForBonus < actualInserted; i++) {
          if (!itemTasks[i]) continue;
          newlyInsertedItems.push(validItems[i]);
          attributedForBonus += 1;
        }
        const bonusItems = countStayBonusItems(newlyInsertedItems, stayRules);
        summerBonusPoints = bonusItems * (stayRules.bonusPerItem || 0);
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

      if (summerBonusPoints > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { totalPoints: { increment: summerBonusPoints } },
        });
        await tx.point.create({
          data: {
            userId,
            amount: summerBonusPoints,
            source: POINT_SOURCE_SUMMER_TRAVEL_BONUS,
            sourceId: stayRules?.campaignId || 'summer_travel_2026',
          },
        });
        logger.info('Stay bonus upload awarded', {
          userId,
          summerBonusPoints,
          campaignId: stayRules?.campaignId || null,
        });
      }

      let connectBoostPoints = 0;
      try {
        const boost = await awardConnectBoosts(tx, userId, pointsBySource);
        connectBoostPoints = boost.extra;
        if (connectBoostPoints > 0) {
          logger.info('Connect campaign boost awarded', {
            userId,
            connectBoostPoints,
            awards: boost.awards,
          });
        }
      } catch (boostError) {
        logger.error('Connect campaign boost failed', {
          userId,
          error: boostError.message,
        });
      }

      return { 
        insertedCount: actualInserted,
        validItems,
        duplicates,
        pointsEarned: actualPointsEarned + summerBonusPoints + connectBoostPoints,
        summerBonusPoints,
        connectBoostPoints,
        validationErrors
      };
    }, {
      isolationLevel: 'Serializable' // Prevent concurrent transactions from interfering
    });

    console.log(CRAWLER_MESSAGES.UPLOAD_SUCCESS(result.insertedCount, result.pointsEarned));

    if (result.insertedCount > 0) {
      try {
        const { onInviteeFirstValidUpload } = require('./referralService');
        await onInviteeFirstValidUpload(userId);
      } catch (referralError) {
        logger.error('Failed to process referral rewards after first valid upload', {
          userId,
          error: referralError.message,
        });
      }
    }

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
 * @param {string} taskIdOrDbId - Either template taskId (e.g. "luma_events") or CrawlerTask DB id (UUID)
 */
async function getCrawlerData(userId, taskIdOrDbId, page = 1, limit = 50) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskIdOrDbId);
  const task = await prisma.crawlerTask.findFirst({
    where: isUuid
      ? { id: taskIdOrDbId, userId }
      : { userId, taskId: taskIdOrDbId }
  });

  if (!task) {
    throw new Error('Task not found or does not belong to user');
  }

  const taskDbId = task.id;

  const total = await prisma.crawlerData.count({
    where: { taskId: taskDbId }
  });

  const data = await prisma.crawlerData.findMany({
    where: { taskId: taskDbId },
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
    currentItem.sourceId = extractSourceId(currentItem.source, currentItem.payload, currentItem.metadata);
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
    const officialSourceIds = validItems
      .filter((item) => item.sourceId && !isTitleBackedSourceId(item.sourceId))
      .map((item) => ({ source: item.source, sourceId: item.sourceId }));
    const titleSourceIds = validItems
      .filter((item) => isTitleBackedSourceId(item.sourceId))
      .map((item) => ({ source: item.source, sourceId: item.sourceId }));

    // Query possible duplicates
    const existingByHash = await prisma.crawlerData.findMany({
      where: {
        contentHash: { in: contentHashes }
      },
      select: { contentHash: true, userId: true, createdAt: true }
    });

    // Official ids are global within a source. Title-backed shop ids are per-user.
    const existingBySourceId = officialSourceIds.length > 0 ? await prisma.crawlerData.findMany({
      where: {
        OR: officialSourceIds.map(({ source, sourceId }) => ({
          source: source,
          sourceId: sourceId
        }))
      },
      select: { source: true, sourceId: true, userId: true, createdAt: true }
    }) : [];
    const existingTitleBySourceId = titleSourceIds.length > 0 ? await prisma.crawlerData.findMany({
      where: {
        userId,
        OR: titleSourceIds.map(({ source, sourceId }) => ({
          source,
          sourceId,
        })),
      },
      select: { source: true, sourceId: true, userId: true, createdAt: true },
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
        const sourcePool = isTitleBackedSourceId(item.sourceId)
          ? existingTitleBySourceId
          : existingBySourceId;
        const sourceIdDuplicate = sourcePool.find((existing) =>
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
  getTaskTemplate,
  uploadCrawlerData,
  getCrawlerData,
  getCrawlerStats,
  validateDataItem,
  checkUploadLimits,
  initializeDefaultTasks,
  LIMITS,
  TASK_TEMPLATES,
  generateContentHash,
  extractSourceId,
  calculateDataQuality,
  isAcceptedCrawlerSource,
  normalizeCrawlerSource,
  isCatalogCrawlerSource,
}; 