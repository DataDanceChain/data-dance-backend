const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');

/**
 * 获取当前用户信息
 * @route GET /api/users/me
 * @access Private
 */
exports.getMe = async (req, res) => {
  try {
    // 获取用户信息，包括积分总数
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        profile: true
      }
    });

    if (!user) {
      return res.status(404).json({
        status: 'fail',
        message: '用户不存在'
      });
    }

    // 格式化返回数据
    const userData = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      walletAddress: user.walletAddress,
      chainId: user.chainId,
      isOrganization: user.isOrganization || user.userType === 'organization',
      userType: user.userType,
      authType: user.authType,
      totalPoints: user.totalPoints,
      xid: user.xid,
      xUsername: user.xUsername
    };

    res.status(200).json({
      status: 'success',
      data: {
        user: userData
      }
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 更新用户信息
 * @route PUT /api/users/me
 * @access Private
 */
exports.updateMe = async (req, res) => {
  try {
    const { name, avatar } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        name,
        avatar
      }
    });

    // 移除敏感信息
    const { password, ...userWithoutPassword } = updatedUser;

    res.status(200).json({
      status: 'success',
      data: userWithoutPassword
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
 * 更新用户语言设置
 * @route PUT /api/users/language
 * @access Private
 */
exports.updateLanguage = async (req, res) => {
  try {
    const { language } = req.body;

    await prisma.userProfile.update({
      where: { userId: req.user.id },
      data: { language }
    });

    res.status(200).json({
      status: 'success',
      message: '语言设置已更新'
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
 * 更新用户密码
 * @route PUT /api/users/password
 * @access Private
 */
exports.updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // 获取用户
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    // 验证当前密码
    const isMatch = await bcrypt.compare(currentPassword, user.password);

    if (!isMatch) {
      return res.status(401).json({
        status: 'fail',
        message: '当前密码不正确'
      });
    }

    // 检查用户类型
    if (req.user.userType !== 'organization' && !req.user.isOrganization) {
      return res.status(403).json({
        status: 'fail',
        message: '只有组织用户可以修改密码'
      });
    }

    // 加密新密码
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // 更新密码
    await prisma.user.update({
      where: { id: req.user.id },
      data: { password: hashedPassword }
    });

    res.status(200).json({
      status: 'success',
      message: '密码已更新'
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
 * 获取用户积分信息
 * @route GET /api/users/points
 * @access Private
 */
exports.getUserPoints = async (req, res) => {
  try {
    // 获取用户积分记录
    const pointRecords = await prisma.point.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });

    // 计算总积分
    const totalPoints = pointRecords.reduce((sum, point) => sum + point.amount, 0);

    res.status(200).json({
      status: 'success',
      data: {
        totalPoints,
        history: pointRecords
      }
    });
  } catch (error) {
    console.error('Error fetching user points:', error);
    res.status(500).json({
      status: 'error',
      message: '获取用户积分失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 更新用户钱包地址
 * @route PUT /api/users/wallet
 * @access Private
 */
exports.updateWalletAddress = async (req, res) => {
  try {
    const { walletAddress, chainId } = req.body;

    // 检查用户类型
    if (req.user.userType === 'organization' || req.user.isOrganization) {
      return res.status(403).json({
        status: 'fail',
        message: '组织用户不能更新钱包地址'
      });
    }

    // 检查用户是否已经有钱包地址
    if (req.user.walletAddress) {
      return res.status(403).json({
        status: 'fail',
        message: '您已绑定钱包地址，不能再次更改'
      });
    }

    // 验证钱包地址格式（以太坊地址示例）
    if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        status: 'fail',
        message: '无效的钱包地址格式'
      });
    }

    // 检查地址是否已被其他用户使用
    if (walletAddress) {
      const existingUser = await prisma.user.findFirst({
        where: {
          walletAddress,
          id: { not: req.user.id }
        }
      });

      if (existingUser) {
        return res.status(400).json({
          status: 'fail',
          message: '该钱包地址已被其他用户绑定'
        });
      }
    }

    // 更新用户钱包地址
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        walletAddress,
        chainId: chainId || 1 // 默认以太坊主网
      }
    });

    // 移除敏感信息
    const { password, privateKey, ...userWithoutSensitive } = updatedUser;

    // 记录钱包绑定日志
    console.log(`User ${req.user.id} bound wallet address to ${walletAddress}`);

    res.status(200).json({
      status: 'success',
      message: '钱包地址已绑定',
      data: {
        user: userWithoutSensitive
      }
    });
  } catch (error) {
    console.error('Error updating wallet address:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 生成钱包 - 已禁用
 * @route POST /api/users/wallet/generate
 * @access Private
 * @deprecated 此功能已被禁用，请使用 Web3Auth 或其他安全的钱包生成方式
 */
exports.generateWallet = async (req, res) => {
  return res.status(403).json({
    status: 'fail',
    code: 'FEATURE_DISABLED',
    message: '此功能已被禁用，请使用 Web3Auth 或其他安全的钱包生成方式'
  });

  /* 原实现已禁用
  try {
    // 检查用户类型
    if (req.user.userType === 'organization' || req.user.isOrganization) {
      return res.status(403).json({
        status: 'fail',
        message: '组织用户不能生成钱包'
      });
    }

    // 检查用户是否已经有钱包地址
    if (req.user.walletAddress) {
      return res.status(403).json({
        status: 'fail',
        message: '您已绑定钱包地址，不能再次生成'
      });
    }

    // 生成钱包地址和私钥（这里使用模拟数据）
    const walletAddress = `0x${Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;
    const privateKey = `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;
    const chainId = 1; // 以太坊主网

    // 更新用户钱包信息
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        walletAddress,
        privateKey,
        chainId
      }
    });

    // 移除敏感信息
    const { password, privateKey: pk, ...userWithoutSensitive } = updatedUser;

    res.status(200).json({
      status: 'success',
      message: '钱包已生成',
      data: {
        user: userWithoutSensitive
      }
    });
  } catch (error) {
    console.error('Error generating wallet:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
  */
};

/**
 * 导入钱包私钥
 * @route POST /api/users/wallet/import
 * @access Private
 */
exports.importWallet = async (req, res) => {
  try {
    const { privateKey } = req.body;

    // 检查用户类型
    if (req.user.userType === 'organization' || req.user.isOrganization) {
      return res.status(403).json({
        status: 'fail',
        message: '组织用户不能导入钱包'
      });
    }

    // 检查用户是否已经有钱包地址
    if (req.user.walletAddress) {
      return res.status(403).json({
        status: 'fail',
        message: '您已绑定钱包地址，不能再次导入'
      });
    }

    if (!privateKey || !privateKey.startsWith('0x') || privateKey.length !== 66) {
      return res.status(400).json({
        status: 'fail',
        message: '无效的私钥格式'
      });
    }

    // 这里可以使用 ethers.js 或 web3.js 从私钥导入钱包
    // 为了简化示例，我们只设置一个模拟的钱包地址
    const walletAddress = `0x${Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;
    const chainId = 1; // 以太坊主网

    // 检查地址是否已被其他用户使用
    const existingUser = await prisma.user.findFirst({
      where: {
        walletAddress,
        id: { not: req.user.id }
      }
    });

    if (existingUser) {
      return res.status(400).json({
        status: 'fail',
        message: '该钱包地址已被其他用户绑定'
      });
    }

    // 更新用户钱包信息
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        walletAddress,
        privateKey,
        chainId
      }
    });

    // 移除敏感信息
    const { password, privateKey: pk, ...userWithoutSensitive } = updatedUser;

    res.status(200).json({
      status: 'success',
      message: '钱包已导入',
      data: {
        user: userWithoutSensitive
      }
    });
  } catch (error) {
    console.error('Error importing wallet:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};



/**
 * 获取当前用户注册时间
 * @route GET /api/users/registered-at
 * @access Private
 */
exports.getRegistrationTime = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { createdAt: true } });
    res.status(200).json({ status: 'success', data: { registeredAt: user.createdAt } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: '服务器错误', error: error.message });
  }
};

/**
 * Get current user's referral code
 * @route GET /api/users/referral-code
 * @access Private
 */
exports.getReferralCode = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { referralCode: true }
    });

    if (!user) {
      return res.status(404).json({
        status: 'fail',
        message: 'User not found'
      });
    }

    res.status(200).json({
      status: 'success',
      data: { code: user.referralCode }
    });
  } catch (error) {
    console.error('Error getting referral code:', error);
    res.status(500).json({
      status: 'error',
      message: 'Error retrieving referral code'
    });
  }
};

/**
 * 检查圣诞欢迎奖励领取状态
 * @route GET /api/users/christmas-welcome-bonus/status
 * @access Private
 */
exports.getChristmasWelcomeBonusStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const POINTS_AWARDED = 5;
    const SOURCE = 'CHRISTMAS_WELCOME_BONUS';

    // 检查是否已领取
    const existingClaim = await prisma.point.findFirst({
      where: {
        userId,
        source: SOURCE
      },
      orderBy: { createdAt: 'desc' }
    });

    res.status(200).json({
      status: 'success',
      data: {
        claimed: !!existingClaim,
        claimedAt: existingClaim?.createdAt || null,
        pointsAwarded: POINTS_AWARDED
      }
    });
  } catch (error) {
    console.error('Error checking Christmas welcome bonus status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 验证用户关注 X (Twitter)
 * @route POST /api/users/christmas-shopping/verify-x-follow
 * @access Private
 */
exports.verifyXFollow = async (req, res) => {
  try {
    const userId = req.user.id;
    const TASK_ID = 'follow-x'; // 需要在数据库中创建此任务
    const AWARD_ID = 'christmas-shopping';
    
    // 使用事务确保数据一致性
    const result = await prisma.$transaction(async (tx) => {
      // 检查任务是否存在
      const task = await tx.task.findUnique({
        where: { id: TASK_ID },
        select: { id: true, awardId: true, title: true }
      });
      
      if (!task || task.awardId !== AWARD_ID) {
        throw new Error('Task not found or invalid');
      }
      
      // 获取或创建 UserTask
      let userTask = await tx.userTask.findUnique({
        where: {
          userId_taskId: { userId, taskId: TASK_ID }
        }
      });
      
      const now = new Date();
      const alreadyCompleted = userTask?.claimed || (userTask?.claimRecords && userTask.claimRecords.length > 0);
      
      if (!alreadyCompleted) {
        // 标记任务为完成（通过添加 claimRecord）
        const claimRecords = userTask?.claimRecords || [];
        const newClaimRecords = [...claimRecords, now];
        
        if (userTask) {
          userTask = await tx.userTask.update({
            where: { userId_taskId: { userId, taskId: TASK_ID } },
            data: {
              claimRecords: newClaimRecords,
              claimed: true,
              status: 'LIVE'
            }
          });
        } else {
          userTask = await tx.userTask.create({
            data: {
              userId,
              taskId: TASK_ID,
              claimRecords: newClaimRecords,
              claimed: true,
              status: 'LIVE'
            }
          });
        }
      }
      
      // 获取所有圣诞任务的状态
      const { getTasksByAward } = require('../services/taskService');
      const allTasks = await getTasksByAward(userId, AWARD_ID);
      
      // 检查是否所有任务都完成
      const allCompleted = allTasks.every(t => t.finalStatus === 'COMPLETED' || t.claimed);
      
      // 如果所有任务完成，自动领取徽章
      if (allCompleted && allTasks.length > 0) {
        const CHRISTMAS_BADGE_ID = 'christmas-badge-2025';
        const CHRISTMAS_POINTS = 5;
        
        const badge = await tx.badge.findUnique({
          where: { id: CHRISTMAS_BADGE_ID }
        });
        
        if (badge) {
          const existingUserBadge = await tx.userBadge.findUnique({
            where: {
              userId_badgeId: {
                userId,
                badgeId: CHRISTMAS_BADGE_ID
              }
            }
          });
          
          if (!existingUserBadge) {
            await tx.userBadge.create({
              data: {
                userId,
                badgeId: CHRISTMAS_BADGE_ID,
                acquiredAt: now
              }
            });
            
            await tx.user.update({
              where: { id: userId },
              data: { totalPoints: { increment: CHRISTMAS_POINTS } }
            });
            
            await tx.point.create({
              data: {
                userId,
                amount: CHRISTMAS_POINTS,
                source: 'BADGE_CLAIM',
                sourceId: CHRISTMAS_BADGE_ID
              }
            });
            
            await tx.notification.create({
              data: {
                userId,
                type: 'BADGE',
                title: 'Christmas Badge Auto-claimed!',
                content: `Congratulations! You've completed all Christmas tasks and automatically earned the Exclusive DDC Christmas Badge and ${CHRISTMAS_POINTS} Points!`,
                isRead: false
              }
            });
          }
        }
      }
      
      // 构建任务状态映射
      const allTasksStatus = {};
      allTasks.forEach(t => {
        allTasksStatus[t.id] = {
          id: t.id,
          title: t.title,
          finalStatus: t.finalStatus,
          progress: t.progress || 0,
          doneCount: t.doneCount || 0,
          requiredCount: t.requirementCount || 1,
          ...(t.finalStatus === 'COMPLETED' || t.claimed ? {
            completedAt: userTask?.updatedAt || now
          } : {})
        };
      });
      
      return {
        verified: true,
        alreadyCompleted,
        verifiedAt: alreadyCompleted ? (userTask?.claimRecords?.[0] || userTask?.updatedAt || now) : now,
        taskId: TASK_ID,
        taskStatus: {
          id: TASK_ID,
          title: task.title,
          finalStatus: 'COMPLETED',
          progress: 1.0,
          completedAt: alreadyCompleted ? (userTask?.claimRecords?.[0] || userTask?.updatedAt || now) : now
        },
        allTasksStatus,
        allTasksCompleted: allCompleted
      };
    });
    
    res.status(200).json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error('Error verifying X follow:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 验证用户加入 Telegram
 * @route POST /api/users/christmas-shopping/verify-telegram-join
 * @access Private
 */
exports.verifyTelegramJoin = async (req, res) => {
  try {
    const userId = req.user.id;
    const TASK_ID = 'join-telegram'; // 需要在数据库中创建此任务
    const AWARD_ID = 'christmas-shopping';
    
    // 使用事务确保数据一致性
    const result = await prisma.$transaction(async (tx) => {
      // 检查任务是否存在
      const task = await tx.task.findUnique({
        where: { id: TASK_ID },
        select: { id: true, awardId: true, title: true }
      });
      
      if (!task || task.awardId !== AWARD_ID) {
        throw new Error('Task not found or invalid');
      }
      
      // 获取或创建 UserTask
      let userTask = await tx.userTask.findUnique({
        where: {
          userId_taskId: { userId, taskId: TASK_ID }
        }
      });
      
      const now = new Date();
      const alreadyCompleted = userTask?.claimed || (userTask?.claimRecords && userTask.claimRecords.length > 0);
      
      if (!alreadyCompleted) {
        // 标记任务为完成（通过添加 claimRecord）
        const claimRecords = userTask?.claimRecords || [];
        const newClaimRecords = [...claimRecords, now];
        
        if (userTask) {
          userTask = await tx.userTask.update({
            where: { userId_taskId: { userId, taskId: TASK_ID } },
            data: {
              claimRecords: newClaimRecords,
              claimed: true,
              status: 'LIVE'
            }
          });
        } else {
          userTask = await tx.userTask.create({
            data: {
              userId,
              taskId: TASK_ID,
              claimRecords: newClaimRecords,
              claimed: true,
              status: 'LIVE'
            }
          });
        }
      }
      
      // 获取所有圣诞任务的状态
      const { getTasksByAward } = require('../services/taskService');
      const allTasks = await getTasksByAward(userId, AWARD_ID);
      
      // 检查是否所有任务都完成
      const allCompleted = allTasks.every(t => t.finalStatus === 'COMPLETED' || t.claimed);
      
      // 如果所有任务完成，自动领取徽章
      if (allCompleted && allTasks.length > 0) {
        const CHRISTMAS_BADGE_ID = 'christmas-badge-2025';
        const CHRISTMAS_POINTS = 5;
        
        const badge = await tx.badge.findUnique({
          where: { id: CHRISTMAS_BADGE_ID }
        });
        
        if (badge) {
          const existingUserBadge = await tx.userBadge.findUnique({
            where: {
              userId_badgeId: {
                userId,
                badgeId: CHRISTMAS_BADGE_ID
              }
            }
          });
          
          if (!existingUserBadge) {
            await tx.userBadge.create({
              data: {
                userId,
                badgeId: CHRISTMAS_BADGE_ID,
                acquiredAt: now
              }
            });
            
            await tx.user.update({
              where: { id: userId },
              data: { totalPoints: { increment: CHRISTMAS_POINTS } }
            });
            
            await tx.point.create({
              data: {
                userId,
                amount: CHRISTMAS_POINTS,
                source: 'BADGE_CLAIM',
                sourceId: CHRISTMAS_BADGE_ID
              }
            });
            
            await tx.notification.create({
              data: {
                userId,
                type: 'BADGE',
                title: 'Christmas Badge Auto-claimed!',
                content: `Congratulations! You've completed all Christmas tasks and automatically earned the Exclusive DDC Christmas Badge and ${CHRISTMAS_POINTS} Points!`,
                isRead: false
              }
            });
          }
        }
      }
      
      // 构建任务状态映射
      const allTasksStatus = {};
      allTasks.forEach(t => {
        allTasksStatus[t.id] = {
          id: t.id,
          title: t.title,
          finalStatus: t.finalStatus,
          progress: t.progress || 0,
          doneCount: t.doneCount || 0,
          requiredCount: t.requirementCount || 1,
          ...(t.finalStatus === 'COMPLETED' || t.claimed ? {
            completedAt: userTask?.updatedAt || now
          } : {})
        };
      });
      
      return {
        verified: true,
        alreadyCompleted,
        verifiedAt: alreadyCompleted ? (userTask?.claimRecords?.[0] || userTask?.updatedAt || now) : now,
        taskId: TASK_ID,
        taskStatus: {
          id: TASK_ID,
          title: task.title,
          finalStatus: 'COMPLETED',
          progress: 1.0,
          completedAt: alreadyCompleted ? (userTask?.claimRecords?.[0] || userTask?.updatedAt || now) : now
        },
        allTasksStatus,
        allTasksCompleted: allCompleted
      };
    });
    
    res.status(200).json({
      status: 'success',
      data: result
    });
  } catch (error) {
    console.error('Error verifying Telegram join:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Daily check-in (idempotent per day)
 * @route POST /api/users/check-in
 * @access Private
 */
exports.checkIn = async (req, res) => {
  try {
    const userId = req.user.id;
    const day = startOfUtcDay(new Date());

    const event = await prisma.userDailyEvent.upsert({
      where: { userId_type_day: { userId, type: 'CHECK_IN', day } },
      update: {},
      create: { userId, type: 'CHECK_IN', day }
    });

    return res.status(200).json({
      status: 'success',
      data: {
        checkedIn: true,
        day: event.day.toISOString()
      }
    });
  } catch (error) {
    console.error('Error recording daily check-in:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Record a rewards hub visit (idempotent per day)
 * @route POST /api/users/rewards-hub-visit
 * @access Private
 */
exports.recordRewardsHubVisit = async (req, res) => {
  try {
    const userId = req.user.id;
    const day = startOfUtcDay(new Date());

    const event = await prisma.userDailyEvent.upsert({
      where: { userId_type_day: { userId, type: 'REWARDS_HUB_VISIT', day } },
      update: {},
      create: { userId, type: 'REWARDS_HUB_VISIT', day }
    });

    return res.status(200).json({
      status: 'success',
      data: {
        visited: true,
        day: event.day.toISOString()
      }
    });
  } catch (error) {
    console.error('Error recording rewards hub visit:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 领取圣诞欢迎奖励
 * @route POST /api/users/christmas-welcome-bonus/claim
 * @access Private
 */
exports.claimChristmasWelcomeBonus = async (req, res) => {
  try {
    const userId = req.user.id;
    const POINTS_AWARDED = 5;
    const SOURCE = 'CHRISTMAS_WELCOME_BONUS';
    
    // 圣诞活动时间范围（可根据实际需求调整）
    const CHRISTMAS_START = new Date('2025-12-01T00:00:00Z');
    const CHRISTMAS_END = new Date('2025-12-31T23:59:59Z');
    const now = new Date();

    // 检查是否在活动期间
    if (now < CHRISTMAS_START || now > CHRISTMAS_END) {
      return res.status(400).json({
        status: 'error',
        message: 'Christmas Welcome Bonus is not available at this time',
        code: 'NOT_ELIGIBLE'
      });
    }

    // 使用事务确保并发安全
    const result = await prisma.$transaction(async (tx) => {
      // 检查是否已领取（在事务内检查，防止并发问题）
      const existingClaim = await tx.point.findFirst({
        where: {
          userId,
          source: SOURCE
        }
      });

      if (existingClaim) {
        throw new Error('ALREADY_CLAIMED');
      }

      // 更新用户总积分
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          totalPoints: { increment: POINTS_AWARDED }
        },
        select: { totalPoints: true }
      });

      // 创建积分记录
      const pointRecord = await tx.point.create({
        data: {
          userId,
          amount: POINTS_AWARDED,
          source: SOURCE,
          sourceId: 'christmas_welcome_bonus_2024'
        }
      });

      return {
        pointsAwarded: POINTS_AWARDED,
        newBalance: updatedUser.totalPoints,
        claimedAt: pointRecord.createdAt
      };
    }, {
      isolationLevel: 'Serializable' // 最高隔离级别，防止并发问题
    });

    res.status(200).json({
      status: 'success',
      message: 'Christmas Welcome Bonus claimed successfully',
      data: {
        pointsAwarded: result.pointsAwarded,
        description: 'Christmas Welcome Bonus',
        newBalance: result.newBalance,
        claimedAt: result.claimedAt
      }
    });
  } catch (error) {
    console.error('Error claiming Christmas welcome bonus:', error);
    
    // 处理已领取错误
    if (error.message === 'ALREADY_CLAIMED') {
      return res.status(400).json({
        status: 'error',
        message: 'Christmas Welcome Bonus has already been claimed',
        code: 'ALREADY_CLAIMED'
      });
    }

    // 处理其他错误
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};