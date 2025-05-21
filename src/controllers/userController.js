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
 * 获取当前用户的邀请码
 * @route GET /api/users/invite-code
 * @access Private
 */
exports.getInviteCode = async (req, res) => {
  try {
    // 从用户表读取 referralCode
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { referralCode: true } });
    if (!user?.referralCode) {
      return res.status(404).json({ status: 'fail', message: '邀请码不存在' });
    }
    res.status(200).json({ status: 'success', data: { code: user.referralCode } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: '服务器错误', error: error.message });
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