const express = require('express');
const { register, login } = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { registerUsageLog } = require('../middlewares/registerUsageLog');
const router = express.Router();

// 注册路由 — the public e-mail + password sign-up (decision 43 A: throttled and logged, not closed).
// The usage log runs first so a rate-limited call is still one log line; then every attempt is
// counted per IP and per e-mail; `auth` (failures only, shared with /login) stays as it was.
router.post('/register', registerUsageLog, rateLimiters.registerIp, rateLimiters.registerEmail, rateLimiters.auth, register);

// 登录路由
router.post('/login', rateLimiters.auth, login);

// X binding handled via Web3Auth adapter — no direct custom routes

module.exports = router;