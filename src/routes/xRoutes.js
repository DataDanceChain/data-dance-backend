const express = require('express');
const { getPost, oauth2AuthorizeUrl, oauth2Callback, oauth2Complete, getXStatus } = require('../controllers/xController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

// Public route to get post details
router.get('/posts/:postId', getPost);

// OAuth2-based linking (decision 46: see ../services/xBindFlow.js).
// 1. Start: a server-side flow for the bearer user; returns the X URL and the session's binding secret.
router.get('/oauth2/authorize-url', protect, oauth2AuthorizeUrl);
// 2. X redirects the browser here. Consumes the flow and parks the result; binds nothing.
router.get('/oauth2/callback', oauth2Callback);
// 3. The initiating session confirms the parked result; only this step writes User.xid.
router.post('/oauth2/complete', protect, oauth2Complete);
// The bearer-only `GET /oauth2/authorize` redirect is gone: a top-level navigation can never carry
// the bearer token, so it had no working caller, and it could not return the binding secret.
// Check current user's X binding status
router.get('/status', protect, getXStatus);

module.exports = router;