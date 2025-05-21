const prisma = require('../utils/prisma');
const { generateToken } = require('../utils/jwtUtils');
const { createLogger } = require('../utils/logger');
const userService = require('../services/userService');
const referralService = require('../services/referralService');
const { generateReferralCode } = require('../utils/referralUtils');

const logger = createLogger('web3AuthController');

/**
 * POST /api/auth/web3auth-login
 * Public endpoint for Web3Auth login or registration via email, wallet, or X account.
 * For new registrations, validates referral code and records referral relation.
 */
exports.web3authLogin = async (req, res) => {
  try {
    const { userInfo, walletAddress, xid, xUsername, xAccessToken, xRefreshToken, referralCode } = req.body;
    
    logger.info('Web3Auth login attempt', { 
      email: userInfo?.email,
      walletAddress,
      xid,
      hasReferralCode: Boolean(referralCode)
    });

    // 1. 基础验证
    if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        status: 'fail',
        code: 'INVALID_WALLET_FORMAT',
        message: 'Invalid wallet address format'
      });
    }

    if (!userInfo?.email && !walletAddress && !xid) {
      return res.status(400).json({
        status: 'fail',
        code: 'MISSING_CREDENTIALS',
        message: 'Email, wallet address, or X ID is required'
      });
    }

    // 2. 查找用户
    let user = null;
    if (xid) {
      user = await prisma.user.findUnique({ where: { xid } });
    } else if (walletAddress) {
      user = await prisma.user.findFirst({ where: { walletAddress } });
    } else if (userInfo?.email) {
      user = await prisma.user.findUnique({ where: { email: userInfo.email } });
    }

    // 3. 处理现有用户登录
    if (user) {
      // 检查用户类型
      if (user.userType === 'organization' || user.isOrganization) {
        return res.status(403).json({
          status: 'fail',
          code: 'UNAUTHORIZED_USER_TYPE',
          message: 'Organization accounts cannot use Web3Auth'
        });
      }

      // 更新用户信息
      const updateData = {
        authType: 'web3auth',
        ...(xid && { xid }),
        ...(xUsername && { xUsername }),
        ...(xAccessToken && { xAccessToken }),
        ...(xRefreshToken && { xRefreshToken })
      };

      // 如果是首次绑定钱包
      if (walletAddress && !user.walletAddress) {
        const existingWallet = await prisma.user.findFirst({
          where: { walletAddress, id: { not: user.id } }
        });
        if (existingWallet) {
          return res.status(400).json({
            status: 'fail',
            code: 'WALLET_IN_USE',
            message: 'Wallet address already in use'
          });
        }
        updateData.walletAddress = walletAddress;
      }

      user = await prisma.user.update({
        where: { id: user.id },
        data: updateData
      });

      const token = generateToken(user.id);
      const { password, privateKey, ...safeUser } = user;
      return res.status(200).json({
        status: 'success',
        data: { token, user: safeUser }
      });
    }

    // 4. 处理新用户注册
    if (!userInfo?.email || !walletAddress) {
      return res.status(400).json({
        status: 'fail',
        code: 'INCOMPLETE_INFO',
        message: 'Email and wallet address are required for new user registration'
      });
    }

    // 验证邀请码
    let referrerId = null;
    if (referralCode) {
      try {
        const referralData = await validateReferralCode(referralCode);
        if (!referralData.valid) {
          return res.status(400).json({
            status: 'fail',
            code: 'INVALID_REFERRAL_CODE',
            message: 'Invalid or expired referral code'
          });
        }
        referrerId = referralData.referrerId;
      } catch (error) {
        logger.error('Referral code validation error', { error: error.message });
        return res.status(500).json({
          status: 'error',
          code: 'REFERRAL_VALIDATION_ERROR',
          message: 'Failed to validate referral code'
        });
      }
    }

    // 创建新用户
    const newUser = await prisma.user.create({
      data: {
        email: userInfo.email,
        name: userInfo.name || userInfo.email.split('@')[0],
        avatar: userInfo.profileImage,
        walletAddress,
        authType: 'web3auth',
        userType: 'regular',
        referralCode: generateReferralCode(),
        ...(xid && { xid }),
        ...(xUsername && { xUsername }),
        ...(xAccessToken && { xAccessToken }),
        ...(xRefreshToken && { xRefreshToken }),
        profile: { create: { language: 'en' } },
        ...(referrerId && {
          referredBy: { connect: { id: referrerId } }
        })
      }
    });

    const token = generateToken(newUser.id);
    const { password, privateKey, ...safeUser } = newUser;

    return res.status(201).json({
      status: 'success',
      data: {
        token,
        user: safeUser,
        ...(referrerId && {
          invitationStatus: {
            success: true,
            code: 'REFERRAL_SUCCESSFUL',
            message: 'Successfully registered with referral code'
          }
        })
      }
    });

  } catch (error) {
    logger.error('Web3Auth login error', { error: error.message });
    
    if (error.code === 'P2002') {
      return res.status(409).json({
        status: 'fail',
        code: 'DUPLICATE_ENTRY',
        message: 'User with this email or wallet address already exists'
      });
    }

    return res.status(500).json({
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'An unexpected error occurred',
      ...(process.env.NODE_ENV === 'development' && { debug: error.message })
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

    logger.info('Update wallet address attempt', { userId, walletAddress });

    // Validate wallet address format
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      logger.warn('Invalid wallet address format', { walletAddress });
      return res.status(400).json({
        status: 'fail',
        code: 'INVALID_WALLET_FORMAT',
        message: 'Invalid wallet address format. Must be a valid Ethereum address starting with 0x'
      });
    }

    // Check user type
    if (req.user.userType === 'organization' || req.user.isOrganization) {
      logger.warn('Organization attempted to update wallet', { userId });
      return res.status(403).json({
        status: 'fail',
        code: 'UNAUTHORIZED_USER_TYPE',
        message: 'Organization accounts cannot update their wallet address'
      });
    }

    // Check if user already has a wallet address
    if (req.user.walletAddress) {
      logger.warn('User attempted to update existing wallet', { 
        userId,
        existingWallet: req.user.walletAddress
      });
      return res.status(403).json({
        status: 'fail',
        code: 'WALLET_ALREADY_BOUND',
        message: 'You have already bound a wallet address. Cannot update existing wallet'
      });
    }

    // Check if wallet address is used by another user
    const existingWalletUser = await prisma.user.findFirst({
      where: {
        walletAddress,
        id: { not: userId }
      }
    });

    if (existingWalletUser) {
      logger.warn('Wallet address already in use', { 
        walletAddress,
        existingUserId: existingWalletUser.id
      });
      return res.status(400).json({
        status: 'fail',
        code: 'WALLET_IN_USE',
        message: 'This wallet address is already bound to another user account'
      });
    }

    // Update user's wallet address
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        walletAddress,
        chainId: 1 // Default to Ethereum mainnet
      }
    });

    logger.info('Successfully bound wallet address', {
      userId,
      walletAddress,
      chainId: 1
    });

    // Remove sensitive information
    const { password, privateKey, ...userWithoutSensitive } = updatedUser;

    res.status(200).json({
      status: 'success',
      code: 'WALLET_BOUND',
      message: 'Wallet address successfully bound to account',
      data: {
        user: userWithoutSensitive
      }
    });
  } catch (error) {
    logger.error('Update wallet error', { 
      userId,
      error: error.message,
      stack: error.stack
    });

    let statusCode = 500;
    let errorResponse = {
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'An unexpected error occurred while updating wallet address'
    };

    // Handle specific error types
    if (error.code === 'P2025') {
      statusCode = 404;
      errorResponse = {
        status: 'fail',
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      };
    }

    // Add detailed error in development
    if (process.env.NODE_ENV === 'development') {
      errorResponse.debug = {
        message: error.message,
        code: error.code,
        stack: error.stack
      };
    }

    res.status(statusCode).json(errorResponse);
  }
};