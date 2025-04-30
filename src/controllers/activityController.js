const crypto = require('crypto');
const prisma = require('../utils/prisma');

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
        claims: {
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

    // 处理返回数据，添加是否已领取标志
    const formattedActivities = activities.map(activity => ({
      id: activity.id,
      title: activity.title,
      description: activity.description,
      startDate: activity.startDate,
      endDate: activity.endDate,
      image: activity.image,
      type: activity.type,
      remaining: activity.remaining,
      total: activity.total,
      statusNote: activity.statusNote,
      price: activity.nftPrice,
      nft: activity.nftPrice ? {
        name: activity.nftName,
        description: activity.nftDescription,
        image: activity.nftImage,
        totalSupply: activity.nftTotalSupply,
        price: activity.nftPrice,
        validityStart: activity.nftValidityStart,
        validityEnd: activity.nftValidityEnd,
        usageRules: activity.nftUsageRules
      } : null,
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
      isClaimed: activity.claims.length > 0,
      showInExplore: activity.showInExplore,
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
        claims: {
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
      type: activity.type,
      remaining: activity.remaining,
      total: activity.total,
      statusNote: activity.statusNote,
      price: activity.nftPrice,
      nft: activity.nftPrice ? {
        name: activity.nftName,
        description: activity.nftDescription,
        image: activity.nftImage,
        totalSupply: activity.nftTotalSupply,
        price: activity.nftPrice,
        validityStart: activity.nftValidityStart,
        validityEnd: activity.nftValidityEnd,
        usageRules: activity.nftUsageRules
      } : null,
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
      isClaimed: activity.claims.length > 0,
      shareLink: activity.shareLink,
      showInExplore: activity.showInExplore
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
 * 领取活动
 * @route POST /api/activities/:id/claim
 * @access Private
 */
exports.claimActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

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

    // 检查活动是否已结束
    if (activity.endDate && new Date(activity.endDate) < new Date()) {
      return res.status(400).json({
        status: 'fail',
        message: '活动已结束'
      });
    }

    // 检查活动是否有剩余数量
    if (activity.remaining !== null && activity.remaining <= 0) {
      return res.status(400).json({
        status: 'fail',
        message: '活动已无剩余数量'
      });
    }

    // 检查用户是否已领取过此活动
    const existingClaim = await prisma.activityClaim.findUnique({
      where: {
        userId_activityId: {
          userId,
          activityId: id
        }
      }
    });

    if (existingClaim) {
      return res.status(400).json({
        status: 'fail',
        message: '您已领取过此活动'
      });
    }

    // 开始事务
    const result = await prisma.$transaction(async (prisma) => {
      // 创建领取记录
      const claim = await prisma.activityClaim.create({
        data: {
          user: { connect: { id: userId } },
          activity: { connect: { id } },
          status: 'CLAIMED'
        }
      });

      // 更新活动剩余数量
      if (activity.remaining !== null) {
        await prisma.activity.update({
          where: { id },
          data: {
            remaining: activity.remaining - 1
          }
        });
      }

      // 生成 DataDanceID
      const identifier = generateIdentifier(userId, id);
      
      const dataDanceID = await prisma.dataDanceID.create({
        data: {
          identifier,
          user: { connect: { id: userId } },
          activity: { connect: { id } },
          metadata: {
            createdAt: new Date().toISOString(),
            activityTitle: activity.title
          }
        }
      });

      return { claim, dataDanceID };
    });

    res.status(200).json({
      status: 'success',
      message: '活动领取成功',
      data: {
        claim: result.claim,
        dataDanceID: result.dataDanceID
      }
    });
  } catch (error) {
    console.error('Error claiming activity:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
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
    // 获取用户已领取的活动类别
    const userClaimedCategories = await prisma.activityCategory.findMany({
      where: {
        activities: {
          some: {
            claims: {
              some: {
                userId: req.user.id
              }
            }
          }
        }
      }
    });
    
    const categoryIds = userClaimedCategories.map(c => c.id);
    
    // 根据用户已领取的活动类别推荐活动
    const recommendedActivities = await prisma.activity.findMany({
      where: {
        categories: {
          some: {
            id: {
              in: categoryIds
            }
          }
        },
        claims: {
          none: {
            userId: req.user.id
          }
        }
      },
      include: {
        creator: true,
        categories: true,
        tags: true,
        claims: {
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
    
    // 格式化返回数据
    const formattedActivities = recommendedActivities.map(activity => ({
      id: activity.id,
      title: activity.title,
      description: activity.description,
      image: activity.image,
      startDate: activity.startDate,
      endDate: activity.endDate,
      type: activity.type,
      remaining: activity.remaining,
      total: activity.total,
      statusNote: activity.statusNote,
      creator: {
        id: activity.creator.id,
        name: activity.creator.name,
        logo: activity.creator.avatar,
        isOrganization: activity.creator.isOrganization
      },
      categories: activity.categories.map(c => ({
        id: c.id,
        name: c.name
      })),
      tags: activity.tags.map(t => ({
        id: t.id,
        name: t.name
      })),
      isClaimed: activity.claims.length > 0,
      showInExplore: activity.showInExplore
    }));
    
    res.status(200).json({
      success: true,
      data: formattedActivities
    });
  } catch (error) {
    console.error('Error fetching recommended activities:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
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
 * @route GET /api/activities
 * @access Private
 */
exports.getAllActivities = async (req, res) => {
  try {
    const { category, search, page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    // 构建查询条件
    const where = {
      showInExplore: true  // 添加这个条件，只获取 showInExplore 为 true 的活动
    };
    
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

    // 查询活动
    const activities = await prisma.activity.findMany({
      where,
      include: {
        creator: true,
        categories: true,
        tags: true,
        claims: {
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

    // 获取总数 - 只计算 showInExplore 为 true 的活动
    const total = await prisma.activity.count({ where });

    // 处理返回数据，添加是否已领取标志
    const formattedActivities = activities.map(activity => ({
      id: activity.id,
      title: activity.title,
      description: activity.description,
      startDate: activity.startDate,
      endDate: activity.endDate,
      image: activity.image,
      type: activity.type,
      remaining: activity.remaining,
      total: activity.total,
      statusNote: activity.statusNote,
      price: activity.nftPrice,
      nft: activity.nftPrice ? {
        name: activity.nftName,
        description: activity.nftDescription,
        image: activity.nftImage,
        totalSupply: activity.nftTotalSupply,
        price: activity.nftPrice,
        validityStart: activity.nftValidityStart,
        validityEnd: activity.nftValidityEnd,
        usageRules: activity.nftUsageRules
      } : null,
      creator: {
        id: activity.creator.id,
        name: activity.creator.name,
        logo: activity.creator.logo,
        isOrganization: activity.creator.isOrganization
      },
      categories: activity.categories.map(c => ({
        id: c.id,
        name: c.name
      })),
      tags: activity.tags.map(t => ({
        id: t.id,
        name: t.name
      })),
      isClaimed: activity.claims.length > 0,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
      showInExplore: activity.showInExplore,
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
    console.error('Error fetching activities:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
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
        creator: true,
        categories: true,
        tags: true,
        claims: {
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
      type: activity.type,
      remaining: activity.remaining,
      total: activity.total,
      statusNote: activity.statusNote,
      price: activity.nftPrice,
      nft: activity.nftPrice ? {
        name: activity.nftName,
        description: activity.nftDescription,
        image: activity.nftImage,
        totalSupply: activity.nftTotalSupply,
        price: activity.nftPrice,
        validityStart: activity.nftValidityStart,
        validityEnd: activity.nftValidityEnd,
        usageRules: activity.nftUsageRules
      } : null,
      creator: {
        id: activity.creator.id,
        name: activity.creator.name,
        logo: activity.creator.logo,
        isOrganization: activity.creator.isOrganization
      },
      categories: activity.categories.map(c => ({
        id: c.id,
        name: c.name
      })),
      tags: activity.tags.map(t => ({
        id: t.id,
        name: t.name
      })),
      isClaimed: activity.claims.length > 0,
      shareLink: activity.shareLink,
      showInExplore: activity.showInExplore,
    };

    res.status(200).json({
      status: 'success',
      data: formattedActivity
    });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 获取推荐活动
 * @route GET /api/activities/recommended
 * @access Private
 */
exports.getFeaturedActivities = async (req, res) => {
  try {
    const activities = await prisma.activity.findMany({
      where: {
        showInExplore: true
      },
      take: 6,
      include: {
        creator: true,
        claims: {
          where: {
            userId: req.user.id
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    // 格式化返回数据
    const formattedActivities = activities.map(activity => ({
      id: activity.id,
      title: activity.title,
      description: activity.description,
      image: activity.image,
      startDate: activity.startDate,
      endDate: activity.endDate,
      type: activity.type,
      remaining: activity.remaining,
      total: activity.total,
      statusNote: activity.statusNote,
      price: activity.nftPrice,
      nft: activity.nftPrice ? {
        name: activity.nftName,
        description: activity.nftDescription,
        image: activity.nftImage,
        totalSupply: activity.nftTotalSupply,
        price: activity.nftPrice,
        validityStart: activity.nftValidityStart,
        validityEnd: activity.nftValidityEnd,
        usageRules: activity.nftUsageRules
      } : null,
      creator: {
        id: activity.creator.id,
        name: activity.creator.name,
        logo: activity.creator.avatar,
        isOrganization: activity.creator.isOrganization
      },
      isClaimed: activity.claims.length > 0,
      showInExplore: activity.showInExplore,
    }));
    
    res.status(200).json({
      success: true,
      data: formattedActivities
    });
  } catch (error) {
    console.error('Error fetching featured activities:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

/**
 * 获取用户已领取的活动
 * @route GET /api/activities/claimed
 * @access Private
 */
exports.getClaimedActivities = async (req, res) => {
  try {
    // 获取用户领取的活动
    const claims = await prisma.activityClaim.findMany({
      where: { 
        userId: req.user.id
      },
      include: {
        activity: {
          include: {
            creator: true,
            categories: true,
            tags: true
          }
        }
      },
      orderBy: {
        claimedAt: 'desc'
      }
    });

    // 格式化响应数据
    const activities = claims.map(claim => ({
      id: claim.activity.id,
      title: claim.activity.title,
      description: claim.activity.description,
      image: claim.activity.image,
      startDate: claim.activity.startDate,
      endDate: claim.activity.endDate,
      type: claim.activity.type,
      remaining: claim.activity.remaining,
      total: claim.activity.total,
      statusNote: claim.activity.statusNote,
      claimedAt: claim.claimedAt,
      status: claim.status,
      price: claim.activity.nftPrice,
      nft: claim.activity.nftPrice ? {
        name: claim.activity.nftName,
        description: claim.activity.nftDescription,
        image: claim.activity.nftImage,
        totalSupply: claim.activity.nftTotalSupply,
        price: claim.activity.nftPrice,
        validityStart: claim.activity.nftValidityStart,
        validityEnd: claim.activity.nftValidityEnd,
        usageRules: claim.activity.nftUsageRules
      } : null,
      creator: {
        id: claim.activity.creator.id,
        name: claim.activity.creator.name,
        logo: claim.activity.creator.avatar,
        isOrganization: claim.activity.creator.isOrganization
      },
      categories: claim.activity.categories.map(c => ({
        id: c.id,
        name: c.name
      })),
      tags: claim.activity.tags.map(t => ({
        id: t.id,
        name: t.name
      }))
    }));

    res.status(200).json({
      success: true,
      data: activities
    });
  } catch (error) {
    console.error('Error fetching claimed activities:', error);
    res.status(500).json({
      success: false,
      message: '获取已领取活动失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 获取用户已领取的活动（通过过滤活动表）
 * @route GET /api/activities/user-claimed
 * @access Private
 */
exports.getUserClaimedActivities = async (req, res) => {
  try {
    // 通过过滤 Activity 表获取用户已领取的活动
    const activities = await prisma.activity.findMany({
      where: {
        claims: {
          some: {
            userId: req.user.id
          }
        }
      },
      include: {
        creator: true,
        categories: true,
        tags: true,
        claims: {
          where: {
            userId: req.user.id
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });

    // 格式化响应数据
    const formattedActivities = activities.map(activity => ({
      id: activity.id,
      title: activity.title,
      description: activity.description,
      image: activity.image,
      startDate: activity.startDate,
      endDate: activity.endDate,
      type: activity.type,
      remaining: activity.remaining,
      total: activity.total,
      statusNote: activity.statusNote,
      price: activity.nftPrice,
      nft: activity.nftPrice ? {
        name: activity.nftName,
        description: activity.nftDescription,
        image: activity.nftImage,
        totalSupply: activity.nftTotalSupply,
        price: activity.nftPrice,
        validityStart: activity.nftValidityStart,
        validityEnd: activity.nftValidityEnd,
        usageRules: activity.nftUsageRules
      } : null,
      claimedAt: activity.claims[0]?.claimedAt,
      status: activity.claims[0]?.status,
      creator: {
        id: activity.creator.id,
        name: activity.creator.name,
        logo: activity.creator.avatar,
        isOrganization: activity.creator.isOrganization
      },
      categories: activity.categories.map(c => ({
        id: c.id,
        name: c.name
      })),
      tags: activity.tags.map(t => ({
        id: t.id,
        name: t.name
      })),
      showInExplore: activity.showInExplore,
    }));

    res.status(200).json({
      success: true,
      data: formattedActivities
    });
  } catch (error) {
    console.error('Error fetching user claimed activities:', error);
    res.status(500).json({
      success: false,
      message: '获取用户已领取活动失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 更新活动合约信息
 * @route PATCH /api/activities/:id/contract
 * @access Private
 */
exports.updateActivityContract = async (req, res) => {
  try {
    const { id } = req.params;
    const { contractAddress, chainId, tokenStandard } = req.body;

    // 验证合约地址格式（以太坊地址示例）
    if (contractAddress && !/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
      return res.status(400).json({
        status: 'fail',
        message: '无效的合约地址格式'
      });
    }

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

    // 检查用户是否有权限更新此活动
    if (activity.creatorId !== req.user.id) {
      return res.status(403).json({
        status: 'fail',
        message: '您没有权限更新此活动'
      });
    }

    // 更新活动合约信息
    const updatedActivity = await prisma.activity.update({
      where: { id },
      data: {
        contractAddress,
        chainId,
        tokenStandard
      }
    });

    res.status(200).json({
      status: 'success',
      message: '活动合约信息已更新',
      data: {
        activity: updatedActivity
      }
    });
  } catch (error) {
    console.error('Error updating activity contract:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 部署活动合约
 * @route POST /api/activities/:id/deploy-contract
 * @access Private
 */
exports.deployActivityContract = async (req, res) => {
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

    // 检查用户是否有权限更新此活动
    if (activity.creatorId !== req.user.id) {
      return res.status(403).json({
        status: 'fail',
        message: '您没有权限为此活动部署合约'
      });
    }

    // 检查用户是否有钱包
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user.walletAddress || !user.privateKey) {
      return res.status(400).json({
        status: 'fail',
        message: '您需要先设置钱包才能部署合约'
      });
    }

    // 这里应该有实际的合约部署逻辑
    // 为了示例，我们只是生成一个模拟的合约地址
    const contractAddress = `0x${Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;
    const chainId = 1; // 以太坊主网
    const tokenStandard = 'ERC721'; // 默认使用 ERC721 标准

    // 更新活动合约信息
    const updatedActivity = await prisma.activity.update({
      where: { id },
      data: {
        contractAddress,
        chainId,
        tokenStandard
      }
    });

    res.status(200).json({
      status: 'success',
      message: '活动合约已部署',
      data: {
        activity: updatedActivity
      }
    });
  } catch (error) {
    console.error('Error deploying activity contract:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 生成唯一的 DataDanceID 标识符
 * @param {string} userId 用户ID
 * @param {string} activityId 活动ID
 * @returns {string} 生成的标识符
 */
function generateIdentifier(userId, activityId) {
  // 使用用户ID、活动ID和时间戳生成唯一标识符
  const baseString = `${userId}-${activityId}-${Date.now()}`;
  const hash = crypto.createHash('sha256').update(baseString).digest('hex');
  
  // 返回前12位，格式为 DDID-XXXX-XXXX
  return `DDID-${hash.substring(0, 4)}-${hash.substring(4, 8)}`;
}