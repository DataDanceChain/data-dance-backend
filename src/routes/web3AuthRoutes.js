const express = require('express');
const { web3authLogin } = require('../controllers/web3AuthController');
const { updateWallet } = require('../controllers/web3AuthController');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');

const router = express.Router();

// Web3Auth 登录/注册
router.post('/web3auth-login', rateLimiters.web3authLogin, web3authLogin);

// 更新钱包地址 - 需要认证
router.post('/update-wallet', protect, updateWallet);

module.exports = router; 