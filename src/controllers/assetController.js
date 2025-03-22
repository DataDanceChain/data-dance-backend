const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * 获取用户资产总览
 * @route GET /api/assets
 * @access Private
 */
exports.getAssetOverview = async (req, res) => {
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
exports.getPoints = async (req, res) => {
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
exports.getBadges = async (req, res) => {
  try {
    // 获取用户已收集的勋章
    const userBadges = await prisma.userBadge.findMany({
      where: { userId: req.user.id },
      include: {
        badge: {
          include: {
            organization: true
          }
        }
      }
    });

    // 获取所有可用勋章
    const allBadges = await prisma.badge.findMany({
      include: {
        organization: true
      }
    });

    // 区分已收集和未收集的勋章
    const collectedBadgeIds = userBadges.map(ub => ub.badgeId);
    const uncollectedBadges = allBadges.filter(badge => !collectedBadgeIds.includes(badge.id));

    res.status(200).json({
      status: 'success',
      data: {
        collected: userBadges.map(ub => ({
          id: ub.badge.id,
          name: ub.badge.name,
          description: ub.badge.description,
          image: ub.badge.image,
          organization: ub.badge.organization.name,
          acquiredAt: ub.acquiredAt
        })),
        uncollected: uncollectedBadges.map(badge => ({
          id: badge.id,
          name: badge.name,
          description: badge.description,
          image: badge.image,
          organization: badge.organization.name
        }))
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
exports.getTransactions = async (req, res) => {
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
exports.getBadgeDetail = async (req, res) => {
  try {
    const { id } = req.params;
    
    // 获取勋章详情
    const badge = await prisma.badge.findUnique({
      where: { id },
      include: {
        organization: true
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
        organization: badge.organization.name,
        isCollected: !!userBadge,
        acquiredAt: userBadge?.acquiredAt || null
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
exports.collectBadge = async (req, res) => {
  try {
    const { id } = req.params;
    
    // 检查勋章是否存在
    const badge = await prisma.badge.findUnique({
      where: { id },
      include: {
        organization: true
      }
    });
    
    if (!badge) {
      return res.status(404).json({
        status: 'fail',
        message: 'Badge not found'
      });
    }
    
    // 检查用户是否已收集此勋章
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
    
    // 创建用户勋章关系
    const userBadge = await prisma.userBadge.create({
      data: {
        user: {
          connect: { id: req.user.id }
        },
        badge: {
          connect: { id }
        },
        acquiredAt: new Date()
      },
      include: {
        badge: {
          include: {
            organization: true
          }
        }
      }
    });
    
    // 记录交易
    await prisma.assetTransaction.create({
      data: {
        user: {
          connect: { id: req.user.id }
        },
        type: 'BADGE_ACQUIRED',
        assetId: id,
        description: `Collected badge: ${badge.name}`
      }
    });
    
    // 创建通知
    await prisma.notification.create({
      data: {
        user: {
          connect: { id: req.user.id }
        },
        type: 'BADGE',
        title: 'New Badge Collected',
        content: `Congratulations! You've earned the ${badge.name} badge from ${badge.organization.name}.`,
        isRead: false
      }
    });
    
    res.status(200).json({
      status: 'success',
      message: 'Badge collected successfully',
      data: {
        id: userBadge.badge.id,
        name: userBadge.badge.name,
        description: userBadge.badge.description,
        image: userBadge.badge.image,
        organization: userBadge.badge.organization.name,
        acquiredAt: userBadge.acquiredAt
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
exports.createAsset = async (req, res) => {
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