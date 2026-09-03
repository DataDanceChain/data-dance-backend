const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const {
  getStatus,
  updateSettings,
  getTokens,
  createToken,
  deleteToken,
  postRefine,
  postSavedRefined,
} = require('../controllers/lifeContextController');

const router = express.Router();

router.use(protect);
router.get('/', getStatus);
router.patch('/settings', updateSettings);
router.post('/refine', postRefine);
router.post('/refined', postSavedRefined);
router.get('/tokens', getTokens);
router.post('/tokens', createToken);
router.delete('/tokens/:id', deleteToken);

module.exports = router;
