const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { authenticate, isOrganization } = require('../middlewares/auth');

// Ensure authentication and organization check for all routes
router.use(authenticate);
router.use(isOrganization);

// 获取交易记录
router.get('/', transactionController.getTransactions);

// 获取余额
router.get('/balance', transactionController.getBalance);

// 创建充值交易
router.post('/deposit', transactionController.createDepositTransaction);

// 创建提现交易
router.post('/withdraw', transactionController.createWithdrawTransaction);

// 更新交易状态
router.patch('/:id/status', transactionController.updateTransactionStatus);

module.exports = router; 