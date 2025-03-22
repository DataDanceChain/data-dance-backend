const express = require('express');
const { 
  getNotifications, 
  markAsRead, 
  markAllAsRead,
  updatePreferences
} = require('../controllers/notificationController');
const { protect } = require('../middlewares/authMiddleware');
const router = express.Router();

// 所有路由都需要认证
router.use(protect);

// 获取通知列表
router.get('/', getNotifications);

// 标记所有通知为已读
router.put('/read-all', markAllAsRead);

// 更新通知偏好设置
router.put('/preferences', updatePreferences);

// 标记单个通知为已读
router.put('/:id/read', markAsRead);

module.exports = router; 