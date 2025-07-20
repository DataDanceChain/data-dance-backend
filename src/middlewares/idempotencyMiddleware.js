const { createLogger } = require('../utils/logger');
const logger = createLogger('idempotencyMiddleware');

// In production, use Redis instead of in-memory storage
const idempotencyStore = new Map();
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Middleware to handle idempotent requests
 * Requires 'Idempotency-Key' header for POST/PUT requests
 */
function idempotencyMiddleware(options = {}) {
  const { required = false, ttl = IDEMPOTENCY_TTL } = options;

  return async (req, res, next) => {
    // Only apply to POST and PUT requests
    if (!['POST', 'PUT'].includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
    
    // Store the original request body early to avoid mutations
    const originalBody = JSON.parse(JSON.stringify(req.body));
    
    // If idempotency key is required but not provided
    if (required && !idempotencyKey) {
      return res.status(400).json({
        status: 'error',
        message: 'Idempotency-Key header is required for this request'
      });
    }

    // If no idempotency key provided, proceed normally
    if (!idempotencyKey) {
      return next();
    }

    // Generate a unique key combining user ID and idempotency key
    const userId = req.user?.id || 'anonymous';
    const storeKey = `${userId}:${req.path}:${idempotencyKey}`;

    // Check if we have a cached response
    const cachedEntry = idempotencyStore.get(storeKey);
    
    if (cachedEntry) {
      // Check if the request body matches using the original body
      const requestBodyHash = generateHash(originalBody);
      
      if (cachedEntry.bodyHash !== requestBodyHash) {
        logger.warn('Idempotency key reused with different request body', {
          userId,
          path: req.path,
          idempotencyKey
        });
        
        return res.status(422).json({
          status: 'error',
          message: 'Idempotency key already used with different request parameters'
        });
      }

      // Return cached response
      logger.info('Returning cached response for idempotent request', {
        userId,
        path: req.path,
        idempotencyKey
      });
      
      return res.status(cachedEntry.status).json(cachedEntry.body);
    }

    // Store the original res.json function
    const originalJson = res.json.bind(res);
    const originalStatus = res.status.bind(res);
    let responseStatus = 200;

    // Override res.status to capture the status code
    res.status = function(status) {
      responseStatus = status;
      return originalStatus(status);
    };

    // Override res.json to cache the response
    res.json = function(body) {
      // Only cache successful responses (2xx status codes)
      if (responseStatus >= 200 && responseStatus < 300) {
        const requestBodyHash = generateHash(originalBody);
        
        idempotencyStore.set(storeKey, {
          bodyHash: requestBodyHash,
          status: responseStatus,
          body: body,
          timestamp: Date.now()
        });

        // Set a timeout to clean up the cache entry
        setTimeout(() => {
          idempotencyStore.delete(storeKey);
        }, ttl);

        logger.info('Cached response for idempotent request', {
          userId,
          path: req.path,
          idempotencyKey,
          ttl
        });
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * Generate a hash of the request body for comparison
 */
function generateHash(obj) {
  const crypto = require('crypto');
  
  // Recursively normalize and sort object keys
  function normalize(input) {
    if (input === null || input === undefined) {
      return input;
    }
    
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    
    if (typeof input === 'object') {
      const sorted = {};
      Object.keys(input)
        .sort()
        .forEach(key => {
          sorted[key] = normalize(input[key]);
        });
      return sorted;
    }
    
    return input;
  }
  
  const normalized = normalize(obj);
  const str = JSON.stringify(normalized);
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Clean up expired entries (run periodically)
 */
function cleanupExpiredEntries() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, entry] of idempotencyStore.entries()) {
    if (now - entry.timestamp > IDEMPOTENCY_TTL) {
      idempotencyStore.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} expired idempotency entries`);
  }
}

// Run cleanup every hour
setInterval(cleanupExpiredEntries, 60 * 60 * 1000);

module.exports = {
  idempotencyMiddleware,
  idempotencyStore // Exported for testing purposes
};