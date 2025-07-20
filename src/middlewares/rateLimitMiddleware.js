const { createLogger } = require('../utils/logger');
const logger = createLogger('rateLimitMiddleware');

// In production, use Redis for distributed rate limiting
const rateLimitStore = new Map();

/**
 * Custom rate limiter middleware
 * @param {Object} options - Configuration options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum number of requests per window
 * @param {string} options.message - Error message when limit exceeded
 * @param {boolean} options.skipSuccessfulRequests - Skip counting successful requests
 * @param {Function} options.keyGenerator - Function to generate unique key for each client
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60 * 1000, // 1 minute default
    max = 100, // 100 requests per window default
    message = 'Too many requests, please try again later',
    skipSuccessfulRequests = false,
    keyGenerator = (req) => {
      // Default key generator uses user ID if authenticated, otherwise IP
      return req.user?.id || req.ip || 'anonymous';
    }
  } = options;

  return async (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get or create client's request history
    let clientData = rateLimitStore.get(key);
    if (!clientData) {
      clientData = {
        requests: [],
        blocked: false,
        blockUntil: 0
      };
      rateLimitStore.set(key, clientData);
    }

    // Check if client is currently blocked
    if (clientData.blocked && now < clientData.blockUntil) {
      const retryAfter = Math.ceil((clientData.blockUntil - now) / 1000);
      logger.warn('Rate limit exceeded', {
        key,
        requests: clientData.requests.length,
        limit: max,
        retryAfter
      });

      return res.status(429).json({
        status: 'error',
        message,
        retryAfter
      });
    }

    // Clean up old requests outside the current window
    clientData.requests = clientData.requests.filter(timestamp => timestamp > windowStart);
    clientData.blocked = false;

    // Check if limit would be exceeded
    if (clientData.requests.length >= max) {
      // Block for the remainder of the window
      clientData.blocked = true;
      clientData.blockUntil = clientData.requests[0] + windowMs;
      
      const retryAfter = Math.ceil((clientData.blockUntil - now) / 1000);
      logger.warn('Rate limit exceeded', {
        key,
        requests: clientData.requests.length,
        limit: max,
        retryAfter
      });

      return res.status(429).json({
        status: 'error',
        message,
        retryAfter
      });
    }

    // Track response status if skipSuccessfulRequests is enabled
    if (skipSuccessfulRequests) {
      const originalEnd = res.end;
      res.end = function(...args) {
        // Only count non-successful requests
        if (res.statusCode >= 400) {
          clientData.requests.push(now);
        }
        originalEnd.apply(res, args);
      };
    } else {
      // Add current request timestamp
      clientData.requests.push(now);
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - clientData.requests.length));
    res.setHeader('X-RateLimit-Reset', new Date(now + windowMs).toISOString());

    next();
  };
}

/**
 * Pre-configured rate limiters for different endpoints
 */
const rateLimiters = {
  // Strict limit for upload endpoints
  upload: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute
    message: 'Upload rate limit exceeded. Please wait before uploading more data.',
    keyGenerator: (req) => req.user?.id || req.ip
  }),

  // General API limit
  general: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: 'Too many requests, please try again later.'
  }),

  // Authentication endpoints
  auth: createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    message: 'Too many authentication attempts, please try again later.',
    skipSuccessfulRequests: true, // Only count failed attempts
    keyGenerator: (req) => req.body?.email || req.ip // Use email or IP
  }),

  // Public endpoints (more lenient)
  public: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
    message: 'Too many requests, please try again later.'
  })
};

/**
 * Clean up expired entries periodically
 */
function cleanupExpiredEntries() {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, data] of rateLimitStore.entries()) {
    // Remove entries with no recent requests
    if (data.requests.length === 0 || 
        (data.requests[data.requests.length - 1] < now - 60 * 60 * 1000)) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} expired rate limit entries`);
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupExpiredEntries, 30 * 60 * 1000);

module.exports = {
  createRateLimiter,
  rateLimiters
};