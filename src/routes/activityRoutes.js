const express = require('express');
const { 
  getActivities, 
  getActivity, 
  participateActivity, 
  getRecommendedActivities,
  getCategories,
  getAllActivities,
  getFeaturedActivities,
  getActivityById
} = require('../controllers/activityController');
const { protect } = require('../middlewares/authMiddleware');
const router = express.Router();

// 所有路由都需要认证
router.use(protect);

// 获取推荐活动
router.get('/recommended', getRecommendedActivities);

// 获取活动分类
router.get('/categories', getCategories);

// 获取活动列表
router.get('/', getAllActivities);

// 获取活动详情
router.get('/:id', getActivityById);

// 参与活动
router.post('/:id/participate', participateActivity);

module.exports = router; 