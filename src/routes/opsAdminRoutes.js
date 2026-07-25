const express = require('express');
const {
  login,
  searchUsers,
  getUserDetail,
  adjustPoints,
  listOperations,
  getUserPointHistory,
} = require('../controllers/opsAdminController');
const { protectOps } = require('../middlewares/opsAuthMiddleware');

const router = express.Router();

router.post('/auth/login', login);
router.use(protectOps);
router.get('/operations', listOperations);
router.get('/users/search', searchUsers);
router.get('/users/:userId/points/history', getUserPointHistory);
router.get('/users/:userId', getUserDetail);
router.post('/users/:userId/points', adjustPoints);

module.exports = router;
