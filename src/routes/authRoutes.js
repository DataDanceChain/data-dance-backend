const express = require('express');
const { register, login } = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const router = express.Router();

// 注册路由
// registerSuccessIp (native login F5): at most 5 SUCCESSFUL registrations per hour per IP (/64),
// only while DDC_AUTH_ENABLED=true; with the flag off it passes straight through (no count, no
// headers), so register behaves exactly as before. It runs before the legacy limiter so that its
// own 429 never counts as a failed attempt there, and the legacy X-RateLimit-* headers still win.
router.post('/register', rateLimiters.registerSuccessIp, rateLimiters.auth, register);

// 登录路由
router.post('/login', rateLimiters.auth, login);

// X binding handled via Web3Auth adapter — no direct custom routes

module.exports = router;