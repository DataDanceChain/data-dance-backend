const express = require('express');
const { register, login } = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const router = express.Router();

// 注册路由
router.post('/register', register);

// 登录路由
router.post('/login', login);

// X binding handled via Web3Auth adapter — no direct custom routes

module.exports = router;