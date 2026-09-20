const express = require('express');
const { register, login } = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const router = express.Router();

// 注册路由
router.post('/register', rateLimiters.auth, register);

// 登录路由
router.post('/login', rateLimiters.auth, login);

// X binding handled via Web3Auth adapter — no direct custom routes

module.exports = router;