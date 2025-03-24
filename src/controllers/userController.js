const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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
      isOrganization: user.isOrganization,
      totalPoints: user.totalPoints
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
        chainId: chainId || null
      }
    });

    // 移除敏感信息
    const { password, ...userWithoutPassword } = updatedUser;

    res.status(200).json({
      status: 'success',
      message: '钱包地址已更新',
      data: {
        user: userWithoutPassword
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