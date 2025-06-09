const express = require('express');
const {
  getCrawlerTasks,
  uploadData
} = require('../controllers/crawlerController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// All routes require authentication
router.use(protect);

// Core endpoints matching original specification
router.get('/crawler-tasks', getCrawlerTasks);
router.post('/upload', uploadData);

module.exports = router; 