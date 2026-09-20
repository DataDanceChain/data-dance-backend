const winston = require('winston');

// ---------------------------------------------------------------------------
// Redaction
//
// Nothing that can be replayed (bearer/OAuth tokens, authorization codes,
// SSO tickets, Web3Auth id tokens, client secrets, PKCE verifiers, passwords,
// OTPs) may reach stdout or logs/*.log. Query values are masked in URLs, and
// the same keys are masked wherever they appear in a log's meta object.
// ---------------------------------------------------------------------------

// Query-string keys whose values are masked in URLs and in meta objects.
const SENSITIVE_QUERY_KEYS = [
  'access_token',
  'token',
  'code',
  'ticket',
  'id_token',
  'idToken',
  'client_secret',
  'refresh_token',
  'code_verifier',
  'password',
  'otp',
];

// Meta-object keys masked in addition to the query keys above.
const SENSITIVE_META_KEYS = [...SENSITIVE_QUERY_KEYS, 'authorization', 'Authorization'];

// Keys whose value is never partially shown (a 6-digit OTP with 4 digits kept
// is not masked; a password prefix is a password hint).
const FULLY_HIDDEN_KEYS = ['password', 'otp'];

const sensitiveMetaSet = new Set(SENSITIVE_META_KEYS.map((key) => key.toLowerCase()));
const fullyHiddenSet = new Set(FULLY_HIDDEN_KEYS.map((key) => key.toLowerCase()));

const REDACTED = '[redacted]';
// Prefix kept for masked secrets: enough to tell token families apart
// (`ddc_`, `eyJh`), never enough to replay.
const KEEP_PREFIX = 4;
// Values at or below this length are hidden entirely; keeping 4 of 8 chars is
// not masking.
const MIN_MASKABLE_LENGTH = 9;
const MAX_DEPTH = 8;
// Output of maskSecret; recognised so a value redacted once (requestLogger)
// is not masked again by the winston format.
const maskedValuePattern = /^(?:\[redacted\]|.{0,4}\u2026\(len=\d+\))$/;

// `?key=value` / `&key=value` for a sensitive key; the value ends at `&`, `#`
// or whitespace so the pattern also works inside free-form text (messages,
// stack traces, referers) that quotes a URL.
const queryValuePattern = new RegExp(`([?&])(${SENSITIVE_QUERY_KEYS.join('|')})=([^&#\\s]*)`, 'gi');
// `Bearer <credential>`, `Basic <credential>`, `SsoSession <credential>`: keep the scheme.
const authSchemePattern = /^([A-Za-z][A-Za-z0-9_-]*)\s+(\S.*)$/;

function isSensitiveMetaKey(key) {
  return sensitiveMetaSet.has(String(key).toLowerCase());
}

/**
 * Mask a secret: keep the first 4 characters plus the length, or hide it
 * entirely when it is short or must never be hinted at.
 * @param {*} value
 * @param {{ full?: boolean }} [options]
 * @returns {string|*} the mask, or the value untouched when null/undefined/empty
 */
function maskSecret(value, options = {}) {
  if (value === null || value === undefined) return value;
  const str = typeof value === 'string' ? value : String(value);
  if (str.length === 0 || maskedValuePattern.test(str)) return str;
  if (options.full || str.length < MIN_MASKABLE_LENGTH) return REDACTED;
  return `${str.slice(0, KEEP_PREFIX)}…(len=${str.length})`;
}

/**
 * Mask a credential header value, keeping the auth scheme (`Bearer abcd…(len=40)`).
 */
function maskCredential(value) {
  if (typeof value !== 'string') return maskSecret(value);
  const match = value.match(authSchemePattern);
  if (!match) return maskSecret(value);
  return `${match[1]} ${maskSecret(match[2])}`;
}

/** `alice@example.com` -> `***@example.com`; anything without `@` is hidden. */
function maskEmail(value) {
  if (typeof value !== 'string') return value === null || value === undefined ? value : REDACTED;
  const at = value.lastIndexOf('@');
  if (at <= 0) return REDACTED;
  return `***@${value.slice(at + 1)}`;
}

/** `0x1234567890abcdef…` -> `0x1234…cdef`. */
function maskWalletAddress(value) {
  if (typeof value !== 'string') return value === null || value === undefined ? value : REDACTED;
  if (value.length <= 10) return REDACTED;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Mask the values of sensitive query parameters in a URL, path, or any string
 * that quotes one. Everything else (path, other params, fragment, encoding,
 * surrounding text) is left byte-for-byte; the key keeps its spelling.
 * @param {string} url absolute or relative
 * @returns {string}
 */
function redactUrl(url) {
  if (typeof url !== 'string' || url.indexOf('=') === -1) return url;
  return url.replace(queryValuePattern, (match, separator, key, value) => {
    if (value === '') return match;
    const full = fullyHiddenSet.has(key.toLowerCase());
    return `${separator}${key}=${maskSecret(value, { full })}`;
  });
}

/**
 * Redact a free-form string (message, referer, stack): embedded query strings
 * with a sensitive key are masked; other strings pass through.
 */
function redactString(value) {
  return redactUrl(value);
}

function isWalkable(value) {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof Date || value instanceof RegExp) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  if (value instanceof Map || value instanceof Set) return false;
  if (value instanceof WeakMap || value instanceof WeakSet) return false;
  if (typeof value.then === 'function') return false;
  return true;
}

// `code` in a meta object is usually an error code (`P2002`, `ECONNREFUSED`,
// `IDTOKEN_INVALID`, 401), not an OAuth authorization code (`ddc_code_...`).
// Constant-style identifiers and numbers stay readable; everything else under
// `code` is masked.
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
function looksLikeErrorCode(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  return typeof value === 'string' && errorCodePattern.test(value);
}

/**
 * Redact one value given the key it is stored under.
 */
function redactValue(key, value, depth = 0, seen = new WeakSet()) {
  const lowerKey = String(key ?? '').toLowerCase();

  if (lowerKey === 'email') return maskEmail(value);
  if (lowerKey === 'walletaddress') return maskWalletAddress(value);
  if (lowerKey === 'authorization') return maskCredential(value);
  if (lowerKey === 'code' && looksLikeErrorCode(value)) return value;
  if (isSensitiveMetaKey(lowerKey)) {
    if (isWalkable(value)) return redactObject(value, depth + 1, seen);
    return maskSecret(value, { full: fullyHiddenSet.has(lowerKey) });
  }
  if (typeof value === 'string') return redactString(value);
  if (isWalkable(value)) return redactObject(value, depth + 1, seen);
  return value;
}

/**
 * Deep-copy an object/array with sensitive keys masked. Circular references
 * and objects deeper than MAX_DEPTH are replaced with markers. The input is
 * not mutated.
 * @param {*} input
 * @returns {*}
 */
function redactObject(input, depth = 0, seen = new WeakSet()) {
  if (!isWalkable(input)) return typeof input === 'string' ? redactString(input) : input;
  if (seen.has(input)) return '[Circular]';
  if (depth > MAX_DEPTH) return '[Truncated]';
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((item) => redactValue('', item, depth, seen));
  }

  const out = {};
  if (input instanceof Error) {
    out.name = input.name;
    out.message = redactString(input.message);
    if (input.stack) out.stack = redactString(input.stack);
  }
  for (const key of Object.keys(input)) {
    out[key] = redactValue(key, input[key], depth, seen);
  }
  return out;
}

/**
 * winston format: masks sensitive keys in every log record's meta, including
 * nested objects and arrays. Symbols (level/message/splat) are untouched.
 */
const redactFormat = winston.format((info) => {
  const seen = new WeakSet();
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'timestamp') continue;
    info[key] = redactValue(key, info[key], 0, seen);
  }
  return info;
});

// Define log format
const logFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  redactFormat(),
  winston.format.timestamp(),
  winston.format.json()
);

// Create logger instance
function createLogger(module) {
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { module },
    transports: [
      // Write all logs to console in JSON
      new winston.transports.Console({
        format: logFormat
      }),
      // Write all logs with level 'error' and below to error.log
      new winston.transports.File({ 
        filename: 'logs/error.log', 
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5
      }),
      // Write all logs with level 'info' and below to combined.log
      new winston.transports.File({ 
        filename: 'logs/combined.log',
        maxsize: 5242880, // 5MB
        maxFiles: 5
      })
    ]
  });

  // Add request logging middleware
  logger.requestLogger = (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info('Request completed', {
        reqId: req.reqId,
        method: req.method,
        url: redactUrl(req.originalUrl || req.url),
        status: res.statusCode,
        duration,
        ip: req.ip,
        userId: req.user?.id
      });
    });
    next();
  };

  // Add error logging middleware
  logger.errorLogger = (err, req, res, next) => {
    logger.error('Request failed', {
      reqId: req.reqId,
      error: err.message,
      stack: err.stack,
      method: req.method,
      url: redactUrl(req.originalUrl || req.url),
      ip: req.ip,
      userId: req.user?.id
    });
    next(err);
  };

  return logger;
}

module.exports = {
  createLogger,
  redactUrl,
  redactString,
  redactObject,
  redactValue,
  redactFormat,
  maskSecret,
  maskCredential,
  maskEmail,
  maskWalletAddress,
  SENSITIVE_QUERY_KEYS,
  SENSITIVE_META_KEYS,
};
