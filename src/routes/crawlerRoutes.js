const express = require('express');
const {
  getCrawlerTasks,
  createCrawlerTask,
  uploadData,
  getCrawlerData,
  getCrawlerStats,
  getUploadLimits,
  updateTaskStatus,
  deleteCrawlerTask
} = require('../controllers/crawlerController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// All routes require authentication
router.use(protect);

// Core endpoints matching original specification
router.get('/crawler-tasks', getCrawlerTasks);
router.post('/crawler-tasks', createCrawlerTask);
router.post('/crawler/upload', uploadData);

// Task management endpoints
router.get('/crawler-tasks/:taskId/data', getCrawlerData);
router.post('/crawler-tasks/:taskId/data', uploadData);
router.put('/crawler-tasks/:taskId/status', updateTaskStatus);
router.delete('/crawler-tasks/:taskId', deleteCrawlerTask);

// Statistics and limits endpoints
router.get('/crawler/stats', getCrawlerStats);
router.get('/crawler/limits', getUploadLimits);

module.exports = router; 