const prisma = require('../utils/prisma');
const { generateToken } = require('../utils/jwtUtils');
const { createLogger } = require('../utils/logger');
const userService = require('../services/userService');
const referralService = require('../services/referralService');

const logger = createLogger('web3AuthController');

/**
 * POST /api/auth/web3auth-login
 * Public endpoint for Web3Auth login or registration via email, wallet, or X account.
 * For new registrations, validates referral code and records referral relation.
 */
exports.web3authLogin = async (req, res) => {
  try {
    const { userInfo, walletAddress, xid, xUsername, xAccessToken, xRefreshToken, inviteCode } = req.body;
    // Determine login channel
    const isXLogin = Boolean(xid);
    const isWalletLogin = Boolean(walletAddress && !isXLogin);
    const isEmailLogin = Boolean(userInfo?.email && !isXLogin && !walletAddress);

    logger.info('Web3Auth login attempt', { 
      email: userInfo?.email,
      walletAddress,
      xid,
      hasInviteCode: Boolean(inviteCode)
    });

    // Validate wallet address format if provided
    if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      logger.warn('Invalid wallet address format', { walletAddress });
      return res.status(400).json({
        status: 'fail',
        code: 'INVALID_WALLET_FORMAT',
        message: 'Invalid wallet address format. Must be a valid Ethereum address starting with 0x'
      });
    }

    // Require at least email or wallet address
    if (!userInfo?.email && !walletAddress) {
      logger.warn('Missing credentials');
      return res.status(400).json({
        status: 'fail',
        code: 'MISSING_CREDENTIALS',
        message: 'Email or wallet address is required.'
      });
    }

    // Scenario 0: X (Twitter) login
    if (isXLogin) {
      let user = await prisma.user.findUnique({ where: { xid } });
      // If no binding by xid, try matching existing account by email
      if (!user && userInfo?.email) {
        user = await prisma.user.findUnique({ where: { email: userInfo.email } });
        if (user) {
          if (user.isOrganization) {
            return res.status(403).json({
              status: 'fail',
              code: 'UNAUTHORIZED_USER_TYPE',
              message: 'Organization accounts cannot link X login'
            });
          }
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              xid,
              ...(xUsername && { xUsername }),
              ...(xAccessToken && { xAccessToken }),
              ...(xRefreshToken && { xRefreshToken }),
              authType: 'web3auth'
            }
          });
        }
      }
      // If still not found, create new user for X login
      if (!user) {
        user = await prisma.user.create({
          data: {
            email: userInfo?.email,
            name: userInfo?.name,
            avatar: userInfo?.profileImage,
            xid,
            ...(xUsername && { xUsername }),
            ...(xAccessToken && { xAccessToken }),
            ...(xRefreshToken && { xRefreshToken }),
            authType: 'web3auth',
            userType: 'regular',
            profile: { create: { language: 'en' } }
          }
        });
      }
      const token = generateToken(user.id);
      const { password, privateKey, ...safeUser } = user;
      return res.status(200).json({
        status: 'success',
        code: 'LOGIN_SUCCESS',
        data: { token, user: { ...safeUser, xUsername: user.xUsername, isOrganization: user.isOrganization } }
      });
    }
    // Scenario 1: Wallet login or linking
    if (isWalletLogin) {
      const userByWallet = await prisma.user.findFirst({
        where: { walletAddress }
      });

      if (userByWallet) {
        // 更新 X 相关字段（如果提供）
        if (xid || xUsername || xAccessToken || xRefreshToken) {
          await prisma.user.update({
            where: { id: userByWallet.id },
            data: {
              ...(xid && { xid }),
              ...(xUsername && { xUsername }),
              ...(xAccessToken && { xAccessToken }),
              ...(xRefreshToken && { xRefreshToken }),
              authType: 'web3auth'
            }
          });
        }

        // Block organization users
        if (userByWallet.userType === 'organization' || userByWallet.isOrganization) {
          logger.warn('Organization user login attempt', { userId: userByWallet.id });
          return res.status(403).json({
            status: 'fail',
            code: 'UNAUTHORIZED_USER_TYPE',
            message: 'Organization accounts cannot login via Web3Auth.'
          });
        }

        // 生成 token
        const token = generateToken(userByWallet.id);
        
        // 移除敏感信息
        const { password, privateKey, ...userWithoutSensitive } = await prisma.user.findUnique({ where: { id: userByWallet.id } });

        return res.status(200).json({
          status: 'success',
          code: 'LOGIN_SUCCESS',
          data: {
            token,
            user: {
              ...userWithoutSensitive,
              xUsername: userWithoutSensitive.xUsername,
              isOrganization: userByWallet.isOrganization
            }
          }
        });
      }
    }

    // Scenario 2: Email login or registration
    if (isEmailLogin) {
      let user = await prisma.user.findUnique({ where: { email: userInfo.email } });
      if (user) {
        // Block organization accounts
        if (user.userType === 'organization' || user.isOrganization) {
          return res.status(403).json({
            status: 'fail',
            code: 'UNAUTHORIZED_USER_TYPE',
            message: 'Organization accounts cannot login via Web3Auth'
          });
        }

        // Only bind wallet on first-time wallet association
        if (walletAddress && !user.walletAddress) {
          const existing = await prisma.user.findFirst({
            where: { walletAddress, id: { not: user.id } }
          });
          if (existing) {
            return res.status(400).json({
              status: 'fail',
              code: 'WALLET_IN_USE',
              message: 'This wallet address is already bound to another account'
            });
          }
          user = await prisma.user.update({
            where: { id: user.id },
            data: { walletAddress, authType: 'web3auth' }
          });
        }

        // Issue token without altering name/avatar/x-fields
        const token = generateToken(user.id);
        const { password, privateKey, ...safeUser } = user;
        return res.status(200).json({
          status: 'success',
          code: 'LOGIN_SUCCESS',
          data: { token, user: { ...safeUser, isOrganization: user.isOrganization } }
        });
      }

      // Registration path: require walletAddress
      if (walletAddress) {
        // Validate invite code if provided
        let referrerId = null;
        if (inviteCode) {
          try {
            const inviteData = await validateInviteCode(inviteCode);
            if (!inviteData.valid) {
              logger.warn('Invalid invite code used', { inviteCode });
              return res.status(400).json({
                status: 'fail',
                code: 'INVALID_INVITE_CODE',
                message: 'The invite code is invalid or has expired'
              });
            }
            referrerId = inviteData.referrerId;
          } catch (error) {
            logger.error('Error validating invite code', { 
              inviteCode,
              error: error.message 
            });
            return res.status(500).json({
              status: 'error',
              code: 'INVITE_VALIDATION_ERROR',
              message: 'Failed to validate invite code'
            });
          }
        }

        // Generate invite code for the new user
        const userInviteCode = generateInviteCode();
        
        // Create new user with referral data
        const newUser = await prisma.user.create({
          data: {
            email: userInfo.email,
            name: userInfo.name || userInfo.email.split('@')[0],
            avatar: userInfo.profileImage,
            walletAddress,
            authType: 'web3auth',
            userType: 'regular',
            inviteCode: userInviteCode,
            ...(xid && { xid }),
            ...(xAccessToken && { xAccessToken }),
            ...(xRefreshToken && { xRefreshToken }),
            profile: {
              create: {
                language: 'en'
              }
            },
            ...(referrerId && {
              referredBy: {
                connect: { id: referrerId }
              }
            })
          },
          include: {
            profile: true,
            referredBy: true
          }
        });

        // 生成 token
        const token = generateToken(newUser.id);
        
        // 移除敏感信息
        const { password, privateKey, ...userWithoutSensitive } = newUser;

        // Record successful registration
        logger.info('New user registered', {
          userId: newUser.id,
          email: newUser.email,
          referrerId: referrerId,
          inviteCode: userInviteCode
        });

        return res.status(201).json({
          status: 'success',
          data: {
            token,
            user: {
              ...userWithoutSensitive,
              isOrganization: false
            },
            invitationStatus: referrerId ? {
              success: true,
              code: 'REFERRAL_SUCCESSFUL',
              message: 'Successfully registered with invite code'
            } : undefined
          }
        });
      }
    }

    // If we get here, we don't have enough information to create a new user
    logger.warn('Incomplete user information for registration');
    return res.status(400).json({
      status: 'fail',
      code: 'INCOMPLETE_INFO',
      message: 'Email and wallet address are required to create a new user account'
    });
  } catch (error) {
    logger.error('Web3Auth login error', { 
      error: error.message,
      stack: error.stack
    });

    // Determine the appropriate error response
    let statusCode = 500;
    let errorResponse = {
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'An unexpected error occurred'
    };

    // Handle specific error types
    if (error.code === 'P2002') {
      statusCode = 409;
      errorResponse = {
        status: 'fail',
        code: 'DUPLICATE_ENTRY',
        message: 'A user with this email or wallet address already exists'
      };
    } else if (error.code === 'P2025') {
      statusCode = 404;
      errorResponse = {
        status: 'fail',
        code: 'NOT_FOUND',
        message: 'The requested resource was not found'
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