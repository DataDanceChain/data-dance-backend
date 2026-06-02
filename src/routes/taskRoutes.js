const express = require('express');
const { getTasksByAward, recordTaskProgress, claimTask } = require('../controllers/taskController');
const { protect } = require('../middlewares/authMiddleware');
const { referralRewardAwardTasksGate } = require('../middlewares/referralRewardsApiGate');

const router = express.Router();

// 获取指定奖励的子任务列表
router.get(
  '/awards/:awardId/tasks',
  protect,
  referralRewardAwardTasksGate,
  getTasksByAward,
);
// 记录子任务进度
router.post('/users/tasks/:taskId/progress', protect, recordTaskProgress);
// 领取子任务奖励
router.post('/users/tasks/:taskId/claim', protect, claimTask);

module.exports = router;