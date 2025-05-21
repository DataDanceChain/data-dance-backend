const xService = require('../services/xService');
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
 * Get X OAuth2 authorization URL
 * @route GET /api/x/oauth2/authorize-url
 * @access Private
 */
exports.oauth2AuthorizeUrl = async (req, res) => {
  try {
    const userId = req.user.id;
    const { state, codeVerifier, codeChallenge } = xService.generatePKCE(userId);
    const authUrl = xService.generateAuthUrl(state, codeChallenge, process.env.X_OAUTH_CALLBACK_URL);
    
    logger.info('Generated X auth URL', {
      userId,
      state,
      callbackUrl: process.env.X_OAUTH_CALLBACK_URL
    });
    
    return res.json({
      status: 'success',
      data: {
        url: authUrl
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

/**
 * OAuth2 authorization redirect to X (legacy endpoint)
 * @route GET /api/x/oauth2/authorize
 * @access Private
 */
exports.oauth2Authorize = async (req, res) => {
  try {
    const userId = req.user.id;
    const { state, codeVerifier, codeChallenge } = xService.generatePKCE(userId);
    const authUrl = xService.generateAuthUrl(state, codeChallenge, process.env.X_OAUTH_CALLBACK_URL);
    
    logger.info('Redirecting to X auth URL', {
      userId,
      state,
      callbackUrl: process.env.X_OAUTH_CALLBACK_URL
    });
    
    return res.redirect(authUrl);
  } catch (error) {
    logger.error('Error in oauth2Authorize', { error: error.message });
    return res.status(500).json({ status: 'error', message: '授权失败' });
  }
};

/**
 * OAuth2 callback from X
 * @route GET /api/x/oauth2/callback
 * @access Private (via session or JWT cookie)
 */
exports.oauth2Callback = async (req, res) => {
  const { code, state } = req.query;
  const pkce = xService.getPKCE(state);
  if (!pkce) {
    return res.status(400).json({ status: 'fail', message: 'Invalid state' });
  }
  try {
    const tokenData = await xService.exchangeCodeForToken(code, pkce.codeVerifier);
    const { access_token, refresh_token } = tokenData;
    const xUser = await xService.getOAuth2UserInfo(access_token);
    await prisma.user.update({
      where: { id: pkce.userId },
      data: {
        xid: xUser.id,
        xUsername: xUser.username,
        xAccessToken: access_token,
        xRefreshToken: refresh_token
      }
    });
    const appCallback = process.env.X_OAUTH_CALLBACK_URL;
    return res.redirect(`${appCallback}?status=success`);
  } catch (error) {
    logger.error('Error in oauth2Callback', { error: error.message });
    const appCallback = process.env.X_OAUTH_CALLBACK_URL;
    return res.redirect(`${appCallback}?status=error`);
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