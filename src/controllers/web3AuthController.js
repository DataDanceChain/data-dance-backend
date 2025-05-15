const prisma = require('../utils/prisma');
const { generateToken } = require('../utils/jwtUtils');

/**
 * Web3Auth 登录/注册
 * @route POST /api/auth/web3auth-login
 * @access Public
 */
exports.web3authLogin = async (req, res) => {
  try {
    const { userInfo, walletAddress, xid, xAccessToken, xRefreshToken } = req.body;

    // 验证钱包地址格式（如果提供）
    if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        status: 'fail',
        message: '无效的钱包地址格式'
      });
    }

    // 场景1: 提供了钱包地址，尝试通过钱包地址查找用户
    if (walletAddress) {
      const userByWallet = await prisma.user.findFirst({
        where: { walletAddress }
      });

      if (userByWallet) {
        // 更新 X 相关字段（如果提供）
        if (xid || xAccessToken || xRefreshToken) {
          await prisma.user.update({
            where: { id: userByWallet.id },
            data: {
              ...(xid && { xid }),
              ...(xAccessToken && { xAccessToken }),
              ...(xRefreshToken && { xRefreshToken }),
              authType: 'web3auth'
            }
          });
        }

        // 找到了用户，直接登录
        if (userByWallet.userType === 'organization' || userByWallet.isOrganization) {
          return res.status(403).json({
            status: 'fail',
            message: '组织用户不能使用 Web3Auth 登录'
          });
        }

        // 生成 token
        const token = generateToken(userByWallet.id);
        
        // 移除敏感信息
        const { password, privateKey, ...userWithoutSensitive } = await prisma.user.findUnique({ where: { id: userByWallet.id } });

        return res.status(200).json({
          status: 'success',
          data: {
            token,
            user: {
              ...userWithoutSensitive,
              isOrganization: userByWallet.userType === 'organization' || userByWallet.isOrganization
            }
          }
        });
      }
    }

    // 场景2: 提供了邮箱，尝试通过邮箱查找用户
    if (userInfo && userInfo.email) {
      let user = await prisma.user.findUnique({
        where: { email: userInfo.email }
      });

      if (user) {
        // 检查用户类型
        if (user.userType === 'organization' || user.isOrganization) {
          return res.status(403).json({
            status: 'fail',
            message: '组织用户不能使用 Web3Auth 登录'
          });
        }

        // 如果提供了钱包地址且用户还没有绑定钱包，则更新钱包地址
        if (walletAddress && !user.walletAddress) {
          // 检查钱包地址是否已被其他用户使用
          const existingWalletUser = await prisma.user.findFirst({
            where: {
              walletAddress,
              id: { not: user.id }
            }
          });

          if (existingWalletUser) {
            return res.status(400).json({
              status: 'fail',
              message: '该钱包地址已被其他用户绑定'
            });
          }

          // 更新用户信息
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              name: userInfo.name || user.name,
              avatar: userInfo.profileImage || user.avatar,
              walletAddress,
              authType: 'web3auth',
              ...(xid && { xid }),
              ...(xAccessToken && { xAccessToken }),
              ...(xRefreshToken && { xRefreshToken })
            }
          });
        } else {
          // 更新用户信息，但不更新钱包地址
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              name: userInfo.name || user.name,
              avatar: userInfo.profileImage || user.avatar,
              authType: 'web3auth',
              ...(xid && { xid }),
              ...(xAccessToken && { xAccessToken }),
              ...(xRefreshToken && { xRefreshToken })
            }
          });
        }

        // 生成 token
        const token = generateToken(user.id);
        
        // 移除敏感信息
        const { password, privateKey, ...userWithoutSensitive } = user;

        return res.status(200).json({
          status: 'success',
          data: {
            token,
            user: {
              ...userWithoutSensitive,
              isOrganization: user.userType === 'organization' || user.isOrganization
            }
          }
        });
      }

      // 用户不存在，需要创建新用户
      if (walletAddress) {
        // 创建新用户
        const newUser = await prisma.user.create({
          data: {
            email: userInfo.email,
            name: userInfo.name || userInfo.email.split('@')[0],
            avatar: userInfo.profileImage,
            walletAddress,
            authType: 'web3auth',
            userType: 'regular',
            ...(xid && { xid }),
            ...(xAccessToken && { xAccessToken }),
            ...(xRefreshToken && { xRefreshToken }),
            profile: {
              create: {
                language: 'zh'
              }
            }
          },
          include: {
            profile: true
          }
        });

        // 生成 token
        const token = generateToken(newUser.id);
        
        // 移除敏感信息
        const { password, privateKey, ...userWithoutSensitive } = newUser;

        return res.status(201).json({
          status: 'success',
          data: {
            token,
            user: {
              ...userWithoutSensitive,
              isOrganization: false
            }
          }
        });
      }
    }

    // 如果到这里，说明既没有找到用户，也没有足够的信息创建新用户
    return res.status(400).json({
      status: 'fail',
      message: '用户信息不完整，需要提供邮箱和钱包地址来创建新用户'
    });
  } catch (error) {
    console.error('Web3Auth login error:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 更新用户钱包地址
 * @route POST /api/auth/update-wallet
 * @access Private
 */
exports.updateWallet = async (req, res) => {
  try {
    const { walletAddress } = req.body;
    const userId = req.user.id;

    // 验证钱包地址格式
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        status: 'fail',
        message: '无效的钱包地址格式'
      });
    }

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

    // 检查钱包地址是否已被其他用户使用
    const existingWalletUser = await prisma.user.findFirst({
      where: {
        walletAddress,
        id: { not: userId }
      }
    });

    if (existingWalletUser) {
      return res.status(400).json({
        status: 'fail',
        message: '该钱包地址已被其他用户绑定'
      });
    }

    // 更新用户钱包地址
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        walletAddress,
        chainId: 1 // 默认以太坊主网
      }
    });

    // 记录钱包更新日志
    console.log(`User ${userId} bound wallet address to ${walletAddress}`);

    // 移除敏感信息
    const { password, privateKey, ...userWithoutSensitive } = updatedUser;

    res.status(200).json({
      status: 'success',
      message: '钱包地址已绑定',
      data: {
        user: userWithoutSensitive
      }
    });
  } catch (error) {
    console.error('Update wallet error:', error);
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};