const express = require('express');
const { getPost } = require('../controllers/xController'); // Updated path
const { protect, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

// Public route to get post details
router.get('/posts/:postId', getPost);

module.exports = router;