/**
 * Shared error classification for the two bearer-token middlewares
 * (`authMiddleware.protect`, `auth.authenticate`).
 *
 * Only the JWT library's own failures are an authentication problem. A Prisma
 * error thrown by the user lookup means the *database* failed, and answering 401
 * would log every Wallet user out (the app clears its token on 401) while
 * leaving no trace. Those become 503 + Retry-After; anything else is handed to
 * the app's error handler as a 500.
 *
 * Classification is by `error.name` / `error.code`, not `instanceof`, so it
 * survives the several `@prisma/client` copies a repo can end up with and the
 * require-cache stand-ins the unit tests install.
 */
const { redactUrl } = require('../utils/logger');

const JWT_ERROR_NAMES = new Set(['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError']);

// Errors that mean "the database cannot be reached right now", not "this query is wrong".
const PRISMA_UNAVAILABLE_ERROR_NAMES = new Set([
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
]);
// PrismaClientKnownRequestError codes for connection problems:
// P1001 can't reach, P1002 timed out, P1008 operation timed out, P1017 server closed the connection.
const PRISMA_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

const RETRY_AFTER_SECONDS = 5;
const DATABASE_UNAVAILABLE_CODE = 'DATABASE_UNAVAILABLE';

function isJwtError(error) {
  return Boolean(error) && JWT_ERROR_NAMES.has(error.name);
}

function isDatabaseUnavailableError(error) {
  if (!error) return false;
  if (PRISMA_UNAVAILABLE_ERROR_NAMES.has(error.name)) return true;
  return error.name === 'PrismaClientKnownRequestError' && PRISMA_UNAVAILABLE_CODES.has(error.code);
}

/**
 * @returns {'jwt'|'db_unavailable'|'unexpected'}
 */
function classifyAuthError(error) {
  if (isJwtError(error)) return 'jwt';
  if (isDatabaseUnavailableError(error)) return 'db_unavailable';
  return 'unexpected';
}

/**
 * Log an auth-middleware failure at error level: name, code and message of the
 * error plus the request line. The bearer token is never written; if the
 * message quotes it, the quote is masked.
 */
function logAuthError(logger, error, req, token) {
  let message = String(error?.message ?? error ?? '');
  if (token) message = message.split(token).join('[redacted]');
  logger.error('Auth middleware: user lookup failed', {
    reqId: req?.reqId,
    method: req?.method,
    url: redactUrl(req?.originalUrl || req?.url),
    kind: classifyAuthError(error),
    errorName: error?.name || 'Error',
    errorCode: error?.code || error?.errorCode,
    errorMessage: message,
  });
}

function sendDatabaseUnavailable(res, message) {
  res.set('Retry-After', String(RETRY_AFTER_SECONDS));
  return res.status(503).json({
    status: 'error',
    code: DATABASE_UNAVAILABLE_CODE,
    message,
  });
}

module.exports = {
  JWT_ERROR_NAMES,
  PRISMA_UNAVAILABLE_ERROR_NAMES,
  PRISMA_UNAVAILABLE_CODES,
  RETRY_AFTER_SECONDS,
  DATABASE_UNAVAILABLE_CODE,
  isJwtError,
  isDatabaseUnavailableError,
  classifyAuthError,
  logAuthError,
  sendDatabaseUnavailable,
};
