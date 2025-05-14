const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

const prisma = new PrismaClient();

/**
 * 获取活动列表
 * @route GET /api/activities
 * @access Private
 */
exports.getActivities = async (req, res) => {
  try {
    const { category, search, page = 1, limit = 10, isPromoted } = req.query;
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

    // 如果指定了是否只返回推广活动
    if (isPromoted !== undefined) {
      where.isPromoted = isPromoted === 'true';
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
        },
        nftMarketOrders: true
      },
      skip,
      take: Number(limit),
      orderBy: {
        startDate: 'asc'
      }
    });

    // 获取总数
    const total = await prisma.activity.count({ where });

    res.status(200).json({
      status: 'success',
      data: {
        activities: activities.map(activity => ({
          ...activity,
          isClaimed: activity.claims.length > 0
        })),
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting activities:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
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
        },
        nftMarketOrders: true
      }
    });

    if (!activity) {
      return res.status(404).json({
        status: 'fail',
        message: 'The activity does not exist'
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
      size: activity.claims.length,
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
      message: 'Server error',
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
        message: 'The activity does not exist'
      });
    }

    // 检查活动是否已结束
    if (activity.endDate && new Date(activity.endDate) < new Date()) {
      return res.status(400).json({
        status: 'fail',
        message: 'The activity has ended'
      });
    }

    // 检查活动是否有剩余数量
    if (activity.remaining !== null && activity.remaining <= 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'The activity has no remaining quantity'
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
        message: 'You have already claimed this activity'
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
      data: {
        claim: {
          id: result.claim.id,
          userId: result.claim.userId,
          activityId: result.claim.activityId,
          status: result.claim.status,
          claimedAt: result.claim.claimedAt
        }
      }
    });
  } catch (error) {
    console.error('Error claiming activity:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
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
        },
        nftMarketOrders: true
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
      message: 'Server error',
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
    const { category, search, page = 1, limit = 10, isPromoted } = req.query;
    const skip = (page - 1) * limit;

    console.log('Query parameters:', { category, search, page, limit, isPromoted });

    // 构建查询条件
    const where = {};
    
    // 如果不是查询推广活动，则只显示 showInExplore 为 true 的活动
    if (isPromoted === undefined || isPromoted === 'false') {
      where.showInExplore = true;
    }
    
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

    // 如果指定了是否只返回推广活动
    if (isPromoted !== undefined) {
      where.isPromoted = isPromoted === 'true' || isPromoted === true;
      console.log('Filtering by isPromoted:', where.isPromoted);
    }

    console.log('Final where clause:', JSON.stringify(where, null, 2));

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
        },
        nftMarketOrders: true
      },
      skip,
      take: Number(limit),
      orderBy: {
        startDate: 'asc'
      }
    });

    console.log('Found activities count:', activities.length);
    console.log('First activity isPromoted value:', activities[0]?.isPromoted);

    // 获取总数
    const total = await prisma.activity.count({ where });

    // 格式化返回数据
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
      categories: activity.categories.map(c => ({ id: c.id, name: c.name })),
      tags: activity.tags.map(t => ({ id: t.id, name: t.name })),
      isClaimed: activity.claims.length > 0,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
      showInExplore: activity.showInExplore,
      isPromoted: activity.isPromoted,
      promotionInfo: activity.promotionInfo
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
    console.error('Error getting all activities:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
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
        },
        nftMarketOrders: true
      }
    });

    if (!activity) {
      return res.status(404).json({
        status: 'fail',
        message: 'The activity does not exist'
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
      message: 'Server error',
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
        },
        nftMarketOrders: true
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
            tags: true,
            nftMarketOrders: true
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
      })),
    }));

    res.status(200).json({
      success: true,
      data: activities
    });
  } catch (error) {
    console.error('Error fetching claimed activities:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch claimed activities',
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
        },
        nftMarketOrders: true
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
      message: 'Failed to fetch user claimed activities',
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
        message: 'Invalid contract address format'
      });
    }

    // 检查活动是否存在
    const activity = await prisma.activity.findUnique({
      where: { id }
    });

    if (!activity) {
      return res.status(404).json({
        status: 'fail',
        message: 'The activity does not exist'
      });
    }

    // 检查用户是否有权限更新此活动
    if (activity.creatorId !== req.user.id) {
      return res.status(403).json({
        status: 'fail',
        message: 'You do not have permission to update this activity'
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
      message: 'Activity contract information has been updated',
      data: {
        activity: updatedActivity
      }
    });
  } catch (error) {
    console.error('Error updating activity contract:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
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
        message: 'The activity does not exist'
      });
    }

    // 检查用户是否有权限更新此活动
    if (activity.creatorId !== req.user.id) {
      return res.status(403).json({
        status: 'fail',
        message: 'You do not have permission to deploy a contract for this activity'
      });
    }

    // 检查用户是否有钱包
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user.walletAddress || !user.privateKey) {
      return res.status(400).json({
        status: 'fail',
        message: 'You need to set a wallet first'
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
      message: 'Activity contract has been deployed',
      data: {
        activity: updatedActivity
      }
    });
  } catch (error) {
    console.error('Error deploying activity contract:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
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

/**
 * 获取商家创建的活动
 * @route GET /api/activities/created-by-me
 * @access Private
 */
exports.getCreatedActivities = async (req, res) => {
  try {
    const { page = 1, limit = 10, search } = req.query;
    const skip = (page - 1) * limit;
    const where = { creatorId: req.user.id };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }
    const activities = await prisma.activity.findMany({
      where,
      include: {
        creator: true,
        categories: true,
        tags: true,
        claims: { where: { userId: req.user.id } },
        nftMarketOrders: true
      },
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' }
    });
    const total = await prisma.activity.count({ where });
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
      categories: activity.categories.map(c => ({ id: c.id, name: c.name })),
      tags: activity.tags.map(t => ({ id: t.id, name: t.name })),
      isClaimed: activity.claims.length > 0,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
      showInExplore: activity.showInExplore,
      isPromoted: activity.isPromoted,
      promotionInfo: activity.promotionInfo
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
    console.error('Error fetching created activities:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 给活动设置标签
 * @route POST /api/activities/:id/tags
 * @access Private
 */
exports.setActivityTags = async (req, res) => {
  try {
    const { id } = req.params;
    const { tags } = req.body;
    if (!Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ status: 'fail', message: 'Invalid tag IDs' });
    }
    // 检查活动是否存在
    const activity = await prisma.activity.findUnique({ where: { id } });
    if (!activity) {
      return res.status(404).json({ status: 'fail', message: 'Activity not found' });
    }
    // 检查所有 tag 是否存在
    const foundTags = await prisma.activityTag.findMany({ where: { id: { in: tags } } });
    if (foundTags.length !== tags.length) {
      return res.status(400).json({ status: 'fail', message: 'Invalid tag IDs' });
    }
    // 更新活动标签
    const updated = await prisma.activity.update({
      where: { id },
      data: {
        tags: {
          set: tags.map(tagId => ({ id: tagId }))
        }
      },
      include: { tags: true }
    });
    res.status(200).json({ status: 'success', data: updated.tags });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

/**
 * 创建活动
 * @route POST /api/activities/new
 * @access Private
 */
exports.createActivity = async (req, res) => {
  try {
    console.log('创建活动请求:', {
      body: req.body,
      files: req.files
    });

    const {
      title,
      description,
      startDate,
      endDate,
      type,
      categories = '[]',
      tags = '[]',
      nftName,
      nftDescription,
      nftSupply,
      nftValidityStart,
      nftValidityEnd,
      nftUsageRules,
      nftPrice,
      total,
      remaining,
      statusNote,
      showInExplore,
      equityTitle,
      equityDetails,
      externalLinksTitle,
      externalLinks,
      isPromoted = false,
      dataNfts = []
    } = req.body;

    // 检查必填字段
    const missingFields = [];
    if (!title) missingFields.push('title');
    if (!description) missingFields.push('description');
    if (!startDate) missingFields.push('startDate');
    if (!endDate) missingFields.push('endDate');
    if (!type) missingFields.push('type');

    if (missingFields.length > 0) {
      console.log('缺少必填字段:', missingFields);
      return res.status(400).json({
        success: false,
        message: `缺少必填字段: ${missingFields.join(', ')}`
      });
    }

    // 处理文件上传
    const bannerFile = req.files?.find(file => file.fieldname === 'banner');
    const nftFile = req.files?.find(file => file.fieldname === 'nft');

    // 解析数组字段
    const parsedCategories = JSON.parse(categories);
    const parsedTags = JSON.parse(tags);
    const parsedEquityDetails = JSON.parse(equityDetails || '[]');
    const parsedExternalLinks = JSON.parse(externalLinks || '[]');

    // 准备活动数据
    const activityData = {
      title,
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      type,
      categories: {
        connect: parsedCategories.map(id => ({ id }))
      },
      tags: {
        connect: parsedTags.map(id => ({ id }))
      },
      creator: {
        connect: { id: req.user.id }
      },
      image: bannerFile ? `/assets/banners/${bannerFile.filename}` : null,
      nftName: nftName || null,
      nftDescription: nftDescription || null,
      nftTotalSupply: nftSupply ? parseInt(nftSupply) : null,
      nftImage: nftFile ? `/assets/nfts/${nftFile.filename}` : null,
      nftValidityStart: nftValidityStart ? new Date(nftValidityStart) : null,
      nftValidityEnd: nftValidityEnd ? new Date(nftValidityEnd) : null,
      nftUsageRules: nftUsageRules || null,
      nftPrice: nftPrice ? parseFloat(nftPrice) : 0,
      total: total ? parseInt(total) : null,
      remaining: remaining ? parseInt(remaining) : null,
      statusNote: statusNote || null,
      showInExplore: showInExplore === 'true',
      equityTitle: equityTitle || null,
      equityDetails: parsedEquityDetails,
      externalLinksTitle: externalLinksTitle || null,
      externalLinks: parsedExternalLinks,
      isPromoted: isPromoted === true || isPromoted === 'true',
      promotionInfo: dataNfts.length > 0 ? { dataNfts } : null
    };

    console.log('准备创建活动数据:', activityData);

    // 创建活动
    const activity = await prisma.activity.create({
      data: activityData,
      include: {
        creator: true,
        categories: true,
        tags: true
      }
    });

    res.status(201).json({
      success: true,
      data: activity
    });
  } catch (error) {
    console.error('创建活动失败:', {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      message: '创建活动失败',
      error: error.message
    });
  }
}; 