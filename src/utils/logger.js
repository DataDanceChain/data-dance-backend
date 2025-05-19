const winston = require('winston');

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
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
        method: req.method,
        url: req.url,
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
      error: err.message,
      stack: err.stack,
      method: req.method,
      url: req.url,
      ip: req.ip,
      userId: req.user?.id
    });
    next(err);
  };

  return logger;
}

module.exports = { createLogger };