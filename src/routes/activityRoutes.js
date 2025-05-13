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
  claimActivity,
  getCreatedActivities,
  createActivity
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

// 获取商家创建的活动
router.get('/created-by-me', getCreatedActivities);

// 创建新活动 - 使用 /new 端点，处理文件上传
router.post('/new', 
  (req, res, next) => {
    const upload = req.app.get('upload');
    upload.any()(req, res, (err) => {
      if (err) {
        console.error('Multer error:', err);
        return res.status(400).json({
          status: 'error',
          message: err.message
        });
      }
      next();
    });
  },
  createActivity
);

// 获取活动详情
router.get('/:id', getActivityById);

// 领取活动
router.post('/:id/claim', claimActivity);

// 给活动设置标签
router.post('/:id/tags', require('../controllers/activityController').setActivityTags);

module.exports = router; 