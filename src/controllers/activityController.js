const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * 获取活动列表
 * @route GET /api/activities
 * @access Private
 */
exports.getActivities = async (req, res) => {
  try {
    const { category, search, page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    // 构建查询条件
    const where = {};
    
    // 如果有分类筛选
    if (category) {
      where.categories = {
        some: {
          id: category
        }
      };
    }
    
    // 如果有搜索关键词
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }
    
    // 只获取当前和未来的活动
    where.endDate = {
      gte: new Date()
    };

    // 查询活动
    const activities = await prisma.activity.findMany({
      where,
      include: {
        creator: true,
        categories: true,
        tags: true,
        participations: {
          where: {
            userId: req.user.id
          }
        }
      },
      skip,
      take: Number(limit),
      orderBy: {
        startDate: 'asc'
      }
    });

    // 获取总数
    const total = await prisma.activity.count({ where });

    // 处理返回数据，添加是否已参与标志
    const formattedActivities = activities.map(activity => ({
      id: activity.id,
      title: activity.title,
      description: activity.description,
      startDate: activity.startDate,
      endDate: activity.endDate,
      image: activity.image,
      creator: {
        id: activity.creator.id,
        name: activity.creator.name,
        logo: activity.creator.logo
      },
      categories: activity.categories.map(c => ({
        id: c.id,
        name: c.name
      })),
      tags: activity.tags.map(t => ({
        id: t.id,
        name: t.name
      })),
      isParticipated: activity.participations.length > 0
    }));

    res.status(200).json({
      status: 'success',
      data: {
        activities: formattedActivities,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / limit)
        }
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
 * 获取活动详情
 * @route GET /api/activities/:id
 * @access Private
 */
exports.getActivity = async (req, res) => {
  try {
    const { id } = req.params;

    const activity = await prisma.activity.findUnique({
      where: { id },
      include: {
        creator: true,
        categories: true,
        tags: true,
        participations: {
          where: {
            userId: req.user.id
          }
        }
      }
    });

    if (!activity) {
      return res.status(404).json({
        status: 'fail',
        message: '活动不存在'
      });
    }

    // 格式化返回数据
    const formattedActivity = {
      id: activity.id,
      title: activity.title,
      description: activity.description,
      startDate: activity.startDate,
      endDate: activity.endDate,
      image: activity.image,
      creator: {
        id: activity.creator.id,
        name: activity.creator.name,
        logo: activity.creator.logo
      },
      categories: activity.categories.map(c => ({
        id: c.id,
        name: c.name
      })),
      tags: activity.tags.map(t => ({
        id: t.id,
        name: t.name
      })),
      isParticipated: activity.participations.length > 0,
      shareLink: activity.shareLink
    };

    res.status(200).json({
      status: 'success',
      data: formattedActivity
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
 * 参与活动
 * @route POST /api/activities/:id/participate
 * @access Private
 */
exports.participateActivity = async (req, res) => {
  try {
    const { id } = req.params;

    // 检查活动是否存在
    const activity = await prisma.activity.findUnique({
      where: { id }
    });

    if (!activity) {
      return res.status(404).json({
        status: 'fail',
        message: '活动不存在'
      });
    }

    // 检查用户是否已参与
    const existingParticipation = await prisma.participation.findUnique({
      where: {
        userId_activityId: {
          userId: req.user.id,
          activityId: id
        }
      }
    });

    if (existingParticipation) {
      return res.status(400).json({
        status: 'fail',
        message: '您已参与此活动'
      });
    }

    // 创建参与记录
    await prisma.participation.create({
      data: {
        user: {
          connect: { id: req.user.id }
        },
        activity: {
          connect: { id }
        },
        status: 'REGISTERED'
      }
    });

    // 记录资产交易
    await prisma.assetTransaction.create({
      data: {
        user: {
          connect: { id: req.user.id }
        },
        type: 'ACTIVITY_PARTICIPATION',
        description: `参与活动: ${activity.title}`,
        assetId: id
      }
    });

    res.status(201).json({
      status: 'success',
      message: '成功参与活动'
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
 * 获取推荐活动
 * @route GET /api/activities/recommended
 * @access Private
 */
exports.getRecommendedActivities = async (req, res) => {
  try {
    // 这里可以实现推荐算法，暂时简单返回最新的活动
    const activities = await prisma.activity.findMany({
      where: {
        endDate: {
          gte: new Date()
        }
      },
      include: {
        creator: true,
        categories: true,
        participations: {
          where: {
            userId: req.user.id
          }
        }
      },
      take: 10,
      orderBy: {
        createdAt: 'desc'
      }
    });

    // 处理返回数据
    const formattedActivities = activities.map(activity => ({
      id: activity.id,
      title: activity.title,
      description: activity.description,
      startDate: activity.startDate,
      endDate: activity.endDate,
      image: activity.image,
      creator: {
        id: activity.creator.id,
        name: activity.creator.name,
        logo: activity.creator.logo
      },
      categories: activity.categories.map(c => ({
        id: c.id,
        name: c.name
      })),
      isParticipated: activity.participations.length > 0
    }));

    res.status(200).json({
      status: 'success',
      data: formattedActivities
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
 * 获取活动分类
 * @route GET /api/activities/categories
 * @access Private
 */
exports.getCategories = async (req, res) => {
  try {
    const categories = await prisma.activityCategory.findMany();

    res.status(200).json({
      status: 'success',
      data: categories
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
 * 获取所有活动
 */
exports.getAllActivities = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    const activities = await prisma.activity.findMany({
      skip,
      take: limit,
      include: {
        creator: true,
        categories: true,
        tags: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    const total = await prisma.activity.count();
    
    res.status(200).json({
      success: true,
      data: {
        activities,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

/**
 * 获取单个活动详情
 */
exports.getActivityById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const activity = await prisma.activity.findUnique({
      where: { id },
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            logo: true,
            description: true,
            isOrganization: true
          }
        },
        categories: true,
        tags: true
      }
    });
    
    if (!activity) {
      return res.status(404).json({
        success: false,
        error: 'Activity not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: activity
    });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

/**
 * 获取推荐活动
 */
exports.getFeaturedActivities = async (req, res) => {
  try {
    const activities = await prisma.activity.findMany({
      where: {
        showInExplore: true
      },
      take: 6,
      include: {
        creator: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    res.status(200).json({
      success: true,
      data: activities
    });
  } catch (error) {
    console.error('Error fetching featured activities:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
}; 