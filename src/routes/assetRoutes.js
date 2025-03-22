const express = require('express');
const { getAssetOverview, getPoints, getBadges, getBadgeDetail, getTransactions, collectBadge } = require('../controllers/assetController');
const { protect } = require('../middlewares/authMiddleware');
const router = express.Router();

// 所有路由都需要认证
router.use(protect);

// 获取资产总览
router.get('/', getAssetOverview);

// 获取积分
router.get('/points', getPoints);

// 获取勋章列表
router.get('/badges', getBadges);

// 获取勋章详情
router.get('/badges/:id', getBadgeDetail);

// 获取交易记录
router.get('/transactions', getTransactions);

// 收集勋章
router.post('/badges/:id/collect', collectBadge);

module.exports = router; 