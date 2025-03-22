const express = require('express');
const { register, login } = require('../controllers/authController');
const router = express.Router();

// 注册路由
router.post('/register', register);

// 登录路由
router.post('/login', login);

module.exports = router; 