/**
 * Request identity for the audit record.
 *
 * `req.reqId` is ALWAYS ours (a fresh UUID). It used to be the inbound `X-Request-Id` whenever
 * that header passed a charset test, which means the identifier our own audit trail is keyed on
 * was chosen by the caller: a partner could give two different requests one id, or reuse the id
 * of somebody else's request, and the log would agree with them. On a money path the record has
 * to be anchored on something the subject of the record cannot pick.
 *
 * The inbound value is not thrown away — correlation across the partner's systems and ours is
 * genuinely useful — it is kept beside ours as `req.upstreamRequestId`, clearly marked as
 * claimed-by-the-caller, and never used as a key.
 */
const crypto = require('crypto');

// Same conservative charset as before: what survives into a log line without quoting games.
const UPSTREAM_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function requestIdMiddleware(req, res, next) {
  const incoming = typeof req.get === 'function' ? req.get('x-request-id') : req.headers?.['x-request-id'];
  req.reqId = crypto.randomUUID();
  req.upstreamRequestId = incoming && UPSTREAM_REQUEST_ID_PATTERN.test(incoming) ? incoming : null;
  res.set('X-Request-Id', req.reqId);
  next();
}

module.exports = { requestIdMiddleware, UPSTREAM_REQUEST_ID_PATTERN };
