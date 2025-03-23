const express = require('express');
const { 
  getActivities, 
  getActivity, 
  getRecommendedActivities,
  getCategories,
  getAllActivities,
  getFeaturedActivities,
  getActivityById,
  getClaimedActivities,
  getUserClaimedActivities,
  claimActivity
} = require('../controllers/activityController');
const { protect } = require('../middlewares/authMiddleware');
const router = express.Router();

// 所有路由都需要认证
router.use(protect);

// 获取推荐活动
router.get('/recommended', getRecommendedActivities);

// 获取活动分类
router.get('/categories', getCategories);

// 获取用户已领取的活动（通过 ActivityClaim 表）
router.get('/claimed', getClaimedActivities);

// 获取用户已领取的活动（通过过滤 Activity 表）
router.get('/user-claimed', getUserClaimedActivities);

// 获取活动列表
router.get('/', getAllActivities);

// 获取活动详情 - 这个路由应该放在最后
router.get('/:id', getActivityById);

// 领取活动
router.post('/:id/claim', claimActivity);

module.exports = router; 