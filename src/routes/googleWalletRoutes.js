const express = require('express');
const router = express.Router();
const googleWalletController = require('../controllers/googleWalletController');

// Google Wallet Web Service 接口
router.get('/objects/:objectId/classes/:classId', googleWalletController.handleGoogleWalletWebService);

// Google Wallet 回调接口（Google Wallet 平台事件推送）
router.post('/callback', googleWalletController.handleGoogleWalletCallback);

module.exports = router; 