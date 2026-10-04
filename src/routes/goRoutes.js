const express = require('express');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const go = require('../controllers/trackedLinkController');

const router = express.Router();

router.get('/:slug', rateLimiters.public, go.showPublic);
router.post('/:slug/events', rateLimiters.public, go.recordPublic);

module.exports = router;
