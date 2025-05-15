const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const { createLogger } = require('./logger');
const prisma = require('./prisma');
const logger = createLogger('xClient');

// In-memory cache
const cache = new Map();
const CACHE_TTL = 300000; // 5 minutes in milliseconds

// Persistent cache TTL (5 minutes in milliseconds)
const PERSIST_TTL = 300000;

// Rate limiter configuration using memory
const rateLimiter = new RateLimiterMemory({
  points: 60, // Number of requests
  duration: 60, // Per minute
});

// X API client configuration (use OAuth2.0 Bearer Token)
const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
if (!BEARER_TOKEN) {
  logger.error('Missing X_BEARER_TOKEN in environment');
}
const xApiClient = axios.create({
  baseURL: 'https://api.twitter.com/2',
  timeout: 3000, // 3 seconds timeout
  headers: {
    'Authorization': `Bearer ${BEARER_TOKEN}`,
    'Accept': 'application/json'
  }
});

// Helper function to check rate limit
async function checkRateLimit(ip) {
  try {
    await rateLimiter.consume(ip);
    return true;
  } catch (error) {
    if (error.remainingPoints !== undefined) {
      throw { status: 429, message: 'Too many requests', retryAfter: error.msBeforeNext / 1000 };
    }
    throw error;
  }
}

// Helper function to get cached post
function getCachedPost(postId) {
  const cached = cache.get(postId);
  if (!cached) return null;
  
  // Check if cache is expired
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    cache.delete(postId);
    return null;
  }
  
  return cached.data;
}

// Helper function to cache post
function cachePost(postId, data) {
  cache.set(postId, {
    data,
    timestamp: Date.now()
  });
}

// Helper function to clear cache
function clearCache(postId) {
  cache.delete(postId);
}

// Extend cache usage for retweets and quote searches
// Composite cache keys: `retweets:${postId}`, `quotes:${query}`
// Reuse existing cache Map and TTL

const getCached = (key) => {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  if (entry) cache.delete(key);
  return null;
};

const setCached = (key, data) => {
  cache.set(key, { data, timestamp: Date.now() });
};

// Fetch cached data for a given key from DB if not expired
async function getCachedRecord(key) {
  const record = await prisma.xPostCache.findUnique({ where: { key } });
  if (record && Date.now() - new Date(record.updatedAt).getTime() < PERSIST_TTL) {
    logger.info('Using DB cached record', { key });
    return record.data;
  }
  return null;
}

// Upsert cache record in DB
async function setCachedRecord(key, data) {
  await prisma.xPostCache.upsert({
    where: { key },
    update: { data },
    create: { key, data }
  });
}

// Main function to get post details
async function getPostDetails(postId, ip) {
  // Check rate limit
  await checkRateLimit(ip);

  // Try to get from cache first
  const cached = getCachedPost(postId);
  if (cached) {
    return { ...cached, _cached: true };
  }

  try {
    // Fetch from X API
    const response = await xApiClient.get(`/tweets/${postId}`, {
      params: {
        'tweet.fields': 'created_at,public_metrics',
        'user.fields': 'name,username,profile_image_url',
        'media.fields': 'type,url,preview_image_url',
        'expansions': 'author_id,attachments.media_keys'
      }
    });

    const data = response.data;
    
    // Transform the response to a more frontend-friendly format
    const transformed = {
      id: data.data.id,
      text: data.data.text,
      createdAt: data.data.created_at,
      metrics: data.data.public_metrics,
      author: data.includes.users[0],
      media: data.includes.media || []
    };

    // Cache the transformed data
    cachePost(postId, transformed);

    return transformed;
  } catch (error) {
    // Handle different error cases
    if (error.response) {
      switch (error.response.status) {
        case 404:
          throw { status: 404, message: 'Tweet not found' };
        case 429:
          throw { 
            status: 429, 
            message: 'Too many requests to X API',
            retryAfter: error.response.headers['x-rate-limit-reset']
          };
        default:
          throw { status: 500, message: 'Error fetching tweet from X API' };
      }
    }
    if (error.code === 'ECONNABORTED') {
      throw { status: 503, message: 'X API request timeout' };
    }
    throw { status: 500, message: 'Internal server error' };
  }
}

// Export functions
module.exports = {
  getPostDetails,
  clearCache,
  postRetweetedBy: async (postId) => {
    const cacheKey = `retweets:${postId}`;
    // Try persistent cache first
    const cached = await getCachedRecord(cacheKey);
    if (cached) {
      logger.info('Using cached retweets', { postId, cached });
      return cached;
    }
    try {
      const response = await xApiClient.get(`/tweets/${postId}/retweeted_by`, {
        params: { 'user.fields': 'id' }
      });
      const result = response.data;
      logger.info('Fresh retweet data from API', { postId, result });
      await setCachedRecord(cacheKey, result);
      return result;
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      logger.error('postRetweetedBy error', { postId, status, data, error: error.message });
      // Let task service handle null response instead of throwing
      if (status === 404 || status === 429) {
        return null;
      }
      throw new Error(`X API repost error: ${status}`);
    }
  },
  search: async (query, options = {}) => {
    const cacheKey = `quotes:${query}`;
    const cached = await getCachedRecord(cacheKey);
    if (cached) {
      logger.info('Using cached quote search', { query, cached });
      return cached;
    }
    try {
      // Add max_results to ensure we get enough tweets to search through
      const response = await xApiClient.get('/tweets/search/recent', {
        params: { 
          query,
          max_results: 100, // Get maximum allowed tweets
          ...options
        }
      });
      const result = response.data;
      logger.info('Fresh quote search from API', { query, result });
      await setCachedRecord(cacheKey, result);
      return result;
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      logger.error('search error', { query, status, data, error: error.message });
      // Let task service handle null response instead of throwing
      if (status === 404 || status === 429) {
        return null;
      }
      throw new Error(`X API quote error: ${status}`);
    }
  }
};