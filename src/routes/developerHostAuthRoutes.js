const express = require('express');
const host = require('../services/developerHostAuth');
const { protect } = require('../middlewares/authMiddleware');
const { bearer, sendError } = require('../middlewares/developerHostAuth');
const { createRateLimiter, keyGenerators } = require('../middlewares/rateLimitMiddleware');
const router = express.Router();
const limited = (name, max, keyGenerator = keyGenerators.ip) => createRateLimiter({ name: `developerHost.${name}`, max, windowMs: 60000, keyGenerator });
const startLimit = limited('start', 30), codeLimit = limited('code', 15, keyGenerators.userOrIp), exchangeLimit = limited('exchange', 30), readLimit = limited('read', 120);
const globalLimit = limited('global', 600, () => 'global');
function headers(req, res, next) { res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' }); next(); }
function body(req) { return req.body && !Array.isArray(req.body) && typeof req.body === 'object' ? req.body : {}; }
function call(fn) { return async (req, res) => { try { const result = await fn(req); return result === undefined ? res.status(204).end() : res.json(result); } catch (error) { return sendError(res, error); } }; }
router.post('/start', headers, startLimit, globalLimit, call(req => host.start({ token: req.headers.authorization ? bearer(req) || '' : undefined, body: body(req) })));
router.post('/code', headers, protect, codeLimit, globalLimit, call(req => host.code({ user: req.user, authClaims: req.authClaims, body: body(req) })));
router.post('/exchange', headers, exchangeLimit, globalLimit, call(req => host.exchange({ token: bearer(req), body: body(req), requestId: req.reqId || null })));
router.get('/me', headers, readLimit, call(async req => (await host.current(bearer(req))).identity));
router.post('/logout', headers, startLimit, call(req => host.logout(bearer(req))));
module.exports = router;
