const businessRules = require('../../config/business-rules.json');
const prisma = require('../utils/prisma');

/**
 * 检查Amazon数据提交限制
 * @param {string} userId - 用户ID
 * @param {number} itemCount - 本次提交的数据条数
 * @returns {Promise<{allowed: boolean, error?: string, remainingDaily?: number, remainingMonthly?: number}>}
 */
async function checkAmazonDataLimits(userId, itemCount) {
  const amazonRules = businessRules.dataCollection.amazon;
  
  // 获取今日和本月的提交统计
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  
  // 查询用户的Amazon数据提交记录
  const dailyCount = await prisma.crawlerData.count({
    where: {
      userId,
      source: 'amazon',
      createdAt: {
        gte: startOfDay
      }
    }
  });
  
  const monthlyCount = await prisma.crawlerData.count({
    where: {
      userId,
      source: 'amazon',
      createdAt: {
        gte: startOfMonth
      }
    }
  });
  
  // 检查每日限制
  if (dailyCount + itemCount > amazonRules.dailyLimit) {
    return {
      allowed: false,
      error: amazonRules.errors.dailyLimitExceeded,
      remainingDaily: Math.max(0, amazonRules.dailyLimit - dailyCount),
      remainingMonthly: Math.max(0, amazonRules.monthlyLimit - monthlyCount)
    };
  }
  
  // 检查每月限制
  if (monthlyCount + itemCount > amazonRules.monthlyLimit) {
    return {
      allowed: false,
      error: amazonRules.errors.monthlyLimitExceeded,
      remainingDaily: Math.max(0, amazonRules.dailyLimit - dailyCount),
      remainingMonthly: Math.max(0, amazonRules.monthlyLimit - monthlyCount)
    };
  }
  
  return {
    allowed: true,
    remainingDaily: amazonRules.dailyLimit - dailyCount - itemCount,
    remainingMonthly: amazonRules.monthlyLimit - monthlyCount - itemCount
  };
}

/**
 * 计算Amazon数据提交应获得的积分
 * @param {number} validItemCount - 有效数据条数
 * @returns {number} 应获得的积分
 */
function calculateAmazonDataPoints(validItemCount) {
  const amazonRules = businessRules.dataCollection.amazon;
  return validItemCount * amazonRules.pointsPerItem;
}

/**
 * 计算数据提交应获得的积分（通用函数，支持所有数据源）
 * @param {string} source - 数据源 ('amazon', 'luma', 'airbnb', 'booking')
 * @param {number} validItemCount - 有效数据条数
 * @returns {number} 应获得的积分
 */
function calculateDataPoints(source, validItemCount) {
  const sourceRules = businessRules.dataCollection[source];
  if (!sourceRules) {
    // 如果没有特定规则，使用 Amazon 规则作为默认值
    const amazonRules = businessRules.dataCollection.amazon;
    return validItemCount * amazonRules.pointsPerItem;
  }
  return validItemCount * sourceRules.pointsPerItem;
}

/**
 * 检查数据提交限制（通用函数，支持所有数据源）
 * @param {string} userId - 用户ID
 * @param {string} source - 数据源 ('amazon', 'luma', 'airbnb', 'booking')
 * @param {number} itemCount - 本次提交的数据条数
 * @returns {Promise<{allowed: boolean, error?: string, remainingDaily?: number, remainingMonthly?: number}>}
 */
async function checkDataLimits(userId, source, itemCount) {
  const sourceRules = businessRules.dataCollection[source];
  if (!sourceRules) {
    // 如果没有特定规则，使用 Amazon 规则作为默认值
    const amazonRules = businessRules.dataCollection.amazon;
    return checkAmazonDataLimits(userId, itemCount);
  }
  
  // 获取今日和本月的提交统计
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  
  // 查询用户的数据提交记录
  const dailyCount = await prisma.crawlerData.count({
    where: {
      userId,
      source,
      createdAt: {
        gte: startOfDay
      }
    }
  });
  
  const monthlyCount = await prisma.crawlerData.count({
    where: {
      userId,
      source,
      createdAt: {
        gte: startOfMonth
      }
    }
  });
  
  // 检查每日限制
  if (dailyCount + itemCount > sourceRules.dailyLimit) {
    return {
      allowed: false,
      error: sourceRules.errors.dailyLimitExceeded,
      remainingDaily: Math.max(0, sourceRules.dailyLimit - dailyCount),
      remainingMonthly: Math.max(0, sourceRules.monthlyLimit - monthlyCount)
    };
  }
  
  // 检查每月限制
  if (monthlyCount + itemCount > sourceRules.monthlyLimit) {
    return {
      allowed: false,
      error: sourceRules.errors.monthlyLimitExceeded,
      remainingDaily: Math.max(0, sourceRules.dailyLimit - dailyCount),
      remainingMonthly: Math.max(0, sourceRules.monthlyLimit - monthlyCount)
    };
  }
  
  return {
    allowed: true,
    remainingDaily: sourceRules.dailyLimit - dailyCount - itemCount,
    remainingMonthly: sourceRules.monthlyLimit - monthlyCount - itemCount
  };
}

/**
 * 获取数据采集规则信息（通用函数，支持所有数据源）
 * @param {string} source - 数据源 ('amazon', 'luma', 'airbnb', 'booking')
 * @returns {object} 规则信息
 */
function getDataRules(source) {
  const sourceRules = businessRules.dataCollection[source];
  if (!sourceRules) {
    // 如果没有特定规则，使用 Amazon 规则作为默认值
    return getAmazonDataRules();
  }
  return {
    pointsPerItem: sourceRules.pointsPerItem,
    dailyLimit: sourceRules.dailyLimit,
    monthlyLimit: sourceRules.monthlyLimit,
    rewardRule: sourceRules.rewardRule,
    validationRules: sourceRules.validationRules
  };
}

/**
 * 获取Amazon数据采集规则信息（用于前端显示）
 * @returns {object} 规则信息
 */
function getAmazonDataRules() {
  const amazonRules = businessRules.dataCollection.amazon;
  return {
    pointsPerItem: amazonRules.pointsPerItem,
    dailyLimit: amazonRules.dailyLimit,
    monthlyLimit: amazonRules.monthlyLimit,
    rewardRule: amazonRules.rewardRule,
    validationRules: amazonRules.validationRules
  };
}

/**
 * 验证数据是否重复
 * @param {string} userId - 用户ID
 * @param {Array} dataItems - 数据项数组
 * @returns {Promise<Array>} 去重后的数据项
 */
async function validateAndDeduplicateAmazonData(userId, dataItems) {
  // 这里应该实现具体的去重逻辑
  // 根据订单ID、时间戳等字段判断是否重复
  const existingDataHashes = await prisma.crawlerData.findMany({
    where: {
      userId,
      source: 'amazon'
    },
    select: {
      contentHash: true
    }
  });
  
  const existingHashes = new Set(existingDataHashes.map(d => d.contentHash));
  
  // 过滤掉重复的数据
  const uniqueItems = dataItems.filter(item => {
    const hash = generateDataHash(item);
    return !existingHashes.has(hash);
  });
  
  return uniqueItems;
}

/**
 * 生成数据哈希值用于去重
 * @param {object} dataItem - 数据项
 * @returns {string} 哈希值
 */
function generateDataHash(dataItem) {
  // 简单的哈希生成，实际应该根据具体字段生成
  const crypto = require('crypto');
  const key = `${dataItem.orderId || ''}_${dataItem.date || ''}_${dataItem.amount || ''}`;
  return crypto.createHash('md5').update(key).digest('hex');
}

module.exports = {
  checkAmazonDataLimits,
  calculateAmazonDataPoints,
  getAmazonDataRules,
  validateAndDeduplicateAmazonData,
  generateDataHash,
  // 通用函数（支持所有数据源）
  calculateDataPoints,
  checkDataLimits,
  getDataRules
};