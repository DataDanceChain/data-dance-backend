const express = require('express');
const { 
  getOrCreateDataDanceID, 
  getUserDataDanceIDs, 
  getDataDanceID, 
  revokeDataDanceID, 
  verifyDataDanceID 
} = require('../controllers/dataDanceIdController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// 公共路由
router.post('/verify', verifyDataDanceID);

// 需要认证的路由
router.use(protect);
router.post('/', getOrCreateDataDanceID);
router.get('/', getUserDataDanceIDs);
router.get('/:id', getDataDanceID);
router.patch('/:id/revoke', revokeDataDanceID);

module.exports = router; 