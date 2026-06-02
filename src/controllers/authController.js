const bcrypt = require('bcryptjs');
const { generateToken } = require('../utils/jwtUtils');
const prisma = require('../utils/prisma');
const { generateReferralCode } = require('../utils/referralUtils');
const referralService = require('../services/referralService');
const {
  MOTHERS_DAY_2026_SLUG,
  normalizeReferralCampaignInput,
  assertCampaignActive,
} = require('../constants/referralCampaigns');

/**
 * 用户注册
 * @route POST /api/auth/register
 * @access Public
 */
exports.register = async (req, res) => {
  try {
    const {
      email,
      password,
      name,
      isOrganization,
      referralCode: referralCodeRaw,
      referralCampaign,
      campaign,
    } = req.body;

    const referralCodeFromRequest = referralCodeRaw ? String(referralCodeRaw).trim() : null;

    let campaignSlug = null;
    try {
      campaignSlug = normalizeReferralCampaignInput(referralCampaign ?? campaign);
      assertCampaignActive(campaignSlug);
    } catch (e) {
      if (e.code === 'INVALID_CAMPAIGN' || e.code === 'CAMPAIGN_INACTIVE') {
        return res.status(400).json({
          status: 'fail',
          code: e.code,
          message: e.message,
        });
      }
      throw e;
    }

    if (campaignSlug && !referralCodeFromRequest) {
      return res.status(400).json({
        status: 'fail',
        code: 'CAMPAIGN_REQUIRES_REFERRAL_CODE',
        message:
          'This campaign requires signing up through an invite link that includes a referral code.',
      });
    }

    // 检查用户是否已存在
    const userExists = await prisma.user.findUnique({
      where: { email }
    });

    if (userExists) {
      return res.status(400).json({
        status: 'fail',
        message: '该邮箱已被注册'
      });
    }

    // 加密密码
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate a new referral code for the registering user
    const newUsersOwnReferralCode = generateReferralCode();

    let inviterId = null;
    if (referralCodeFromRequest) {
      const inviter = await prisma.user.findUnique({
        where: { referralCode: referralCodeFromRequest },
        select: { id: true }
      });

      if (!inviter) {
        return res.status(400).json({
          status: 'fail',
          message: '无效的推荐码' // Invalid referral code
        });
      }
      inviterId = inviter.id;
    }

    // 创建用户
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        isOrganization: isOrganization || false,
        userType: isOrganization ? 'organization' : 'regular',
        authType: 'traditional',
        referralCode: newUsersOwnReferralCode, // Assign the newly generated code to the user
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

    // If a valid inviter was found, create the referral record and award points
    if (inviterId) {
      await prisma.referral.create({
        data: {
          inviterId: inviterId,
          inviteeId: user.id,
          code: referralCodeFromRequest,
          campaignSlug,
        },
      });

      if (campaignSlug === MOTHERS_DAY_2026_SLUG) {
        await referralService.processCampaignReferral(user.id, inviterId, campaignSlug);
      } else {
        await referralService.processReferral(user.id, inviterId, referralCodeFromRequest);
      }
    }

    // 生成 token
    const token = generateToken(user.id);

    // 移除敏感信息
    const { password: pwd, privateKey, ...userWithoutSensitive } = user;

    res.status(201).json({
      status: 'success',
      data: {
        token,
        user: userWithoutSensitive
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 用户登录
 * @route POST /api/auth/login
 * @access Public
 */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 查找用户
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(401).json({
        status: 'fail',
        message: '邮箱或密码不正确'
      });
    }

    // 检查用户类型 - 只允许组织用户使用传统登录
    if (user.userType === 'regular' && user.authType === 'web3auth' && email !== 'test@example.com') {
      return res.status(403).json({
        status: 'fail',
        message: '请使用 Web3Auth 登录'
      });
    }

    // 验证密码
    if (!user.password) {
      return res.status(401).json({
        status: 'fail',
        message: '邮箱或密码不正确'
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        status: 'fail',
        message: '邮箱或密码不正确'
      });
    }

    // 生成 token
    const token = generateToken(user.id);

    // 移除敏感信息
    const { password: pwd, privateKey, ...userWithoutSensitive } = user;

    res.status(200).json({
      status: 'success',
      data: {
        token,
        user: userWithoutSensitive
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};