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
const disbursement = require('../controllers/disbursementController');
const {
  listPrivacyRequests,
  resolvePrivacyRequest,
} = require('../controllers/opsPrivacyController');
const { protectOps, restrictDemo } = require('../middlewares/opsAuthMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { uploadCampaignCover } = require('../middlewares/uploadMiddleware');
const opsCampaigns = require('../controllers/opsCampaignController');

let opsTranslate = {};
try {
  opsTranslate = require('../controllers/opsCampaignTranslate');
} catch {
  opsTranslate = {};
}

const router = express.Router();

function mount(method, path, ...handlers) {
  if (handlers.length && handlers.every((handler) => typeof handler === 'function')) {
    router[method](path, ...handlers);
  }
}

function acceptCampaignCover(req, res, next) {
  uploadCampaignCover.single('image')(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Cover image must be 8 MB or smaller'
        : err.message || 'Could not upload that image';
    return res.status(400).json({ status: 'fail', message });
  });
}

router.post('/auth/login', rateLimiters.opsLogin, login);
router.use(protectOps);
router.use(restrictDemo);
mount('get', '/campaigns', opsCampaigns.list);
mount('post', '/campaigns/translate', opsCampaigns.translate || opsTranslate.translate);
mount('post', '/campaigns/cover', acceptCampaignCover, opsCampaigns.uploadCover);
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
mount('get', '/orders/:id', opsCommerce.getOrder);
mount('post', '/orders/:id/attest', opsCommerce.attestOrder);
mount('get', '/disbursements', disbursement.opsList);
mount('post', '/disbursements/items/:id/process', disbursement.opsRetry);
mount('post', '/disbursements/redemptions/:id/disburse', disbursement.opsDisburse);
mount('get', '/privacy-requests', listPrivacyRequests);
mount('post', '/privacy-requests/:id', resolvePrivacyRequest);
mount('get', '/operations', listOperations);
mount('get', '/points/export', exportPoints);
mount('get', '/points', listPoints);
mount('get', '/users/search', searchUsers);
mount('get', '/users/:userId/points/history', getUserPointHistory);
mount('get', '/users/:userId', getUserDetail);
mount('post', '/users/:userId/points', adjustPoints);

const { grantPlanetManager } = require('../services/ssoDeveloperLive');
router.post('/sso/planet-manager', async (req, res) => {
  try {
    const result = await grantPlanetManager(req.body && req.body.email);
    return res.json({ status: 'success', data: result });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('Planet manager assignment failed', error && error.message);
    return res.status(status).json({
      status: 'fail',
      message: status >= 500 ? 'Could not assign the manager.' : error.message,
    });
  }
});

module.exports = router;
