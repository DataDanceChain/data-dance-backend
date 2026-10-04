const express = require('express');
const { getVersionPolicy } = require('../controllers/appController');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');

const router = express.Router();

// Public: the App asks before anyone is signed in, so there is no `protect` here. app.js mounts
// this router ahead of the bare `/api` routers, one of which (crawlerRoutes) protects everything
// that reaches it. Per-IP limit from the shared "public endpoints" limiter.
router.get('/version-policy', rateLimiters.public, getVersionPolicy);

module.exports = router;
