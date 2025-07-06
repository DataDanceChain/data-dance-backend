const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const crypto = require('crypto');
const { calculateAmazonDataPoints } = require('./businessRulesService');
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
  MONTHLY: 10000
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
 * Get or create user tasks for all sources
 */
async function getOrCreateUserTasks(userId) {
  const sources = ['amazon', 'luma'];
  const tasks = [];

  for (const source of sources) {
    let task = await prisma.crawlerTask.findFirst({
      where: { userId, source }
    });

    if (!task) {
      const template = TASK_TEMPLATES[source];
      task = await prisma.crawlerTask.create({
        data: { ...template, userId }
      });
    }

    tasks.push(task);
  }

  return tasks;
}

/**
 * Validate data item according to schema
 */
function validateDataItem(item) {
  const errors = [];
  const warnings = [];

  // 基础验证
  if (!item.source || !['amazon', 'luma'].includes(item.source)) {
    errors.push('数据源必须是 amazon 或 luma');
  }

  if (!item.type) {
    errors.push('数据类型不能为空');
  }

  if (!item.payload || typeof item.payload !== 'object') {
    errors.push('负载数据必须是有效的对象');
  }

  // Amazon特定验证
  if (item.source === 'amazon') {
    // 现在要求orderid作为必需字段
    if (!item.payload.orderid && !item.payload.orderId) {
      errors.push('Amazon数据必须包含orderid字段');
    }
    
    // 验证orderid格式（Amazon订单号通常格式为：123-1234567-1234567）
    const orderid = item.payload.orderid || item.payload.orderId;
    if (orderid && !/^\d{3}-\d{7}-\d{7}$/.test(orderid)) {
      warnings.push('Amazon订单号格式建议为：123-1234567-1234567');
    }

    if (item.type === 'order' || item.type === 'product') {
      if (!item.payload.title) {
        warnings.push('建议包含商品标题');
      }
      if (!item.payload.price) {
        warnings.push('建议包含价格信息');
      }
      if (item.payload.price && !item.payload.currency) {
        warnings.push('建议包含货币代码（如USD、EUR）');
      }
    }
  }

  // Luma特定验证
  if (item.source === 'luma') {
    if (!item.payload.eventId && !item.payload.taskId && !item.payload.id) {
      warnings.push('建议包含Luma事件ID或任务ID以提高数据质量');
    }

    if (!item.payload.title) {
      warnings.push('建议包含标题信息');
    }
  }

  // 元数据验证
  if (!item.metadata || !item.metadata.sourceUrl) {
    warnings.push('建议包含来源URL以便追溯');
  }

  // 计算质量评分
  const quality = calculateDataQuality(item);
  if (quality.score < 50) {
    warnings.push(`数据质量评分较低 (${quality.score}/100)，建议完善数据格式`);
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
    console.log(`[CrawlerService] 开始处理用户 ${userId} 的 ${data.length} 条数据`);

    // 验证数据格式
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('数据必须是非空数组');
    }

    // 检查上传限制
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [dailyCount, monthlyCount] = await Promise.all([
      prisma.crawlerData.count({
        where: {
          userId,
          createdAt: { gte: today }
        }
      }),
      prisma.crawlerData.count({
        where: {
          userId,
          createdAt: { gte: monthStart }
        }
      })
    ]);

    const dailyLimit = 1000;
    const monthlyLimit = 10000;

    if (dailyCount + data.length > dailyLimit) {
      throw new Error(`超出日上传限制。今日已上传 ${dailyCount}/${dailyLimit} 条，本次尝试上传 ${data.length} 条`);
    }

    if (monthlyCount + data.length > monthlyLimit) {
      throw new Error(`超出月上传限制。本月已上传 ${monthlyCount}/${monthlyLimit} 条，本次尝试上传 ${data.length} 条`);
    }

    // 检查重复数据
    const { validItems, duplicates, qualityReports } = await checkDuplicates(data, userId);

    console.log(`[CrawlerService] 去重结果: ${validItems.length} 有效, ${duplicates.length} 重复`);

    // 如果没有有效数据，返回结果但不执行数据库操作
    if (validItems.length === 0) {
      return {
        uploadedCount: 0,
        duplicatesCount: duplicates.length,
        duplicateDetails: duplicates,
        qualityReports,
        pointsEarned: 0,
        message: duplicates.length > 0 ? '所有数据都是重复的' : '没有有效数据可上传'
      };
    }

    // 获取或创建用户的爬虫任务
    const tasks = await getOrCreateUserTasks(userId);
    const tasksBySource = tasks.reduce((acc, task) => {
      acc[task.source] = task;
      return acc;
    }, {});

    // 准备数据库插入数据
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

    // 计算积分 - 使用业务规则服务
    const pointsEarned = calculateAmazonDataPoints(validItems.length);

    // 执行数据库事务
    const result = await prisma.$transaction(async (tx) => {
      // 插入数据
      await tx.crawlerData.createMany({
        data: insertData
      });

      // 更新任务记录数
      for (const [source, count] of Object.entries(
        validItems.reduce((acc, item) => {
          acc[item.source] = (acc[item.source] || 0) + 1;
          return acc;
        }, {})
      )) {
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

      // 计算并发放积分
      if (pointsEarned > 0) {
        // 更新用户总积分
        await tx.user.update({
          where: { id: userId },
          data: { totalPoints: { increment: pointsEarned } }
        });

        // 创建积分记录
        await tx.point.create({
          data: {
            userId,
            amount: pointsEarned,
            source: 'crawler',
            sourceId: 'data_upload'
          }
        });

        console.log(`[CrawlerService] 为用户 ${userId} 发放 ${pointsEarned} 积分`);
      }

      return { insertedCount: validItems.length };
    });

    console.log(`[CrawlerService] 成功上传 ${validItems.length} 条数据，获得 ${pointsEarned} 积分`);

    return {
      uploadedCount: validItems.length,
      duplicatesCount: duplicates.length,
      duplicateDetails: duplicates,
      qualityReports,
      pointsEarned,
      message: `成功上传 ${validItems.length} 条数据，获得 ${pointsEarned} 积分`
    };

  } catch (error) {
    console.error('[CrawlerService] 上传数据失败:', error);
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
  // 标准化对象：排序键、移除空值、统一格式
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
      // 标准化字符串：去除多余空格、统一大小写
      normalized[key] = value.trim().toLowerCase();
    } else if (typeof value === 'number') {
      // 保持数字精度
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
    // Amazon现在只使用orderid作为唯一标识符
    return payload.orderid || payload.orderId || null;
  } else if (source === 'luma') {
    // Luma标识符优先级：eventId > taskId > id
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

  // 1. 批次内重复检查
  for (let i = 0; i < items.length; i++) {
    const currentItem = items[i];
    let isDuplicate = false;
    
    // 验证数据质量
    const validation = validateDataItem(currentItem);
    qualityReports.push({
      index: i,
      validation
    });

      // 如果有严重错误，跳过此项
  if (validation.errors.length > 0) {
    duplicates.push({
      index: i,
      reason: 'validation_error',
      reasonText: '数据验证失败',
      errors: validation.errors,
      warnings: validation.warnings
    });
    continue;
  }

  // 验证并修复timestamp
  try {
    const timestamp = currentItem.timestamp ? new Date(currentItem.timestamp) : new Date();
    if (isNaN(timestamp.getTime())) {
      duplicates.push({
        index: i,
        reason: 'validation_error',
        reasonText: '时间戳格式无效',
        errors: ['时间戳格式无效'],
        warnings: []
      });
      continue;
    }
    currentItem.timestamp = timestamp.toISOString();
  } catch (e) {
    duplicates.push({
      index: i,
      reason: 'validation_error',
      reasonText: '时间戳解析失败',
      errors: ['时间戳解析失败'],
      warnings: []
    });
    continue;
  }

    // 生成内容哈希和提取源ID
    currentItem.contentHash = generateContentHash(currentItem.payload);
    currentItem.sourceId = extractSourceId(currentItem.source, currentItem.payload);
    currentItem.originalIndex = i; // 保存原始索引

    // 检查与之前项目的重复
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

  // 2. 与数据库中现有数据的重复检查
  if (validItems.length > 0) {
    const contentHashes = validItems.map(item => item.contentHash);
    const sourceIds = validItems
      .filter(item => item.sourceId)
      .map(item => ({ source: item.source, sourceId: item.sourceId }));

    // 查询可能的重复项
    const existingByHash = await prisma.crawlerData.findMany({
      where: {
        contentHash: { in: contentHashes }
      },
      select: { contentHash: true, userId: true, createdAt: true }
    });

    const existingBySourceId = sourceIds.length > 0 ? await prisma.crawlerData.findMany({
      where: {
        userId: userId, // 只在当前用户的数据中查找重复的sourceId
        OR: sourceIds.map(({ source, sourceId }) => ({
          source: source,
          sourceId: sourceId
        }))
      },
      select: { source: true, sourceId: true, userId: true, createdAt: true }
    }) : [];

    // 标记数据库重复项
    const finalValidItems = [];
    for (let i = validItems.length - 1; i >= 0; i--) {
      const item = validItems[i];
      let isDuplicate = false;

      // 检查内容哈希重复
      const hashDuplicate = existingByHash.find(existing => 
        existing.contentHash === item.contentHash
      );
      
      if (hashDuplicate) {
        duplicates.push({
          index: item.originalIndex,
          reason: 'content_hash_duplicate',
          reasonText: '数据内容与现有记录相同',
          existingUserId: hashDuplicate.userId,
          existingDate: hashDuplicate.createdAt
        });
        isDuplicate = true;
      }

      // 检查源ID重复
      if (!isDuplicate && item.sourceId) {
        const sourceIdDuplicate = existingBySourceId.find(existing =>
          existing.source === item.source && existing.sourceId === item.sourceId
        );
        
        if (sourceIdDuplicate) {
          duplicates.push({
            index: item.originalIndex,
            reason: 'source_id_duplicate',
            reasonText: `您已经上传过相同的${item.source === 'amazon' ? 'Amazon订单' : 'Luma事件'}`,
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

// 数据质量评分系统
function calculateDataQuality(item) {
  let score = 0;
  let details = {
    hasOfficialId: false,
    hasMetadata: false,
    hasStandardFields: false,
    formatCompliance: false
  };

  // 官方标识符 (40分)
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

  // 元数据完整性 (25分)
  if (item.metadata && typeof item.metadata === 'object') {
    if (item.metadata.sourceUrl) score += 15;
    if (item.metadata.category) score += 10;
    details.hasMetadata = score >= 15;
  }

  // 标准字段 (25分)
  if (item.source === 'amazon' && item.type === 'product') {
    if (item.payload.title && item.payload.price) score += 15;
    if (item.payload.currency) score += 10;
    details.hasStandardFields = score >= 15;
  } else if (item.source === 'luma') {
    if (item.payload.title) score += 15;
    if (item.payload.date || item.payload.dueDate) score += 10;
    details.hasStandardFields = score >= 15;
  }

  // 格式规范 (10分)
  try {
    if (item.timestamp && new Date(item.timestamp).toISOString()) {
      score += 10;
      details.formatCompliance = true;
    }
  } catch (e) {
    // 时间戳格式无效
  }

  return { score, details };
}

// 智能重复检测算法
function detectSimilarity(item1, item2) {
  // 1. 内容哈希匹配（最高优先级）- 防止完全相同的内容
  if (item1.contentHash === item2.contentHash) {
    return {
      similarity: 1.0,
      reason: 'content_hash_match',
      details: '数据内容完全相同'
    };
  }

  // 注意：移除了官方标识符匹配检测，允许同一批次中有相同的ASIN
  // 这样不同用户可以上传同一商品的不同体验数据

  // 2. 标题和关键字段相似性检测（中优先级）
  if (item1.source === item2.source && item1.type === item2.type) {
    const title1 = item1.payload.title?.toLowerCase().trim();
    const title2 = item2.payload.title?.toLowerCase().trim();
    
    if (title1 && title2) {
      const titleSimilarity = calculateTextSimilarity(title1, title2);
      
      // Amazon产品：标题相似 + 价格相同
      if (item1.source === 'amazon' && item1.type === 'product') {
        const price1 = Number(item1.payload.price);
        const price2 = Number(item2.payload.price);
        
        if (titleSimilarity > 0.8 && price1 === price2 && price1 > 0) {
          return {
            similarity: 0.9,
            reason: 'title_price_match',
            details: `标题相似度${(titleSimilarity * 100).toFixed(1)}%，价格相同: ${price1}`
          };
        }
      }
      
      // 高相似度标题匹配
      if (titleSimilarity > 0.9) {
        return {
          similarity: titleSimilarity,
          reason: 'title_similarity',
          details: `标题高度相似: ${(titleSimilarity * 100).toFixed(1)}%`
        };
      }
    }
  }

  return {
    similarity: 0,
    reason: 'no_match',
    details: '未检测到重复'
  };
}

// 文本相似度计算（简化版Levenshtein）
function calculateTextSimilarity(text1, text2) {
  if (text1 === text2) return 1.0;
  
  const longer = text1.length > text2.length ? text1 : text2;
  const shorter = text1.length > text2.length ? text2 : text1;
  
  if (longer.length === 0) return 1.0;
  
  // 计算编辑距离
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
  TASK_TEMPLATES
}; 