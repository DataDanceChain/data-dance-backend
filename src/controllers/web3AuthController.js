const prisma = require('../utils/prisma');
const { generateToken } = require('../utils/jwtUtils');
const { xApiClient } = require('../utils/xClient');
// Import cuid function for generating unique referral codes
const { cuid } = require('@paralleldrive/cuid2');

/**
 * Generates a unique referral code for a user.
 * Example format: REF-CUID_SUFFIX (cuid is generally good for uniqueness)
 * Adjust format as needed.
 */
const generateReferralCode = () => {
  return `REF-${cuid().slice(-8).toUpperCase()}`; // Use a portion of cuid for brevity
};

/**
 * Web3Auth 登录/注册
 * @route POST /api/auth/web3auth-login
 * @access Public
 */
exports.web3authLogin = async (req, res) => {
  try {
    console.log('Request body for /api/auth/web3auth-login:', req.body);
    const { userInfo, walletAddress, xid, xAccessToken, xRefreshToken, xUsername: clientXUsername, invitationCode } = req.body; // Added invitationCode

    // 验证钱包地址格式（如果提供）
    if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        status: 'fail',
        message: '无效的钱包地址格式'
      });
    }

    // Determine login channel based on provided credentials
    const isXLogin = Boolean(xid && xAccessToken);
    const isWalletLogin = Boolean(walletAddress && !isXLogin);
    const isEmailLogin = Boolean(userInfo && userInfo.email && !isXLogin && !walletAddress);
    if (!isXLogin && !isWalletLogin && !isEmailLogin) {
      return res.status(400).json({ status: 'fail', code: 'MISSING_CREDENTIAL', message: 'Missing authentication credential' }); // Added code
    }

    let user = null;
    let isNewUser = false; // Flag to check if user was created in this request

    // Locate user by the primary credential of current channel
    if (isXLogin) {
      user = await prisma.user.findUnique({ where: { xid } });
    } else if (isWalletLogin) {
      user = await prisma.user.findFirst({ where: { walletAddress } });
    } else if (isEmailLogin) {
      user = await prisma.user.findUnique({ where: { email: userInfo.email } });
    }

    // If user not found, create new user with all provided credentials
    if (!user) {
      isNewUser = true;
      const createData = {
        authType: 'web3auth',
        userType: 'regular',
        referralCode: generateReferralCode(), // Generate referral code for new user
      };
      if (isEmailLogin) {
        createData.email = userInfo.email;
        createData.name = userInfo.name || userInfo.email.split('@')[0];
        createData.avatar = userInfo.profileImage;
      }
      if (isWalletLogin) {
        createData.walletAddress = walletAddress;
      }
      if (isXLogin) {
        createData.xid = xid;
        if (clientXUsername) createData.xUsername = clientXUsername;
        createData.xAccessToken = xAccessToken;
        createData.xRefreshToken = xRefreshToken;
      }
      user = await prisma.user.create({ data: createData });
    }

    // Now user is identified (either found or newly created)
    // Update missing bound credentials safely (if user existed)
    if (!isNewUser) {
      const updateFields = {};
      if (!user.xid && xid) updateFields.xid = xid;
      if (!user.xUsername && clientXUsername) updateFields.xUsername = clientXUsername;
      if (!user.xAccessToken && xAccessToken) updateFields.xAccessToken = xAccessToken;
      if (!user.xRefreshToken && xRefreshToken) updateFields.xRefreshToken = xRefreshToken;
      if (!user.email && userInfo && userInfo.email && isEmailLogin) updateFields.email = userInfo.email;
      if (!user.walletAddress && walletAddress && isWalletLogin) updateFields.walletAddress = walletAddress;

      if (Object.keys(updateFields).length) {
        const updatedUserInstance = await prisma.user.update({ where: { id: user.id }, data: updateFields });
        user = { ...user, ...updatedUserInstance }; // Merge updates into user object
      }
    }
    
    // If a new user was created and an invitation code was provided, process the referral
    if (isNewUser && invitationCode) {
      console.log(`New user ${user.id} registered with invitation code: ${invitationCode}`);
      const referrer = await prisma.user.findUnique({
        where: { referralCode: invitationCode },
      });

      if (referrer) {
        if (referrer.id === user.id) {
          console.warn(`User ${user.id} attempted to use their own invitation code.`);
          // Add status to the response later
        } else {
          // Check if the new user (invitee) has already been invited
          const existingReferralForInvitee = await prisma.referral.findUnique({
            where: { inviteeId: user.id },
          });

          if (existingReferralForInvitee) {
            console.warn(`User ${user.id} (invitee) has already been recorded in a referral by user ${existingReferralForInvitee.inviterId}.`);
            // Add status to the response later
          } else {
            try {
              await prisma.referral.create({
                data: {
                  inviterId: referrer.id,
                  inviteeId: user.id,
                  code: invitationCode, // This is the code string used
                },
              });
              console.log(`Referral link created: User ${referrer.id} referred User ${user.id} using code ${invitationCode}.`);
              // 处理多级邀请奖励
              const { processReferral } = require('../services/referralService');
              await processReferral(user.id, referrer.id);
              // TODO: Add logic here to award points/badges to referrer and/or referee
              // Example: await awardPointsForReferral(referrer.id, user.id);
            } catch (referralError) {
              // This catch block might be redundant if P2002 on refereeId is checked beforehand,
              // but kept for other potential errors during referral creation.
              console.error('Error creating referral record:', referralError);
            }
          }
        }
      } else {
        console.warn(`Invitation code "${invitationCode}" provided by new user ${user.id} is invalid or does not belong to an existing user.`);
        // Add status to the response later
      }
    }

    // Issue token and respond
    const token = generateToken(user.id);
    const { password, privateKey, ...safeUser } = user;
    
    // Build the final response object
    const responseData = { token, user: { ...safeUser, isOrganization: user.userType === 'organization' || user.isOrganization } };
    
    // Add invitation status to the response if applicable
    if (isNewUser && invitationCode) {
      const finalReferrer = await prisma.user.findUnique({ where: { referralCode: invitationCode } });
      const finalReferralRecord = await prisma.referral.findUnique({ where: { refereeId: user.id } });

      if (!finalReferrer) {
        responseData.invitationStatus = { success: false, code: 'INVALID_INVITATION_CODE', message: '邀请码无效或不存在。' };
      } else if (finalReferrer.id === user.id) {
        responseData.invitationStatus = { success: false, code: 'SELF_REFERRAL_NOT_ALLOWED', message: '不能使用自己的邀请码。' };
      } else if (finalReferralRecord) {
        if (finalReferralRecord.inviterId === finalReferrer.id) {
          responseData.invitationStatus = { success: true, code: 'REFERRAL_SUCCESSFUL', message: '邀请关系已成功记录。' };
        } else {
          // This case means the user was already referred by someone else,
          // and the current invitationCode's referrer is different.
          responseData.invitationStatus = { success: false, code: 'ALREADY_REFERRED_BY_ANOTHER', message: '该账户已被其他邀请码推荐。' };
        }
      } else {
        // This implies the invitation code was valid, not self-referral, but referral creation failed for other reasons
        // or was not attempted because the user was already referred by someone else with a *different* code initially.
        // This state might be tricky. If referral creation failed silently or was skipped due to prior referral,
        // it's best to rely on the absence of a successful referral record.
        // For simplicity, if no record and not self-referral, and referrer exists, it implies an issue or a race condition not handled.
        // However, the pre-check for existingReferralForInvitee should cover most "already referred" cases.
        // If finalReferralRecord is null here, it means the referral.create didn't happen or failed.
        // Let's assume if no record, and referrer was valid, the code was valid but not applied.
         responseData.invitationStatus = { success: false, code: 'REFERRAL_NOT_APPLIED', message: '邀请码有效，但未成功应用邀请关系（可能已被邀请或发生内部错误）。' };
      }
    }

    // Return token, user, and optional invitationStatus under data
    const response = {
      status: 'success',
      data: {
        token: responseData.token,
        user: responseData.user
      }
    };
    if (responseData.invitationStatus) {
      response.data.invitationStatus = responseData.invitationStatus;
    }
    return res.status(200).json(response);

  } catch (error) {
    console.error('Web3Auth login error:', error);
    // If xid unique constraint triggers, treat as login for existing user
    if (error.code === 'P2002' && Array.isArray(error.meta?.target) && error.meta.target.includes('xid')) {
      const existingUser = await prisma.user.findUnique({ where: { xid: req.body.xid } });
      if (existingUser) {
        const token = generateToken(existingUser.id);
        const { password, privateKey, ...safeUser } = existingUser;
        // Return existing user login under data
        return res.status(200).json({
          status: 'success',
          data: {
            token,
            user: { ...safeUser, isOrganization: existingUser.userType === 'organization' || existingUser.isOrganization }
          }
        });
      }
    }
    return res.status(500).json({ status: 'error', code: 'SERVER_ERROR', message: 'Internal server error' });
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