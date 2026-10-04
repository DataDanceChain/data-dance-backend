const xService = require('../services/xService');
const xBindFlow = require('../services/xBindFlow');
const { createLogger } = require('../utils/logger');
const prisma = require('../utils/prisma');

const logger = createLogger('xController'); // Corrected logger name


/**
 * Get X post details
 * @route GET /api/x/posts/:postId
 */
exports.getPost = async (req, res) => {
  const { postId } = req.params;
  const ip = req.ip; // For potential rate limiting or logging

  if (!postId || !/^\d+$/.test(postId)) {
    logger.warn('Invalid postId format in getPost', { postId, ip });
    return res.status(400).json({
      status: 'fail',
      message: 'Invalid post ID format'
    });
  }

  const startTime = Date.now();
  logger.info('Fetching post details via xService', { postId, ip });

  try {
    // Call the service layer
    const post = await xService.getPostDetails(postId, ip);
    
    const duration = Date.now() - startTime;
    logger.info('Post details fetched successfully via xService', {
      postId,
      ip,
      duration,
      // _cached was handled by the service, no longer in controller
    });

    return res.json({
      status: 'success',
      data: post
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Error in xController.getPost', {
      postId,
      ip,
      duration,
      error: error.message,
      status: error.status // if the error has a status property
    });

    return res.status(error.status || 500).json({
      status: 'fail',
      message: error.message || 'Error fetching post details',
      ...(error.retryAfter && { retryAfter: error.retryAfter })
    });
  }
};


/**
 * Start binding an X account: a fresh server-side flow for the bearer user.
 * @route GET /api/x/oauth2/authorize-url?platform=web|ios|android
 * @access Private
 *
 * Returns the X authorization URL and a `bindingSecret`. The secret exists only in this response;
 * the Wallet keeps it in the initiating session and presents it to `POST /oauth2/complete`.
 * See ../services/xBindFlow.js for why (decision 46).
 */
exports.oauth2AuthorizeUrl = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const platform = xBindFlow.normalizePlatform(req.query.platform);
  if (!platform) {
    return res.status(400).json({
      status: 'fail',
      code: 'INVALID_PLATFORM',
      message: `platform must be one of ${xBindFlow.PLATFORMS.join(', ')}`
    });
  }
  try {
    const userId = req.user.id;
    const { state, codeChallenge, bindingSecret, expiresIn } = xBindFlow.createFlow({ userId, platform });
    const authUrl = xService.generateAuthUrl(state, codeChallenge, process.env.X_OAUTH_CALLBACK_URL);

    logger.info('Started X binding flow', { userId, platform });

    return res.json({
      status: 'success',
      data: {
        url: authUrl,
        bindingSecret,
        expiresIn
      }
    });
  } catch (error) {
    logger.error('Error in oauth2AuthorizeUrl', { error: error.message });
    return res.status(500).json({
      status: 'error',
      code: 'AUTH_URL_GENERATION_FAILED',
      message: 'Failed to generate authorization URL'
    });
  }
};

function redirectBack(res, platform, params) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.redirect(302, xBindFlow.withParams(xBindFlow.returnUrlFor(platform), params));
}

/**
 * OAuth2 callback from X. Binds NOTHING: it consumes the flow, exchanges the code (PKCE) and
 * parks the X profile as a pending bind, then sends the browser back to the Wallet with its
 * handle. Only the initiating session can turn that into a binding (`oauth2Complete`).
 * @route GET /api/x/oauth2/callback
 * @access Public (X redirects the browser here)
 */
exports.oauth2Callback = async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const xError = typeof req.query.error === 'string' ? req.query.error : '';

  const flow = xBindFlow.consumeFlow(state);
  if (!flow) {
    logger.warn('X callback with an unknown, used or expired state', { hasState: Boolean(state) });
    return redirectBack(res, 'web', { x_status: 'error', code: 'STATE_INVALID' });
  }
  if (xError) {
    logger.info('X authorization not granted', { userId: flow.userId, error: xError.slice(0, 64) });
    return redirectBack(res, flow.platform, { x_status: 'error', code: 'ACCESS_DENIED' });
  }
  if (!code) {
    return redirectBack(res, flow.platform, { x_status: 'error', code: 'CODE_INVALID' });
  }

  let tokenData;
  try {
    tokenData = await xService.exchangeCodeForToken(code, flow.codeVerifier);
  } catch (error) {
    logger.error('X code exchange failed', { userId: flow.userId, error: error.message });
    return redirectBack(res, flow.platform, { x_status: 'error', code: 'TOKEN_EXCHANGE_FAILED' });
  }

  let xUser;
  try {
    xUser = await xService.getOAuth2UserInfo(tokenData.access_token);
  } catch (error) {
    logger.error('X user lookup failed', { userId: flow.userId, error: error.message });
    return redirectBack(res, flow.platform, { x_status: 'error', code: 'USER_INFO_FETCH_FAILED' });
  }
  if (!xUser || typeof xUser.id !== 'string' || !/^\d{1,32}$/.test(xUser.id)) {
    logger.error('X user lookup returned no usable id', { userId: flow.userId });
    return redirectBack(res, flow.platform, { x_status: 'error', code: 'USER_INFO_FETCH_FAILED' });
  }

  const handle = xBindFlow.createPendingBind({
    flow,
    xUser,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token
  });
  return redirectBack(res, flow.platform, { x_status: 'confirm', x_bind: handle });
};

/**
 * Confirm a pending X binding from the session that started it.
 * @route POST /api/x/oauth2/complete  body { handle, bindingSecret }
 * @access Private
 *
 * The handle is consumed first, whatever happens next. The binding is written only when the
 * bearer user is the flow's initiator and the binding secret matches; otherwise nothing is
 * written and the handle is gone.
 */
exports.oauth2Complete = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { handle, bindingSecret } = req.body || {};
  const userId = req.user.id;
  const result = xBindFlow.consumePendingBind({ handle, userId, bindingSecret });

  if (!result.ok && result.reason === 'invalid') {
    return res.status(400).json({
      status: 'fail',
      code: 'STATE_INVALID',
      message: 'This X authorization is invalid or has expired. Please start again.'
    });
  }
  if (!result.ok) {
    logger.warn('X binding refused: not the initiating session', {
      userId,
      initiatorUserId: result.initiatorUserId
    });
    return res.status(403).json({
      status: 'fail',
      code: 'X_BIND_NOT_INITIATOR',
      message: 'This X authorization was not started from this session.'
    });
  }

  const { xUser, accessToken, refreshToken } = result.bind;
  try {
    const holder = await prisma.user.findUnique({ where: { xid: xUser.id }, select: { id: true } });
    if (holder && holder.id !== userId) {
      logger.warn('X account already bound to another user', { userId });
      return res.status(409).json({
        status: 'fail',
        code: 'X_ACCOUNT_ALREADY_BOUND',
        message: 'This X account is already bound to another DataDance account.'
      });
    }
    await prisma.user.update({
      where: { id: userId },
      data: {
        xid: xUser.id,
        xUsername: xUser.username,
        xAccessToken: accessToken,
        xRefreshToken: refreshToken
      }
    });
    logger.info('X account bound', { userId });
    return res.json({
      status: 'success',
      data: { bound: true, xid: xUser.id, xUsername: xUser.username }
    });
  } catch (error) {
    if (error && error.code === 'P2002') {
      return res.status(409).json({
        status: 'fail',
        code: 'X_ACCOUNT_ALREADY_BOUND',
        message: 'This X account is already bound to another DataDance account.'
      });
    }
    logger.error('Error in oauth2Complete', { userId, error: error.message });
    return res.status(500).json({
      status: 'error',
      code: 'DATABASE_UPDATE_FAILED',
      message: 'Failed to save the X binding'
    });
  }
};

/**
 * Get current user's X binding status
 * @route GET /api/x/status
 * @access Private
 */
exports.getXStatus = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }, select: { xid: true, xUsername: true }
    });
    return res.status(200).json({
      status: 'success',
      data: { bound: Boolean(user.xid), xid: user.xid, xUsername: user.xUsername }
    });
  } catch (error) {
    logger.error('Error in getXStatus', { error: error.message });
    return res.status(500).json({ status: 'error', message: '获取状态失败' });
  }
};
//   const startTime = Date.now();
//   try {
//     const userId = req.user.id;
//     const ip = req.ip;

//     logger.info('Attempting to unlink X account', { userId, ip });

//     const user = await prisma.user.findUnique({
//       where: { id: userId }
//     });

//     if (!user) {
//       logger.warn('User not found in unlinkXAccount', { userId, ip });
//       return res.status(404).json({
//         status: 'fail',
//         code: 'USER_NOT_FOUND',
//         message: 'User not found'
//       });
//     }

//     if (!user.xid) {
//       logger.warn('User has no linked X account', { userId, ip });
//       return res.status(400).json({
//         status: 'fail',
//         code: 'X_NOT_LINKED',
//         message: '当前账号未绑定 X 账号'
//       });
//     }

//     const updatedUser = await prisma.user.update({
//       where: { id: userId },
//       data: {
//         xid: null,
//         xUsername: null,
//         xAccessToken: null,
//         xRefreshToken: null
//       }
//     });

//     // 移除敏感信息
//     const { password, privateKey, xAccessToken, xRefreshToken, ...safeUser } = updatedUser;

//     const duration = Date.now() - startTime;
//     logger.info('Successfully unlinked X account', { userId, ip, duration });

//     return res.status(200).json({
//       status: 'success',
//       message: 'X 账号解绑成功',
//       data: {
//         user: safeUser
//       }
//     });
//   } catch (error) {
//     logger.error('Error in unlinkXAccount', {
//       userId: req.user?.id,
//       ip: req.ip,
//       error: error.message,
//       duration: Date.now() - startTime
//     });
//     return res.status(500).json({
//       status: 'error',
//       code: 'SERVER_ERROR',
//       message: '服务器错误'
//     });
//   }
// };