const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const {
  getStatus,
  updateSettings,
  getTokens,
  createToken,
  deleteToken,
  postRefine,
  postClean,
  postSavedRefined,
} = require('../controllers/lifeContextController');

const router = express.Router();

router.use(protect);
router.get('/', getStatus);
router.patch('/settings', updateSettings);
router.post('/refine', rateLimiters.lifeContextRefine, postRefine);
router.post('/clean', rateLimiters.lifeContextClean, postClean);
router.post('/refined', rateLimiters.lifeContextSave, postSavedRefined);
router.get('/tokens', getTokens);
router.post('/tokens', createToken);
router.delete('/tokens/:id', deleteToken);

module.exports = router;
