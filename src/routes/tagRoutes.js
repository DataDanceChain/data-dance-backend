const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const tagController = require('../controllers/tagController');
const router = express.Router();

router.get('/', tagController.getAllTags);
router.post('/', protect, tagController.createTag);

module.exports = router; 