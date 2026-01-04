const crawlerService = require('../services/crawlerService');
const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const { 
  checkAmazonDataLimits, 
  calculateAmazonDataPoints,
  getAmazonDataRules
} = require('../services/businessRulesService');
const logger = createLogger('crawlerController');

/**
 * GET /api/crawler-tasks
 * Get crawler tasks for the authenticated user (matching original spec)
 */
async function getCrawlerTasks(req, res) {
  try {
    const userId = req.user.id;
    const filters = {
      source: req.query.source,
      status: req.query.status,
      search: req.query.search,
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 10
    };

    // Validate filters
    if (filters.source && !['amazon', 'luma', 'airbnb', 'booking'].includes(filters.source)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid source. Must be "amazon", "luma", "airbnb", or "booking"'
      });
    }

    if (filters.status && !['pending', 'running', 'done', 'error'].includes(filters.status)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Must be "pending", "running", "done", or "error"'
      });
    }

    if (filters.limit > 100) {
      return res.status(400).json({
        status: 'error',
        message: 'Limit cannot exceed 100'
      });
    }

    const result = await crawlerService.getCrawlerTasks(userId, filters);

    // Format response to match original spec
    const formattedTasks = result.tasks.map(task => ({
      id: task.id,
      title: task.title,
      description: task.description,
      source: task.source,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      recordCount: task.recordCount,
      dataUrl: task.dataUrl || null,
      log: task.log || null,
      tags: task.tags
    }));

    res.json({
      status: 'success',
      data: {
        tasks: formattedTasks,
        pagination: result.pagination
      }
    });
  } catch (error) {
    logger.error('Error getting crawler tasks:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
}

/**
 * POST /api/crawler-tasks
 * Create a new crawler task for the authenticated user
 */
async function createCrawlerTask(req, res) {
  try {
    const userId = req.user.id;
    const { source } = req.body;

    if (!source) {
      return res.status(400).json({
        status: 'error',
        message: 'Source is required'
      });
    }

    if (!['amazon', 'luma', 'airbnb', 'booking'].includes(source)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid source. Must be "amazon", "luma", "airbnb", or "booking"'
      });
    }

    const task = await crawlerService.getOrCreateCrawlerTask(userId, source);

    res.status(201).json({
      status: 'success',
      data: {
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          source: task.source,
          status: task.status,
          recordCount: task.recordCount,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt
        }
      }
    });
  } catch (error) {
    logger.error('Error creating crawler task:', error);
    
    if (error.message === 'User already has a running crawler task') {
      return res.status(409).json({
        status: 'error',
        message: error.message
      });
    }

    if (error.message.includes('Unsupported crawler source')) {
      return res.status(400).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
}

/**
 * POST /api/upload
 * Upload crawler data (simplified to match original spec)
 */
async function uploadData(req, res) {
  try {
    const userId = req.user.id;
    
    // Handle both {"data": [...]} and direct [...] formats
    let dataItems;
    if (req.body.data) {
      dataItems = Array.isArray(req.body.data) ? req.body.data : [req.body.data];
    } else if (Array.isArray(req.body)) {
      dataItems = req.body;
    } else {
      dataItems = [req.body];
    }

    if (!dataItems || dataItems.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'data is required'
      });
    }

    // Auto-determine task based on data source
    let validItems = [];
    const validationErrors = [];

    for (let i = 0; i < dataItems.length; i++) {
      const item = dataItems[i];
      const errors = crawlerService.validateDataItem(item);
      
      if (errors.length > 0) {
        validationErrors.push(`Item ${i + 1}: ${errors.join(', ')}`);
        continue;
      }

      validItems.push(item);
    }

    if (validItems.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No valid data items found',
        details: validationErrors
      });
    }

    // Check for Amazon data and apply business rules
    const amazonItems = validItems.filter(item => item.source === 'amazon');
    let amazonLimits = null;
    
    if (amazonItems.length > 0) {
      // Check Amazon specific limits
      const limitCheck = await checkAmazonDataLimits(userId, amazonItems.length);
      
      if (!limitCheck.allowed) {
        return res.status(429).json({
          status: 'error',
          message: limitCheck.error,
          data: {
            remainingDaily: limitCheck.remainingDaily,
            remainingMonthly: limitCheck.remainingMonthly
          }
        });
      }
      
      amazonLimits = {
        remainingDaily: limitCheck.remainingDaily,
        remainingMonthly: limitCheck.remainingMonthly
      };
    }

    // Upload all data at once - the service will handle source grouping internally
    const result = await crawlerService.uploadCrawlerData(validItems, userId);

    // Enhanced response with detailed information
    const responseData = {
      uploadedCount: result.uploadedCount,
      pointsEarned: result.pointsEarned,
      duplicatesCount: result.duplicatesCount || 0,
      duplicateDetails: result.duplicateDetails || [],
      qualityReports: result.qualityReports || [],
      message: result.message || `Data uploaded successfully`
    };

    // Add Amazon limits info if Amazon data was uploaded
    if (amazonLimits) {
      responseData.amazonLimits = amazonLimits;
    }

    res.json({
      status: 'success',
      data: responseData
    });

  } catch (error) {
    logger.error('Error uploading crawler data:', error);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        message: error.message
      });
    }

    if (error.message.includes('Daily upload limit') || error.message.includes('Monthly upload limit')) {
      return res.status(429).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
}

/**
 * GET /api/crawler-tasks/:taskId/data
 * Get crawler data for a specific task
 */
async function getCrawlerData(req, res) {
  try {
    const userId = req.user.id;
    const { taskId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const result = await crawlerService.getCrawlerData(userId, taskId, page, limit);

    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    logger.error('Error getting crawler data:', error);

    if (error.message.includes('Task not found')) {
      return res.status(404).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
}

/**
 * GET /api/crawler/stats
 * Get crawler statistics for the authenticated user
 */
async function getCrawlerStats(req, res) {
  try {
    const userId = req.user.id;
    const stats = await crawlerService.getCrawlerStats(userId);

    res.json({
      status: 'success',
      data: stats
    });
  } catch (error) {
    logger.error('Error getting crawler stats:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
}

/**
 * GET /api/crawler/limits
 * Get upload limits for the authenticated user
 */
async function getUploadLimits(req, res) {
  try {
    const userId = req.user.id;
    const limits = await crawlerService.checkUploadLimits(userId);

    res.json({
      status: 'success',
      data: limits
    });
  } catch (error) {
    logger.error('Error getting upload limits:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
}

/**
 * PUT /api/crawler-tasks/:taskId/status
 * Update crawler task status
 */
async function updateTaskStatus(req, res) {
  try {
    const userId = req.user.id;
    const { taskId } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        status: 'error',
        message: 'status is required'
      });
    }

    if (!['pending', 'running', 'done', 'error'].includes(status)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Must be "pending", "running", "done", or "error"'
      });
    }

    // Validate task exists and belongs to user
    const task = await prisma.crawlerTask.findFirst({
      where: {
        id: taskId,
        userId
      }
    });

    if (!task) {
      return res.status(404).json({
        status: 'error',
        message: 'Task not found or does not belong to user'
      });
    }

    // Update task status
    const updatedTask = await prisma.crawlerTask.update({
      where: { id: taskId },
      data: { 
        status,
        updatedAt: new Date()
      }
    });

    res.json({
      status: 'success',
      data: {
        task: {
          id: updatedTask.id,
          title: updatedTask.title,
          description: updatedTask.description,
          source: updatedTask.source,
          status: updatedTask.status,
          recordCount: updatedTask.recordCount,
          createdAt: updatedTask.createdAt,
          updatedAt: updatedTask.updatedAt
        }
      }
    });
  } catch (error) {
    logger.error('Error updating task status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
}

/**
 * DELETE /api/crawler-tasks/:taskId
 * Delete a crawler task and its associated data
 */
async function deleteCrawlerTask(req, res) {
  try {
    const userId = req.user.id;
    const { taskId } = req.params;

    // Validate task exists and belongs to user
    const task = await prisma.crawlerTask.findFirst({
      where: {
        id: taskId,
        userId
      }
    });

    if (!task) {
      return res.status(404).json({
        status: 'error',
        message: 'Task not found or does not belong to user'
      });
    }

    // Delete task and associated data in transaction
    await prisma.$transaction(async (tx) => {
      // Delete crawler data
      await tx.crawlerData.deleteMany({
        where: { taskId }
      });

      // Delete task
      await tx.crawlerTask.delete({
        where: { id: taskId }
      });
    });

    res.json({
      status: 'success',
      message: 'Task deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting crawler task:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
}

/**
 * GET /api/data-collection/amazon/status
 * Get Amazon data collection rules and user status
 */
async function getAmazonDataStatus(req, res) {
  try {
    const userId = req.user.id;
    
    // Get rules information
    const rules = getAmazonDataRules();
    
    // Get user today and monthly submission stats
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
    const dailyCount = await prisma.crawlerData.count({
      where: {
        userId,
        source: 'amazon',
        createdAt: { gte: startOfDay }
      }
    });
    
    const monthlyCount = await prisma.crawlerData.count({
      where: {
        userId,
        source: 'amazon',
        createdAt: { gte: startOfMonth }
      }
    });
    
    return res.json({
      status: 'success',
      data: {
        rules,
        userStatus: {
          dailySubmitted: dailyCount,
          monthlySubmitted: monthlyCount,
          remainingDaily: Math.max(0, rules.dailyLimit - dailyCount),
          remainingMonthly: Math.max(0, rules.monthlyLimit - monthlyCount)
        }
      }
    });
    
  } catch (error) {
    logger.error('Get Amazon data status error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error, please try again later'
    });
  }
}

module.exports = {
  getCrawlerTasks,
  createCrawlerTask,
  uploadData,
  getCrawlerData,
  getCrawlerStats,
  getUploadLimits,
  updateTaskStatus,
  deleteCrawlerTask,
  getAmazonDataStatus
}; 