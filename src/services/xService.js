const xClient = require('../utils/xClient');
const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const logger = createLogger('xService');
const crypto = require('crypto');
const axios = require('axios');
const querystring = require('querystring');
// In-memory store for PKCE/verifier and user mapping
const pkceStore = new Map();

function base64URLEncode(str) {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Fetches details for a specific X post.
 * @param {string} postId The ID of the X post.
 * @param {string} ip The IP address of the requester (for rate limiting).
 * @returns {Promise<object>} The post details.
 */
async function getPostDetails(postId, ip) {
  // xClient already handles caching and rate limiting internally
  try {
    const post = await xClient.getPostDetails(postId, ip);
    // Remove internal caching field before returning
    const { _cached, ...restOfPost } = post;
    return restOfPost;
  } catch (error) {
    logger.error('Error in xService.getPostDetails', { postId, error: error.message, status: error.status });
    throw error; // Re-throw to be handled by controller
  }
}

/**
 * Generate PKCE code_verifier and S256 code_challenge, store for user
 * @param {string} userId
 * @returns {{ state: string, codeVerifier: string, codeChallenge: string }}
 */
function generatePKCE(userId) {
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = base64URLEncode(crypto.randomBytes(32));
  const codeChallenge = base64URLEncode(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  pkceStore.set(state, { userId, codeVerifier });
  return { state, codeVerifier, codeChallenge };
}

/**
 * Retrieve and delete PKCE data for given state
 * @param {string} state
 * @returns {{ userId: string, codeVerifier: string }|null}
 */
function getPKCE(state) {
  const data = pkceStore.get(state);
  pkceStore.delete(state);
  return data || null;
}

/**
 * Exchange OAuth2 code for access and refresh tokens
 * @param {string} code
 * @param {string} codeVerifier
 * @param {string} [redirectUri] the redirect_uri of the authorization request. Defaults to
 *   X_OAUTH_CALLBACK_URL (the existing "bind X account" flow, unchanged); native login passes
 *   DDC_AUTH_X_CALLBACK_URL.
 * @param {{timeout?: number, apiBase?: string}} [options] request timeout (ms; none by default) and
 *   API base (X_API_URL by default)
 */
async function exchangeCodeForToken(code, codeVerifier, redirectUri = process.env.X_OAUTH_CALLBACK_URL, options = {}) {
  const { timeout, apiBase } = options || {};
  const tokenUrl = `${apiBase || process.env.X_API_URL}/oauth2/token`;
  const authHeader = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');
  const payload = querystring.stringify({
    grant_type: 'authorization_code',
    client_id: process.env.X_CLIENT_ID,
    client_secret: process.env.X_CLIENT_SECRET,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier
  });

  logger.info('Exchanging code for token', {
    tokenUrl,
    redirectUri,
    hasCode: Boolean(code),
    hasCodeVerifier: Boolean(codeVerifier)
  });

  try {
  const resp = await axios.post(tokenUrl, payload, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${authHeader}`
    },
    ...(timeout ? { timeout } : {})
  });
    logger.info('Successfully exchanged code for token');
    return resp.data;
  } catch (error) {
    logger.error('Failed to exchange code for token', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      code: error.code
    });
    throw error;
  }
}

/**
 * Fetch X user info using OAuth2 access token (GET /2/users/me, scope users.read)
 * @param {string} accessToken
 * @param {{timeout?: number, apiBase?: string, userFields?: string}} [options] request timeout
 *   (ms; none by default), API base (X_API_URL by default) and the `user.fields` to request
 */
async function getOAuth2UserInfo(accessToken, options = {}) {
  const { timeout, apiBase, userFields } = options || {};
  const url = `${apiBase || process.env.X_API_URL}/users/me`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    ...(userFields ? { params: { 'user.fields': userFields } } : {}),
    ...(timeout ? { timeout } : {})
  });
  return resp.data.data; // { id, name, username }
}

/**
 * Verifies if a user has retweeted or quoted a specific X post.
 * @param {string} userId The platform user ID.
 * @param {string} targetPostId The ID of the X post to check.
 * @returns {Promise<boolean>} True if verified, false otherwise.
 * @throws {Error} If X account is not bound or target post ID is missing.
 */
async function verifyUserEngagement(userId, targetPostId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { xid: true } });
  if (!user?.xid) {
    logger.warn('X account not bound for verification', { userId });
    throw new Error("X account not bound");
  }
  if (!targetPostId) {
    logger.error('Target post ID missing for verification', { userId, xid: user.xid });
    throw new Error("Target post ID not defined");
  }

  logger.info('Verifying X engagement', { userId, xid: user.xid, targetPostId });

  // 1. Check for retweets
  try {
    const retweets = await xClient.postRetweetedBy(targetPostId);
    if (Array.isArray(retweets?.data) && retweets.data.some(u => u.id === user.xid)) {
      logger.info('Retweet verified', { userId, xid: user.xid, targetPostId });
      return true;
    }
  } catch (error) {
    logger.error('Error checking retweets via xClient', { userId, xid: user.xid, targetPostId, error: error.message });
    // Do not re-throw yet, proceed to check quotes
  }

  // 2. If not retweeted, check for quotes
  try {
    const quoteSearch = await xClient.search(
      `from:${user.xid} is:quote`,
      { 'tweet.fields': 'referenced_tweets' }
    );
    if (Array.isArray(quoteSearch?.data) && quoteSearch.data.some(tweet =>
      tweet.referenced_tweets?.some(ref => ref.type === 'quoted' && ref.id === targetPostId)
    )) {
      logger.info('Quote verified', { userId, xid: user.xid, targetPostId });
      return true;
    }
  } catch (error) {
    logger.error('Error checking quotes via xClient', { userId, xid: user.xid, targetPostId, error: error.message });
    // Do not re-throw, let it fall through to return false if both checks fail
  }

  logger.warn('X engagement not verified (no retweet or quote found)', { userId, xid: user.xid, targetPostId });
  return false;
}

/**
 * Generate X OAuth2 authorization URL
 * @param {string} state - PKCE state parameter
 * @param {string} codeChallenge - PKCE code challenge
 * @param {string} redirectUri - OAuth callback URL
 * @returns {string} The complete authorization URL
 */
function generateAuthUrl(state, codeChallenge, redirectUri) {
  const authUrl = new URL(`${process.env.X_API_URL}/oauth2/authorize`);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', process.env.X_CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('scope', 'tweet.read users.read offline.access');
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');
  return authUrl.toString();
}

/**
 * Native login (design §3.5): X's documented OAuth 2.0 authorization endpoint. The existing
 * binding flow keeps generateAuthUrl (X_API_URL-based) unchanged.
 */
const X_LOGIN_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
/** Native login's API base when X_API_URL is unset (token endpoint and /users/me live under it). */
const X_DEFAULT_API_URL = 'https://api.x.com/2';
/** Native login asks only to read the profile: no offline.access, so X issues no refresh token. */
const X_LOGIN_SCOPE = 'tweet.read users.read';

function loginApiBase() {
  return String(process.env.X_API_URL || '').trim().replace(/\/+$/, '') || X_DEFAULT_API_URL;
}

/**
 * Authorization URL for native X login (confidential client, PKCE S256). The redirect URI is our
 * API callback (DDC_AUTH_X_CALLBACK_URL); a custom scheme is never sent to X (F6).
 */
function buildLoginAuthorizeUrl({ clientId = process.env.X_CLIENT_ID, redirectUri, state, codeChallenge, scope = X_LOGIN_SCOPE }) {
  const authUrl = new URL(X_LOGIN_AUTHORIZE_URL);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', clientId);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('scope', scope);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');
  return authUrl.toString();
}

module.exports = {
  getPostDetails,
  verifyUserEngagement,
  generatePKCE,
  getPKCE,
  generateAuthUrl,
  // Exchange OAuth2 code for tokens
  exchangeCodeForToken,
  // Fetch authenticated user info via OAuth2 token
  getOAuth2UserInfo,
  // Native login (src/services/nativeAuth/idpX.js)
  X_LOGIN_AUTHORIZE_URL,
  X_DEFAULT_API_URL,
  X_LOGIN_SCOPE,
  loginApiBase,
  buildLoginAuthorizeUrl
};
