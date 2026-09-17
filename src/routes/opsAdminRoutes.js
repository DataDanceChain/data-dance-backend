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
const opsCampaigns = require('../controllers/opsCampaignController');

const router = express.Router();

router.post('/auth/login', login);
router.use(protectOps);
router.get('/campaigns', opsCampaigns.list);
router.post('/campaigns/translate', opsCampaigns.translate);
router.post('/campaigns', opsCampaigns.create);
router.get('/campaigns/:id', opsCampaigns.get);
router.patch('/campaigns/:id', opsCampaigns.update);
router.post('/campaigns/:id/transition', opsCampaigns.transition);
router.get('/campaigns/:id/applications', opsCampaigns.listApplications);
router.post('/campaigns/:id/applications/:appId', opsCampaigns.resolveApplication);
router.get('/campaigns/:id/raffle', opsCampaigns.raffleState);
router.post('/campaigns/:id/raffle/draw', opsCampaigns.drawRaffle);
router.post('/campaigns/:id/raffle/wins/:winId/fulfill', opsCampaigns.fulfillRaffleWin);
router.get('/overview', opsCommerce.overview);
router.get('/payments', opsCommerce.listPayments);
router.post('/payments/:id/confirm', opsCommerce.confirmPayment);
router.post('/payments/:id/reject', opsCommerce.rejectPayment);
router.get('/merchants', opsCommerce.listMerchants);
router.get('/merchants/:userId', opsCommerce.getMerchant);
router.post('/merchants/:userId/credit', opsCommerce.creditMerchant);
router.post('/merchants/:userId/kyc', opsCommerce.reviewMerchantKyc);
if (typeof opsCommerce.listOrders === 'function') {
  router.get('/orders', opsCommerce.listOrders);
}
if (typeof opsCommerce.attestOrder === 'function') {
  router.post('/orders/:id/attest', opsCommerce.attestOrder);
}
router.get('/privacy-requests', listPrivacyRequests);
router.post('/privacy-requests/:id', resolvePrivacyRequest);
router.get('/operations', listOperations);
router.get('/users/search', searchUsers);
router.get('/users/:userId/points/history', getUserPointHistory);
router.get('/users/:userId', getUserDetail);
router.post('/users/:userId/points', adjustPoints);

module.exports = router;
