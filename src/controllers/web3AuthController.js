const prisma = require('../utils/prisma');
const { generateToken } = require('../utils/jwtUtils');
const { createLogger } = require('../utils/logger');
const referralService = require('../services/referralService');
const { generateUniqueReferralCode, validateReferralCode } = require('../utils/referralUtils');
const {
  MOTHERS_DAY_2026_SLUG,
  SUMMER_TRAVEL_2026_SLUG,
  normalizeReferralCampaignInput,
} = require('../constants/referralCampaigns');
const { assertReferralCampaignUsable } = require('../utils/stayBonus');
const {
  verifyIdToken,
  extractIdentity,
  assertWalletBound,
  resolveUser,
  getVerifyMode,
  getAllowLegacyFallback,
  Web3AuthIdentityError,
} = require('../services/web3authIdentity');

const logger = createLogger('web3AuthController');

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

/** Thrown by helpers to short-circuit the request with an HTTP reply (legacy status codes and bodies). */
class HttpReply extends Error {
  constructor(status, body) {
    super(body && body.message ? body.message : 'http reply');
    this.name = 'HttpReply';
    this.status = status;
    this.body = body;
  }
}
const reply = (status, body) => new HttpReply(status, body);

function sanitizeUser(user) {
  const { password, privateKey, ...safeUser } = user;
  return safeUser;
}

async function resolveCampaign(req) {
  let campaignSlug = null;
  try {
    campaignSlug = normalizeReferralCampaignInput(req.body.referralCampaign ?? req.body.campaign);
    await assertReferralCampaignUsable(campaignSlug);
  } catch (e) {
    if (e.code === 'INVALID_CAMPAIGN' || e.code === 'CAMPAIGN_INACTIVE') {
      throw reply(400, { status: 'fail', code: e.code, message: e.message });
    }
    throw e;
  }
  return campaignSlug;
}

function referralFailure(referralData) {
  const statusCode = referralData.errorCode === 'INVALID_CODE' ? 404 : 400;
  return reply(statusCode, {
    status: 'fail',
    code: referralData.errorCode || 'INVALID_REFERRAL_CODE',
    message: referralData.error || 'Invalid or expired referral code',
    ...(referralData.data && { data: referralData.data }),
  });
}

async function assertInviterEligible(referrerId, campaignSlug) {
  if (campaignSlug !== SUMMER_TRAVEL_2026_SLUG) return;
  try {
    await referralService.assertSummerTravelInviterEligible(referrerId);
  } catch (e) {
    if (e.code === 'CAMPAIGN_INVITER_LOCKED') {
      throw reply(403, { status: 'fail', code: e.code, message: e.message });
    }
    throw e;
  }
}

// Referral row + rewards cannot run in one interactive tx: processCampaignReferral
// opens its own transaction and UPDATEs the invitee row, which deadlocks with the
// uncommitted outer transaction that created the same user + referral.
async function settleReferral(userId, referrerId, campaignSlug, referralCode) {
  if (campaignSlug === MOTHERS_DAY_2026_SLUG) {
    await referralService.processCampaignReferral(userId, referrerId, campaignSlug);
  } else if (campaignSlug === SUMMER_TRAVEL_2026_SLUG) {
    // Relation only — settle after invitee's first valid summer stay upload.
  } else {
    await referralService.processReferral(userId, referrerId, referralCode);
  }
}

/** Existing-user referral handling; returns invitationStatus or null. Behaviour unchanged. */
async function applyReferralToExistingUser(user, referralCode, campaignSlug) {
  if (!referralCode) return null;

  // 检查用户是否已经被邀请过
  const existingReferral = await prisma.referral.findUnique({
    where: { inviteeId: user.id },
    include: { inviter: { select: { id: true, name: true } } },
  });
  if (existingReferral) {
    throw reply(400, {
      status: 'fail',
      code: 'ALREADY_REFERRED',
      message: 'User has already been referred',
      data: {
        inviterId: existingReferral.inviterId,
        inviterName: existingReferral.inviter?.name,
        code: existingReferral.code,
        createdAt: existingReferral.createdAt,
      },
    });
  }

  try {
    const referralData = await validateReferralCode(referralCode, user.id);
    if (!referralData.valid) throw referralFailure(referralData);
    const referrerId = referralData.referrerId;
    await assertInviterEligible(referrerId, campaignSlug);

    await prisma.referral.create({
      data: { inviterId: referrerId, inviteeId: user.id, code: referralCode, campaignSlug },
    });
    await settleReferral(user.id, referrerId, campaignSlug, referralCode);

    return { success: true, code: 'REFERRAL_SUCCESSFUL', message: 'Successfully used referral code' };
  } catch (error) {
    if (error instanceof HttpReply) throw error;
    logger.error('Referral code validation error for existing user', {
      userId: user.id,
      error: error.message,
    });
    throw reply(500, {
      status: 'error',
      code: 'REFERRAL_VALIDATION_ERROR',
      message: 'Failed to validate referral code',
    });
  }
}

/** New-user referral validation; returns referrerId or null. Behaviour unchanged. */
async function validateReferralForNewUser(referralCode, campaignSlug, tempUserId) {
  if (!referralCode) return null;
  try {
    const referralData = await validateReferralCode(referralCode, tempUserId);
    if (!referralData.valid) throw referralFailure(referralData);
    const referrerId = referralData.referrerId;
    await assertInviterEligible(referrerId, campaignSlug);
    return referrerId;
  } catch (error) {
    if (error instanceof HttpReply) throw error;
    logger.error('Referral code validation error', { error: error.message });
    throw reply(500, {
      status: 'error',
      code: 'REFERRAL_VALIDATION_ERROR',
      message: 'Failed to validate referral code',
    });
  }
}

/** X user id from the verified token: verifierId `twitter|<id>` → `<id>` (mirrors the Wallet). */
function xidFromIdentity(identity) {
  const raw = identity.verifierId || '';
  if (!/^twitter\|/i.test(raw)) return null;
  return raw.split('|')[1] || null;
}

function sendLogin(res, httpStatus, token, user, invitationStatus) {
  return res.status(httpStatus).json({
    status: 'success',
    data: {
      token,
      user: sanitizeUser(user),
      ...(invitationStatus && { invitationStatus }),
    },
  });
}

/**
 * Verified path: identity comes only from the Web3Auth ID token; the user is resolved by
 * the upstream identity pair. Referral / points side-effects are identical to the legacy path.
 */
async function verifiedLogin(req, res, { mode, referralCode, campaignSlug }) {
  const { idToken, walletAddress, xUsername, xAccessToken, xRefreshToken } = req.body;

  if (walletAddress && !WALLET_RE.test(walletAddress)) {
    throw reply(400, {
      status: 'fail',
      code: 'INVALID_WALLET_FORMAT',
      message: 'Invalid wallet address format',
    });
  }

  const { kind, payload } = await verifyIdToken(idToken);
  const identity = extractIdentity(payload, { kind });
  const boundAddress = assertWalletBound(identity, walletAddress);
  const derivedXid = xidFromIdentity(identity);

  let referrerId = null;
  const { user: resolved, action } = await resolveUser(identity, {
    walletAddress: boundAddress,
    prepareCreate: async () => {
      // New registration: validate the referral code before the row exists (as today, keyed by e-mail).
      referrerId = await validateReferralForNewUser(
        referralCode,
        campaignSlug,
        identity.email || identity.verifierId
      );
      const ownReferralCode = await generateUniqueReferralCode();
      return {
        referralCode: ownReferralCode,
        ...(derivedXid && { xid: derivedXid }),
        ...(xUsername && { xUsername }),
        ...(xAccessToken && { xAccessToken }),
        ...(xRefreshToken && { xRefreshToken }),
      };
    },
    afterCreate: async (tx, newUser) => {
      if (referrerId) {
        await tx.referral.create({
          data: { inviterId: referrerId, inviteeId: newUser.id, code: referralCode, campaignSlug },
        });
      }
    },
  });

  if (action === 'created') {
    if (referrerId) await settleReferral(resolved.id, referrerId, campaignSlug, referralCode);
    const token = generateToken(resolved.id, { ver: 2 });
    logger.info('web3auth_login', {
      userId: resolved.id,
      action,
      verifier: identity.verifier,
      kind: identity.kind,
      mode,
      hasReferralCode: Boolean(referralCode),
      campaignSlug,
    });
    return sendLogin(
      res,
      201,
      token,
      resolved,
      referrerId && {
        success: true,
        code: 'REFERRAL_SUCCESSFUL',
        message: 'Successfully registered with referral code',
      }
    );
  }

  // Existing user (hit by pair, or legacy row just backfilled)
  const invitationStatus = await applyReferralToExistingUser(resolved, referralCode, campaignSlug);

  const updateData = {
    // Display data only from the verified token, and only when empty
    ...(identity.name && !resolved.name && { name: identity.name }),
    ...(identity.profileImage && !resolved.avatar && { avatar: identity.profileImage }),
    ...(derivedXid && !resolved.xid && { xid: derivedXid }),
    ...(xUsername && !resolved.xUsername && { xUsername }),
    ...(xAccessToken && !resolved.xAccessToken && { xAccessToken }),
    ...(xRefreshToken && !resolved.xRefreshToken && { xRefreshToken }),
  };

  // First wallet binding: only an address the token proves
  if (boundAddress && !resolved.walletAddress) {
    const existingWallet = await prisma.user.findFirst({
      where: { walletAddress: boundAddress, id: { not: resolved.id } },
    });
    if (existingWallet) {
      throw reply(400, {
        status: 'fail',
        code: 'WALLET_IN_USE',
        message: 'Wallet address already in use',
      });
    }
    updateData.walletAddress = boundAddress;
  }

  const user = Object.keys(updateData).length
    ? await prisma.user.update({ where: { id: resolved.id }, data: updateData })
    : resolved;

  const token = generateToken(user.id, { ver: 2 });
  logger.info('web3auth_login', {
    userId: user.id,
    action,
    verifier: identity.verifier,
    kind: identity.kind,
    mode,
    authType: user.authType,
    hasReferralCode: Boolean(referralCode),
    campaignSlug,
  });
  return sendLogin(res, 200, token, user, invitationStatus);
}

/**
 * Legacy path (no ID token): today's client-asserted lookup — the body alone names the account.
 * Reachable only from `off` (dev only, refused at boot in production) and from `log` with
 * WEB3AUTH_ALLOW_LEGACY_FALLBACK=true and NO idToken supplied. Sessions minted here carry no
 * `ver` claim. A token that was supplied and rejected never arrives here.
 */
async function legacyLogin(req, res, { mode, referralCode, campaignSlug }) {
  const { userInfo, walletAddress, xid, xUsername, xAccessToken, xRefreshToken } = req.body;

  // 1. 基础验证
  if (walletAddress && !WALLET_RE.test(walletAddress)) {
    throw reply(400, {
      status: 'fail',
      code: 'INVALID_WALLET_FORMAT',
      message: 'Invalid wallet address format',
    });
  }

  if (!userInfo?.email && !walletAddress && !xid) {
    throw reply(400, {
      status: 'fail',
      code: 'MISSING_CREDENTIALS',
      message: 'Email, wallet address, or X ID is required',
    });
  }

  // 2. 查找用户 - 优先通过邮箱查找，因为这是最可靠的标识符
  let user = null;
  if (userInfo?.email) {
    user = await prisma.user.findUnique({ where: { email: userInfo.email } });
  } else if (xid) {
    user = await prisma.user.findUnique({ where: { xid } });
  } else if (walletAddress) {
    user = await prisma.user.findFirst({ where: { walletAddress } });
  }

  // 3. 处理现有用户登录
  if (user) {
    if (user.disabledAt) {
      throw reply(403, {
        status: 'fail',
        code: 'ACCOUNT_DISABLED',
        message: 'This account has been disabled',
      });
    }

    // 检查用户类型
    if (user.userType === 'organization' || user.isOrganization) {
      throw reply(403, {
        status: 'fail',
        code: 'UNAUTHORIZED_USER_TYPE',
        message: 'Organization accounts cannot use Web3Auth',
      });
    }

    // 处理现有用户的邀请码逻辑
    const invitationStatus = await applyReferralToExistingUser(user, referralCode, campaignSlug);

    // 更新用户信息，包括新的社交账号信息（不再覆盖 authType：密码账号保持 traditional）
    const updateData = {
      // 只有在用户信息为空时才更新
      ...(userInfo?.name && !user.name && { name: userInfo.name }),
      ...(userInfo?.profileImage && !user.avatar && { avatar: userInfo.profileImage }),
      // 如果还没有 X 账号信息，则添加
      ...(xid && !user.xid && { xid }),
      ...(xUsername && !user.xUsername && { xUsername }),
      ...(xAccessToken && !user.xAccessToken && { xAccessToken }),
      ...(xRefreshToken && !user.xRefreshToken && { xRefreshToken }),
    };

    // 如果是首次绑定钱包
    if (walletAddress && !user.walletAddress) {
      const existingWallet = await prisma.user.findFirst({
        where: { walletAddress, id: { not: user.id } },
      });
      if (existingWallet) {
        throw reply(400, {
          status: 'fail',
          code: 'WALLET_IN_USE',
          message: 'Wallet address already in use',
        });
      }
      updateData.walletAddress = walletAddress;
    }

    // 更新用户信息
    user = await prisma.user.update({ where: { id: user.id }, data: updateData });

    const token = generateToken(user.id);
    logger.info('web3auth_login', {
      userId: user.id,
      action: 'legacy_login',
      mode,
      authType: user.authType,
      hasReferralCode: Boolean(referralCode),
      campaignSlug,
    });
    return sendLogin(res, 200, token, user, invitationStatus);
  }

  // 4. 处理新用户注册
  if (!userInfo?.email || !walletAddress) {
    throw reply(400, {
      status: 'fail',
      code: 'INCOMPLETE_INFO',
      message: 'Email and wallet address are required for new user registration',
    });
  }

  // 验证邀请码 (new user: the e-mail is the temporary identifier for validation)
  const referrerId = await validateReferralForNewUser(referralCode, campaignSlug, userInfo.email);

  // Create user + referral in one tx; campaign rewards run after commit (see existing-user path).
  const ownReferralCode = await generateUniqueReferralCode();
  const result = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: userInfo.email,
        name: userInfo.name || userInfo.email.split('@')[0],
        avatar: userInfo.profileImage,
        walletAddress,
        authType: 'web3auth',
        userType: 'regular',
        referralCode: ownReferralCode,
        ...(xid && { xid }),
        ...(xUsername && { xUsername }),
        ...(xAccessToken && { xAccessToken }),
        ...(xRefreshToken && { xRefreshToken }),
        profile: { create: { language: 'en' } },
      },
    });

    if (referrerId) {
      await tx.referral.create({
        data: { inviterId: referrerId, inviteeId: newUser.id, code: referralCode, campaignSlug },
      });
    }

    return newUser;
  });

  if (referrerId) await settleReferral(result.id, referrerId, campaignSlug, referralCode);

  const token = generateToken(result.id);
  logger.info('web3auth_login', {
    userId: result.id,
    action: 'legacy_created',
    mode,
    hasReferralCode: Boolean(referralCode),
    campaignSlug,
  });
  return sendLogin(
    res,
    201,
    token,
    result,
    referrerId && {
      success: true,
      code: 'REFERRAL_SUCCESSFUL',
      message: 'Successfully registered with referral code',
    }
  );
}

/**
 * POST /api/auth/web3auth-login
 * Public endpoint for Web3Auth login or registration.
 *
 * WEB3AUTH_VERIFY_MODE:
 *   enforce — `idToken` required; identity only from the verified token.
 *   log     — verified path when `idToken` is present. A supplied token that is REJECTED fails
 *             closed exactly as under `enforce`: the detector exists to replace the legacy path,
 *             so it never hands a refused request to it. A request with NO `idToken` is refused
 *             too (`IDTOKEN_REQUIRED`) unless WEB3AUTH_ALLOW_LEGACY_FALLBACK=true, the explicit
 *             rollout flag that is the only way a body-asserted identity still mints a session.
 *   off     — legacy path only (dev; refused at boot in production).
 * For new registrations, validates referral code and records referral relation.
 */
exports.web3authLogin = async (req, res) => {
  const mode = getVerifyMode();
  try {
    const referralCodeRaw = req.body.referralCode;
    const referralCode = referralCodeRaw ? String(referralCodeRaw).trim() : null;
    const idToken = typeof req.body.idToken === 'string' ? req.body.idToken.trim() : '';
    const campaignSlug = await resolveCampaign(req);

    if (campaignSlug && !referralCode) {
      return res.status(400).json({
        status: 'fail',
        code: 'CAMPAIGN_REQUIRES_REFERRAL_CODE',
        message:
          'This campaign requires signing up through an invite link that includes a referral code.',
      });
    }

    const ctx = { mode, referralCode, campaignSlug };

    if (mode !== 'off') {
      if (idToken) {
        // A token was supplied: it decides, in every mode. Rejected is REFUSED — never
        // downgraded to the client-asserted path the verification exists to replace.
        try {
          return await verifiedLogin(req, res, ctx);
        } catch (error) {
          if (!(error instanceof Web3AuthIdentityError)) throw error;
          logger.warn('idtoken_rejected', {
            code: error.code,
            reason: error.details && error.details.reason,
            mode,
            outcome: 'refused',
          });
          return res.status(error.httpStatus).json({
            status: 'fail',
            code: error.code,
            message: error.message,
          });
        }
      }

      // No token at all. `enforce` never accepts that; `log` only while the rollout flag is on.
      if (mode === 'enforce' || !getAllowLegacyFallback()) {
        logger.warn('idtoken_rejected', {
          code: 'IDTOKEN_REQUIRED',
          reason: 'no_id_token',
          mode,
          outcome: 'refused',
        });
        return res.status(400).json({
          status: 'fail',
          code: 'IDTOKEN_REQUIRED',
          message: 'A Web3Auth ID token is required to log in',
        });
      }
    }

    // Body-asserted identity. Logged on every request so the rollout can be measured and the
    // flag turned off once the count is zero.
    logger.warn('legacy_login', {
      mode,
      reason: mode === 'off' ? 'verify_mode_off' : 'legacy_fallback_allowed',
      hasEmail: Boolean(req.body.userInfo?.email),
      hasWallet: Boolean(req.body.walletAddress),
      hasXid: Boolean(req.body.xid),
      hasReferralCode: Boolean(referralCode),
      campaignSlug,
    });
    return await legacyLogin(req, res, ctx);
  } catch (error) {
    if (error instanceof HttpReply) {
      return res.status(error.status).json(error.body);
    }

    logger.error('Web3Auth login error', { error: error.message, mode });

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
  // Declared outside the try: the catch logs it, and a `const` inside the try is out of scope
  // there — the error handler itself used to throw a ReferenceError.
  const userId = req.user && req.user.id;
  try {
    const { walletAddress } = req.body;

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