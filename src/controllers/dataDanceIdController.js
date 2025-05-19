const crypto = require('crypto');
const prisma = require('../utils/prisma');

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
 * 获取或创建用户参与活动的 DataDanceID
 * @route POST /api/data-dance-ids
 * @access Private
 */
exports.getOrCreateDataDanceID = async (req, res) => {
  try {
    const { activityId } = req.body;
    const userId = req.user.id;

    if (!activityId) {
      return res.status(400).json({
        status: 'fail',
        message: '活动ID是必需的'
      });
    }

    // 检查活动是否存在
    const activity = await prisma.activity.findUnique({
      where: { id: activityId }
    });

    if (!activity) {
      return res.status(404).json({
        status: 'fail',
        message: '活动不存在'
      });
    }

    // 检查用户是否已经有此活动的 DataDanceID
    let dataDanceID = await prisma.dataDanceID.findUnique({
      where: {
        userId_activityId: {
          userId,
          activityId
        }
      }
    });

    // 如果不存在，则创建新的 DataDanceID
    if (!dataDanceID) {
      const identifier = generateIdentifier(userId, activityId);
      
      dataDanceID = await prisma.dataDanceID.create({
        data: {
          identifier,
          user: { connect: { id: userId } },
          activity: { connect: { id: activityId } },
          metadata: {
            createdAt: new Date().toISOString(),
            activityTitle: activity.title
          }
        }
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        dataDanceID
      }
    });
  } catch (error) {
    console.error('Error creating DataDanceID:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 获取用户的所有 DataDanceID
 * @route GET /api/data-dance-ids
 * @access Private
 */
exports.getUserDataDanceIDs = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;

    // 构建查询条件
    const where = { userId };
    
    // 如果指定了状态，则添加到查询条件
    if (status) {
      where.status = status;
    }

    // 获取用户的所有 DataDanceID
    const dataDanceIDs = await prisma.dataDanceID.findMany({
      where,
      include: {
        activity: {
          select: {
            id: true,
            title: true,
            image: true,
            nftImage: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.status(200).json({
      status: 'success',
      data: {
        dataDanceIDs
      }
    });
  } catch (error) {
    console.error('Error fetching DataDanceIDs:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 获取特定的 DataDanceID
 * @route GET /api/data-dance-ids/:id
 * @access Private
 */
exports.getDataDanceID = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 获取特定的 DataDanceID
    const dataDanceID = await prisma.dataDanceID.findFirst({
      where: {
        id,
        userId
      },
      include: {
        activity: {
          select: {
            id: true,
            title: true,
            image: true,
            nftImage: true,
            nftName: true,
            nftDescription: true
          }
        }
      }
    });

    if (!dataDanceID) {
      return res.status(404).json({
        status: 'fail',
        message: 'DataDanceID 不存在或您无权访问'
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        dataDanceID
      }
    });
  } catch (error) {
    console.error('Error fetching DataDanceID:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 撤销 DataDanceID
 * @route PATCH /api/data-dance-ids/:id/revoke
 * @access Private
 */
exports.revokeDataDanceID = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 检查 DataDanceID 是否存在且属于当前用户
    const dataDanceID = await prisma.dataDanceID.findFirst({
      where: {
        id,
        userId
      }
    });

    if (!dataDanceID) {
      return res.status(404).json({
        status: 'fail',
        message: 'DataDanceID 不存在或您无权操作'
      });
    }

    // 更新状态为已撤销
    const updatedDataDanceID = await prisma.dataDanceID.update({
      where: { id },
      data: {
        status: 'REVOKED'
      }
    });

    res.status(200).json({
      status: 'success',
      message: 'DataDanceID 已撤销',
      data: {
        dataDanceID: updatedDataDanceID
      }
    });
  } catch (error) {
    console.error('Error revoking DataDanceID:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 验证 DataDanceID
 * @route POST /api/data-dance-ids/verify
 * @access Public
 */
exports.verifyDataDanceID = async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier) {
      return res.status(400).json({
        status: 'fail',
        message: 'DataDanceID 标识符是必需的'
      });
    }

    // 查找 DataDanceID
    const dataDanceID = await prisma.dataDanceID.findUnique({
      where: { identifier },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        activity: {
          select: {
            id: true,
            title: true,
            image: true,
            nftName: true
          }
        }
      }
    });

    if (!dataDanceID) {
      return res.status(404).json({
        status: 'fail',
        message: '无效的 DataDanceID'
      });
    }

    // 检查状态
    if (dataDanceID.status !== 'ACTIVE') {
      return res.status(400).json({
        status: 'fail',
        message: 'DataDanceID 已被撤销',
        data: {
          status: dataDanceID.status
        }
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'DataDanceID 有效',
      data: {
        dataDanceID: {
          id: dataDanceID.id,
          identifier: dataDanceID.identifier,
          status: dataDanceID.status,
          createdAt: dataDanceID.createdAt,
          user: dataDanceID.user,
          activity: dataDanceID.activity
        }
      }
    });
  } catch (error) {
    console.error('Error verifying DataDanceID:', error);
    console.error('Error verifying DataDanceID:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};