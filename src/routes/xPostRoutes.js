const express = require('express');
const { getPost, clearPostCache } = require('../controllers/xPostController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

// Public route to get post details
router.get('/posts/:postId', getPost);

// Admin only route to clear cache
router.delete('/posts/:postId/cache', protect, restrictTo('admin'), clearPostCache);

module.exports = router; 