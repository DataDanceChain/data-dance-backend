const crypto = require('crypto');
const { createLogger } = require('../utils/logger');
const logger = createLogger('rateLimitMiddleware');

// In-process store: one Map for the single container we run today.
// A second replica needs a shared store (Redis via rate-limiter-flexible,
// already a dependency) before any per-IP limit here means anything —
// each process would otherwise grant the full budget on its own.
// See README "运行加固" / plan §8 D10.
const rateLimitStore = new Map();

let limiterCounter = 0;

function isOAuthStylePath(req) {
  const url = req.originalUrl || req.url || '';
  return url.startsWith('/oauth') || url.startsWith('/partner/');
}

/**
 * Send a 429 in the shape the caller expects.
 * - `/oauth/*` and `/partner/*`: RFC 6749-style `{ error: 'slow_down', error_description }`
 * - everything else: existing `{ status: 'error', message, retryAfter }`
 * `Retry-After` (seconds) is always set.
 */
function sendRateLimited(req, res, { message, retryAfter, errorFormat }) {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  res.setHeader('Retry-After', String(seconds));
  const oauthStyle = errorFormat === 'oauth' || (errorFormat === 'auto' && isOAuthStylePath(req));
  if (oauthStyle) {
    return res.status(429).json({ error: 'slow_down', error_description: message });
  }
  return res.status(429).json({ status: 'error', message, retryAfter: seconds });
}

/**
 * Custom rate limiter middleware
 * @param {Object} options - Configuration options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum number of requests per window
 * @param {string} options.message - Error message when limit exceeded
 * @param {boolean} options.skipSuccessfulRequests - Skip counting successful requests (count only status >= 400)
 * @param {Function} options.keyGenerator - Function to generate unique key for each client
 * @param {string} options.name - Bucket namespace; each limiter gets its own buckets even for the same client key
 * @param {'auto'|'oauth'|'default'} options.errorFormat - 429 body shape (auto: by path)
 * @param {Function} options.now - Clock (tests)
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60 * 1000, // 1 minute default
    max = 100, // 100 requests per window default
    message = 'Too many requests, please try again later',
    skipSuccessfulRequests = false,
    keyGenerator = keyGenerators.userOrIp,
    name = `limiter${++limiterCounter}`,
    errorFormat = 'auto',
    now = Date.now,
  } = options;

  return async (req, res, next) => {
    const key = `${name}:${keyGenerator(req) || 'anonymous'}`;
    const current = now();
    const windowStart = current - windowMs;

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
    if (clientData.blocked && current < clientData.blockUntil) {
      const retryAfter = (clientData.blockUntil - current) / 1000;
      logger.warn('Rate limit exceeded', {
        key,
        requests: clientData.requests.length,
        limit: max,
        retryAfter: Math.ceil(retryAfter)
      });
      return sendRateLimited(req, res, { message, retryAfter, errorFormat });
    }

    // Clean up old requests outside the current window
    clientData.requests = clientData.requests.filter(timestamp => timestamp > windowStart);
    clientData.blocked = false;

    // Check if limit would be exceeded
    if (clientData.requests.length >= max) {
      // Block for the remainder of the window
      clientData.blocked = true;
      clientData.blockUntil = clientData.requests[0] + windowMs;

      const retryAfter = (clientData.blockUntil - current) / 1000;
      logger.warn('Rate limit exceeded', {
        key,
        requests: clientData.requests.length,
        limit: max,
        retryAfter: Math.ceil(retryAfter)
      });
      return sendRateLimited(req, res, { message, retryAfter, errorFormat });
    }

    // Count on ENTRY, always. Counting in res.end let N concurrent requests all pass the check
    // above before any of them counted, which nullified the brute-force limiters (plan §7.2 row
    // 7): an attacker just had to send the attempts in parallel.
    clientData.requests.push(current);

    // `skipSuccessfulRequests`: give the slot back once the response turns out to be a success,
    // so only failures accumulate — but only after it is known, never before.
    if (skipSuccessfulRequests) {
      const originalEnd = res.end;
      let settled = false;
      res.end = function(...args) {
        if (!settled) {
          settled = true;
          if (res.statusCode < 400) {
            // `clientData.requests` is re-assigned by the window filter, so read it now.
            const index = clientData.requests.indexOf(current);
            if (index !== -1) clientData.requests.splice(index, 1);
          }
        }
        return originalEnd.apply(res, args);
      };
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - clientData.requests.length));
    res.setHeader('X-RateLimit-Reset', new Date(current + windowMs).toISOString());

    next();
  };
}

/**
 * Key generators. Never key on anything the caller chooses freely (email,
 * client_id, username): the attacker would pick a fresh key per request.
 */
const keyGenerators = {
  // Real client IP; correct behind the proxy only with `trust proxy` set (app.js).
  ip: (req) => req.ip || 'anonymous',
  userOrIp: (req) => req.user?.id || req.ip || 'anonymous',
  // Per bearer token, stored as a hash so the token never enters the store or the logs.
  bearerTokenHash: (req) => {
    const header = req.get?.('authorization') || req.headers?.authorization || '';
    const match = header.match(/^Bearer\s+(\S+)/i);
    if (!match) return `ip:${req.ip || 'anonymous'}`;
    return `tok:${crypto.createHash('sha256').update(match[1]).digest('hex')}`;
  },
};

/**
 * Pre-configured rate limiters for different endpoints
 */
const rateLimiters = {
  // Strict limit for upload endpoints
  upload: createRateLimiter({
    name: 'upload',
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute
    message: 'Upload rate limit exceeded. Please wait before uploading more data.',
    keyGenerator: keyGenerators.userOrIp
  }),

  // General API limit
  general: createRateLimiter({
    name: 'general',
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: 'Too many requests, please try again later.'
  }),

  // Password login / register: 5 failures per 15 minutes per IP.
  // Keyed by IP, not by the submitted email — that key was attacker-chosen.
  auth: createRateLimiter({
    name: 'auth',
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    message: 'Too many authentication attempts, please try again later.',
    skipSuccessfulRequests: true, // Only count failed attempts
    keyGenerator: keyGenerators.ip
  }),

  // Public endpoints (more lenient)
  public: createRateLimiter({
    name: 'public',
    windowMs: 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
    message: 'Too many requests, please try again later.'
  }),

  // Membership check — enough for a known email, not a scrape of the list
  verify: createRateLimiter({
    name: 'verify',
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many membership checks. Please wait a minute.',
    keyGenerator: keyGenerators.userOrIp
  }),

  // POST /api/auth/web3auth-login — every attempt counts (an id token is verified per call)
  web3authLogin: createRateLimiter({
    name: 'web3authLogin',
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many login attempts. Please wait a minute.',
    keyGenerator: keyGenerators.ip
  }),

  // POST /oauth/register (dynamic client registration)
  oauthRegister: createRateLimiter({
    name: 'oauthRegister',
    windowMs: 60 * 1000,
    max: 5,
    message: 'Too many client registrations. Please wait a minute.',
    keyGenerator: keyGenerators.ip
  }),

  // GET /oauth/authorize
  oauthAuthorize: createRateLimiter({
    name: 'oauthAuthorize',
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many authorization requests. Please wait a minute.',
    keyGenerator: keyGenerators.ip
  }),

  // POST /oauth/token
  oauthToken: createRateLimiter({
    name: 'oauthToken',
    windowMs: 60 * 1000,
    max: 20,
    message: 'Too many token requests. Please wait a minute.',
    keyGenerator: keyGenerators.ip
  }),

  // POST /oauth/revoke
  oauthRevoke: createRateLimiter({
    name: 'oauthRevoke',
    windowMs: 60 * 1000,
    max: 20,
    message: 'Too many revocation requests. Please wait a minute.',
    keyGenerator: keyGenerators.ip
  }),

  // POST /api/oauth/consent — per signed-in user, IP before the principal is known
  consent: createRateLimiter({
    name: 'consent',
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many consent decisions. Please wait a minute.',
    keyGenerator: keyGenerators.userOrIp
  }),

  // /partner/tge/* — per partner access token (hashed), RFC-style 429 body
  partner: createRateLimiter({
    name: 'partner',
    windowMs: 60 * 1000,
    max: 120,
    message: 'Rate limit exceeded for this access token. Retry after the indicated delay.',
    keyGenerator: keyGenerators.bearerTokenHash,
    errorFormat: 'oauth'
  }),

  // POST /api/ops/auth/login — 5 failures per 15 minutes per IP; successes are free
  opsLogin: createRateLimiter({
    name: 'opsLogin',
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many failed ops login attempts, please try again later.',
    skipSuccessfulRequests: true,
    keyGenerator: keyGenerators.ip
  }),

  // POST /api/sso/app-ticket — per user (Phase 3)
  ssoTicket: createRateLimiter({
    name: 'ssoTicket',
    windowMs: 60 * 1000,
    max: 5,
    message: 'Too many hand-off tickets requested. Please wait a minute.',
    keyGenerator: keyGenerators.userOrIp
  }),

  // POST /api/sso/ticket/exchange — public, per IP (Phase 3)
  ssoExchange: createRateLimiter({
    name: 'ssoExchange',
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many ticket exchanges. Please wait a minute.',
    keyGenerator: keyGenerators.ip
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

/** Tests only: forget every bucket. */
function clearRateLimitStore() {
  rateLimitStore.clear();
}

// Run cleanup every 30 minutes; unref so the timer never keeps a process alive on its own
setInterval(cleanupExpiredEntries, 30 * 60 * 1000).unref();

module.exports = {
  createRateLimiter,
  rateLimiters,
  keyGenerators,
  clearRateLimitStore
};
