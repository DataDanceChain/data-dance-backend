const express = require('express');
const {
  login,
  searchUsers,
  getUserDetail,
  adjustPoints,
  listOperations,
  getUserPointHistory,
  listPoints,
  exportPoints,
} = require('../controllers/opsAdminController');
const opsCommerce = require('../controllers/opsCommerceController');
const {
  listPrivacyRequests,
  resolvePrivacyRequest,
} = require('../controllers/opsPrivacyController');
const { protectOps } = require('../middlewares/opsAuthMiddleware');
const opsCampaigns = require('../controllers/opsCampaignController');

let opsTranslate = {};
try {
  opsTranslate = require('../controllers/opsCampaignTranslate');
} catch {
  opsTranslate = {};
}

const router = express.Router();

function mount(method, path, handler) {
  if (typeof handler === 'function') {
    router[method](path, handler);
  }
}

router.post('/auth/login', login);
router.use(protectOps);
mount('get', '/campaigns', opsCampaigns.list);
mount('post', '/campaigns/translate', opsCampaigns.translate || opsTranslate.translate);
mount('post', '/campaigns', opsCampaigns.create);
mount('get', '/campaigns/:id', opsCampaigns.get);
mount('patch', '/campaigns/:id', opsCampaigns.update);
mount('post', '/campaigns/:id/transition', opsCampaigns.transition);
mount('get', '/campaigns/:id/applications', opsCampaigns.listApplications);
mount('post', '/campaigns/:id/applications/:appId', opsCampaigns.resolveApplication);
mount('get', '/campaigns/:id/raffle', opsCampaigns.raffleState);
mount('post', '/campaigns/:id/raffle/draw', opsCampaigns.drawRaffle);
mount('post', '/campaigns/:id/raffle/wins/:winId/fulfill', opsCampaigns.fulfillRaffleWin);
mount('get', '/overview', opsCommerce.overview);
mount('get', '/payments', opsCommerce.listPayments);
mount('post', '/payments/:id/confirm', opsCommerce.confirmPayment);
mount('post', '/payments/:id/reject', opsCommerce.rejectPayment);
mount('get', '/merchants', opsCommerce.listMerchants);
mount('get', '/merchants/:userId', opsCommerce.getMerchant);
mount('post', '/merchants/:userId/credit', opsCommerce.creditMerchant);
mount('post', '/merchants/:userId/kyc', opsCommerce.reviewMerchantKyc);
mount('get', '/orders', opsCommerce.listOrders);
mount('post', '/orders/:id/attest', opsCommerce.attestOrder);
mount('get', '/privacy-requests', listPrivacyRequests);
mount('post', '/privacy-requests/:id', resolvePrivacyRequest);
mount('get', '/operations', listOperations);
mount('get', '/points/export', exportPoints);
mount('get', '/points', listPoints);
mount('get', '/users/search', searchUsers);
mount('get', '/users/:userId/points/history', getUserPointHistory);
mount('get', '/users/:userId', getUserDetail);
mount('post', '/users/:userId/points', adjustPoints);

module.exports = router;
