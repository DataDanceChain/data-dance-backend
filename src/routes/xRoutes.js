const express = require('express');
const { getPost, oauth2Authorize, oauth2AuthorizeUrl, oauth2Callback, getXStatus } = require('../controllers/xController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

// Public route to get post details
router.get('/posts/:postId', getPost);

// OAuth2-based linking endpoints
// New endpoint that returns the authorization URL
router.get('/oauth2/authorize-url', protect, oauth2AuthorizeUrl);
// Keep old endpoint for backward compatibility
router.get('/oauth2/authorize', protect, oauth2Authorize);
// X redirects here after user authorization (PKCE state identifies user)
router.get('/oauth2/callback', oauth2Callback);
// Check current user's X binding status
router.get('/status', protect, getXStatus);

module.exports = router;