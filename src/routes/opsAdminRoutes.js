const express = require('express');
const {
  login,
  searchUsers,
  getUserDetail,
  adjustPoints,
  listOperations,
  getUserPointHistory,
} = require('../controllers/opsAdminController');
const opsCommerce = require('../controllers/opsCommerceController');
const {
  listPrivacyRequests,
  resolvePrivacyRequest,
} = require('../controllers/opsPrivacyController');
const { protectOps } = require('../middlewares/opsAuthMiddleware');

const router = express.Router();

router.post('/auth/login', login);
router.use(protectOps);
router.get('/overview', opsCommerce.overview);
router.get('/payments', opsCommerce.listPayments);
router.post('/payments/:id/confirm', opsCommerce.confirmPayment);
router.post('/payments/:id/reject', opsCommerce.rejectPayment);
router.get('/merchants', opsCommerce.listMerchants);
router.get('/merchants/:userId', opsCommerce.getMerchant);
router.post('/merchants/:userId/credit', opsCommerce.creditMerchant);
router.post('/merchants/:userId/kyc', opsCommerce.reviewMerchantKyc);
router.get('/privacy-requests', listPrivacyRequests);
router.post('/privacy-requests/:id', resolvePrivacyRequest);
router.get('/operations', listOperations);
router.get('/users/search', searchUsers);
router.get('/users/:userId/points/history', getUserPointHistory);
router.get('/users/:userId', getUserDetail);
router.post('/users/:userId/points', adjustPoints);

module.exports = router;
