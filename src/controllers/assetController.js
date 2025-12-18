const prisma = require('../utils/prisma');
const assetService = require('../services/assetService');
const { checkChristmasShoppingTasks } = require('../services/taskService');

/**
 * 获取用户资产总览
 * @route GET /api/assets
 * @access Private
 */
exports.getAssetOverview = async function (req, res) {
  try {
    // 获取用户积分总额
    const pointsSum = await prisma.point.aggregate({
      where: { userId: req.user.id },
      _sum: { amount: true }
    });

    // 获取用户勋章数量
    const badgesCount = await prisma.userBadge.count({
      where: { userId: req.user.id }
    });

    res.status(200).json({
      status: 'success',
      data: {
        totalPoints: pointsSum._sum.amount || 0,
        badgesCount
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 获取用户积分
 * @route GET /api/assets/points
 * @access Private
 */
exports.getPoints = async function (req, res) {
  try {
    // 获取用户积分总额
    const pointsSum = await prisma.point.aggregate({
      where: { userId: req.user.id },
      _sum: { amount: true }
    });

    // 获取用户积分历史记录
    const pointsHistory = await prisma.point.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20 // 限制返回数量
    });

    res.status(200).json({
      status: 'success',
      data: {
        totalPoints: pointsSum._sum.amount || 0,
        history: pointsHistory
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 获取用户勋章
 * @route GET /api/assets/badges
 * @access Private
 */
exports.getBadges = async function (req, res) {
  try {
    // 获取用户已收集的勋章
    const userBadges = await prisma.userBadge.findMany({
      where: { userId: req.user.id },
      include: {
        badge: {
          include: {
            creator: true
          }
        }
      }
    });

    // 获取所有可用勋章
    const allBadges = await prisma.badge.findMany({
      include: {
        creator: true
      }
    });

    // 区分已收集和未收集的勋章
    const collectedBadgeIds = userBadges.map(ub => ub.badgeId);
    const uncollectedBadges = allBadges.filter(badge => !collectedBadgeIds.includes(badge.id));

    // 检查圣诞徽章的任务状态
    const CHRISTMAS_BADGE_ID = 'christmas-badge-2025';
    const christmasBadge = allBadges.find(b => b.id === CHRISTMAS_BADGE_ID);
    let christmasTaskStatus = null;
    
    if (christmasBadge) {
      const isCollected = collectedBadgeIds.includes(CHRISTMAS_BADGE_ID);
      if (!isCollected) {
        // Only check task status if badge is not collected
        christmasTaskStatus = await checkChristmasShoppingTasks(req.user.id);
      }
    }

    res.status(200).json({
      status: 'success',
      data: {
        collected: userBadges.map(ub => ({
          id: ub.badge.id,
          name: ub.badge.name,
          description: ub.badge.description,
          image: ub.badge.image,
          creator: {
            id: ub.badge.creator.id,
            name: ub.badge.creator.name,
            isOrganization: ub.badge.creator.isOrganization
          },
          acquiredAt: ub.acquiredAt
        })),
        uncollected: uncollectedBadges.map(badge => {
          const badgeData = {
          id: badge.id,
          name: badge.name,
          description: badge.description,
          image: badge.image,
          creator: {
            id: badge.creator.id,
            name: badge.creator.name,
            isOrganization: badge.creator.isOrganization
          }
          };
          
          // Add taskStatus for Christmas badge if not collected
          if (badge.id === CHRISTMAS_BADGE_ID && christmasTaskStatus) {
            badgeData.taskStatus = christmasTaskStatus;
          }
          
          return badgeData;
        })
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 获取用户资产交易记录
 * @route GET /api/assets/transactions
 * @access Private
 */
exports.getTransactions = async function (req, res) {
  try {
    const transactions = await prisma.assetTransaction.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50 // 限制返回数量
    });

    res.status(200).json({
      status: 'success',
      data: transactions
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 获取勋章详情
 * @route GET /api/assets/badges/:id
 * @access Private
 */
exports.getBadgeDetail = async function (req, res) {
  try {
    const { id } = req.params;
    
    // 获取勋章详情
    const badge = await prisma.badge.findUnique({
      where: { id },
      include: {
        creator: true
      }
    });
    
    if (!badge) {
      return res.status(404).json({
        status: 'fail',
        message: '勋章不存在'
      });
    }
    
    // 检查用户是否已获得此勋章
    const userBadge = await prisma.userBadge.findUnique({
      where: {
        userId_badgeId: {
          userId: req.user.id,
          badgeId: id
        }
      }
    });
    
    res.status(200).json({
      status: 'success',
      data: {
        id: badge.id,
        name: badge.name,
        description: badge.description,
        image: badge.image,
        creator: {
          id: badge.creator.id,
          name: badge.creator.name,
          isOrganization: badge.creator.isOrganization
        },
        isCollected: !!userBadge,
        acquiredAt: userBadge ? userBadge.acquiredAt : null
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 收集勋章
 * @route POST /api/assets/badges/:id/collect
 * @access Private
 */
exports.collectBadge = async function (req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const CHRISTMAS_BADGE_ID = 'christmas-badge-2025';
    const CHRISTMAS_POINTS = 5;
    
    // 检查勋章是否存在
    const badge = await prisma.badge.findUnique({
      where: { id },
      include: {
        creator: true
      }
    });
    
    if (!badge) {
      return res.status(404).json({
        status: 'fail',
        message: 'Badge not found'
      });
    }
    
    // 检查用户是否已经收集了这个勋章
    const existingUserBadge = await prisma.userBadge.findUnique({
      where: {
        userId_badgeId: {
          userId: req.user.id,
          badgeId: id
        }
      }
    });
    
    if (existingUserBadge) {
      return res.status(400).json({
        status: 'fail',
        message: 'You have already collected this badge'
      });
    }
    
    // Special handling for Christmas badge: verify tasks are completed
    if (id === CHRISTMAS_BADGE_ID) {
      const taskStatus = await checkChristmasShoppingTasks(userId);
      
      if (!taskStatus.canClaim) {
        return res.status(400).json({
          status: 'error',
          message: 'Please complete all Christmas tasks before claiming the Christmas Badge',
          code: 'TASKS_INCOMPLETE',
          data: {
            missingTasks: taskStatus.missingTasks,
            activityStatusUrl: '/user/awards?category=christmas-shopping'
          }
        });
      }
    }
    
    // 使用事务确保数据一致性
    const result = await prisma.$transaction(async (tx) => {
    // 创建用户勋章关系
      const userBadge = await tx.userBadge.create({
      data: {
        user: {
            connect: { id: userId }
        },
        badge: {
          connect: { id }
        },
        acquiredAt: new Date()
      },
      include: {
        badge: {
          include: {
            creator: true
          }
        }
      }
    });
      
      // 如果是圣诞徽章，发放 5 积分
      if (id === CHRISTMAS_BADGE_ID) {
        // 更新用户总积分
        await tx.user.update({
          where: { id: userId },
          data: {
            totalPoints: { increment: CHRISTMAS_POINTS }
          }
        });
        
        // 创建积分记录
        await tx.point.create({
          data: {
            userId,
            amount: CHRISTMAS_POINTS,
            source: 'BADGE_CLAIM',
            sourceId: CHRISTMAS_BADGE_ID
          }
        });
      }
    
    // 记录交易
      await tx.assetTransaction.create({
      data: {
        user: {
            connect: { id: userId }
        },
        type: 'BADGE_ACQUIRED',
        assetId: id,
        description: `Collected badge: ${badge.name}`
      }
    });
    
    // 创建通知
      await tx.notification.create({
      data: {
        user: {
            connect: { id: userId }
        },
        type: 'BADGE',
        title: 'New Badge Collected',
          content: `Congratulations! You've earned the ${badge.name} badge from ${badge.creator.name}.${id === CHRISTMAS_BADGE_ID ? ` You've also earned ${CHRISTMAS_POINTS} Points!` : ''}`,
        isRead: false
      }
      });
      
      return userBadge;
    });
    
    res.status(200).json({
      status: 'success',
      message: 'Badge collected successfully',
      data: {
        id: result.badge.id,
        name: result.badge.name,
        description: result.badge.description,
        image: result.badge.image,
        creator: {
          id: result.badge.creator.id,
          name: result.badge.creator.name,
          isOrganization: result.badge.creator.isOrganization
        },
        acquiredAt: result.acquiredAt,
        ...(id === CHRISTMAS_BADGE_ID ? { pointsAwarded: CHRISTMAS_POINTS } : {})
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: error.message
    });
  }
};

/**
 * 创建资产
 * @route POST /api/assets/create
 * @access Private (Organization Only)
 */
exports.createAsset = async function (req, res) {
  try {
    const { name, description, metadata, type } = req.body;
    
    if (!name || !metadata) {
      return res.status(400).json({
        status: 'fail',
        message: '请提供资产名称和元数据'
      });
    }
    
    // 创建资产
    const asset = await prisma.nFTDataAsset.create({
      data: {
        name,
        description: description || '',
        metadata: metadata,
        owner: {
          connect: { id: req.user.id }
        }
      }
    });
    
    res.status(201).json({
      status: 'success',
      data: asset
    });
  } catch (error) {
    console.error('Error creating asset:', error);
    res.status(500).json({
      status: 'error',
      message: '创建资产失败',
      error: error.message
    });
  }
};

/**
 * Get DDC token balance for logged-in user
 */
exports.getUserDDCBalance = async function (req, res, next) {
  try {
    const userId = req.user.id;
    const balance = await assetService.getDDCBalance(userId);
    res.json({ status: 'success', data: { ddcBalance: balance } });
  } catch (err) {
    next(err);
  }
};