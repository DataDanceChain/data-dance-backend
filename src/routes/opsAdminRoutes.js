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
const opsAccess = require('../controllers/opsAccessController');
const opsCommerce = require('../controllers/opsCommerceController');
const opsDemands = require('../controllers/opsDemandController');
const disbursement = require('../controllers/disbursementController');
const {
  listPrivacyRequests,
  resolvePrivacyRequest,
} = require('../controllers/opsPrivacyController');
const { protectOps, restrictDemo, requireOps } = require('../middlewares/opsAuthMiddleware');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { uploadCampaignCover } = require('../middlewares/uploadMiddleware');
const { auditOpsWrites } = require('../services/opsAudit');
const { listSsoClients } = require('../services/ssoDeveloperLive');
const opsCampaigns = require('../controllers/opsCampaignController');
const trackedLinks = require('../controllers/trackedLinkController');

let opsTranslate = {};
try {
  opsTranslate = require('../controllers/opsCampaignTranslate');
} catch {
  opsTranslate = {};
}

const router = express.Router();

/** Every mounted route as { method, path, permission } (tests walk it against router.stack). */
const opsRoutes = [];

/** The matched route and its params, for the generic audit row (services/opsAudit.js). */
function noteRoute(req, res, next) {
  req.opsRoute = { baseUrl: req.baseUrl, path: req.route && req.route.path, params: { ...req.params } };
  return next();
}

/**
 * Every ops route declares exactly one permission (src/constants/opsRoles.js); a missing or
 * unknown one throws at load. Handlers that are not all functions (an optional controller that is
 * absent from this build) leave the route unmounted, as before.
 */
function mount(method, path, permission, ...handlers) {
  const guard = requireOps(permission);
  if (handlers.length && handlers.every((handler) => typeof handler === 'function')) {
    router[method](path, guard, noteRoute, ...handlers);
    opsRoutes.push({ method, path, permission });
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

async function listClients(req, res) {
  try {
    const result = await listSsoClients();
    return res.json({ status: 'success', data: result });
  } catch (error) {
    console.error('SSO client list failed', error && error.name);
    return res.status(500).json({ status: 'fail', message: 'Could not list SSO clients.' });
  }
}

// Sign-in: the only routes without an ops session.
router.post('/auth/login', rateLimiters.opsLogin, login);
// A DataDance account's wallet JWT mints a one-time code for the ops site (the developer console calls it).
router.post('/auth/code', protect, rateLimiters.opsSignInCode, opsAccess.createSignInCode);
router.post('/auth/exchange', rateLimiters.opsLogin, opsAccess.exchangeSignInCode);

router.use(protectOps);
router.use(restrictDemo);
router.use(auditOpsWrites);

mount('get', '/auth/me', 'ops.read', opsAccess.me);
mount('get', '/links', 'ops.read', trackedLinks.list);
mount('post', '/links', 'ops.write', trackedLinks.create);
mount('get', '/links/:id', 'ops.read', trackedLinks.detail);
mount('patch', '/links/:id', 'ops.write', trackedLinks.update);
mount('get', '/campaigns', 'ops.read', opsCampaigns.list);
mount('post', '/campaigns/translate', 'ops.write', opsCampaigns.translate || opsTranslate.translate);
mount('post', '/campaigns/cover', 'ops.write', acceptCampaignCover, opsCampaigns.uploadCover);
mount('post', '/campaigns', 'ops.write', opsCampaigns.create);
mount('get', '/campaigns/:id', 'ops.read', opsCampaigns.get);
mount('patch', '/campaigns/:id', 'ops.write', opsCampaigns.update);
mount('post', '/campaigns/:id/transition', 'ops.write', opsCampaigns.transition);
mount('get', '/campaigns/:id/applications', 'ops.read', opsCampaigns.listApplications);
mount('post', '/campaigns/:id/applications/:appId', 'ops.write', opsCampaigns.resolveApplication);
mount('get', '/campaigns/:id/raffle', 'ops.read', opsCampaigns.raffleState);
mount('post', '/campaigns/:id/raffle/draw', 'ops.write', opsCampaigns.drawRaffle);
mount('post', '/campaigns/:id/raffle/wins/:winId/fulfill', 'ops.write', opsCampaigns.fulfillRaffleWin);
mount('get', '/demands', 'ops.read', opsDemands.list);
mount('get', '/demands/:id', 'ops.read', opsDemands.get);
mount('post', '/demands/:id/quote', 'ops.write', opsDemands.quote);
mount('post', '/demands/:id/decline', 'ops.write', opsDemands.decline);
mount('post', '/demands/:id/assemble', 'ops.write', opsDemands.assemble);
mount('post', '/demands/:id/fulfill', 'ops.write', opsDemands.fulfill);
mount('get', '/overview', 'ops.read', opsCommerce.overview);
mount('get', '/payments', 'ops.read', opsCommerce.listPayments);
mount('post', '/payments/:id/confirm', 'ops.write', opsCommerce.confirmPayment);
mount('post', '/payments/:id/reject', 'ops.write', opsCommerce.rejectPayment);
mount('get', '/merchants', 'ops.read', opsCommerce.listMerchants);
mount('get', '/merchants/:userId', 'ops.read', opsCommerce.getMerchant);
mount('post', '/merchants/:userId/credit', 'ops.write', opsCommerce.creditMerchant);
mount('post', '/merchants/:userId/kyc', 'ops.write', opsCommerce.reviewMerchantKyc);
mount('get', '/orders', 'ops.read', opsCommerce.listOrders);
mount('get', '/orders/:id', 'ops.read', opsCommerce.getOrder);
mount('post', '/orders/:id/attest', 'ops.write', opsCommerce.attestOrder);
mount('get', '/disbursements', 'ops.read', disbursement.opsList);
mount('post', '/disbursements/items/:id/process', 'ops.payouts', disbursement.opsRetry);
mount('post', '/disbursements/redemptions/:id/disburse', 'ops.payouts', disbursement.opsDisburse);
mount('get', '/privacy-requests', 'ops.read', listPrivacyRequests);
mount('post', '/privacy-requests/:id', 'ops.write', resolvePrivacyRequest);
mount('get', '/operations', 'ops.read', listOperations);
mount('get', '/points/export', 'ops.read', exportPoints);
mount('get', '/points', 'ops.read', listPoints);
mount('get', '/users/search', 'ops.read', searchUsers);
mount('get', '/users/:userId/points/history', 'ops.read', getUserPointHistory);
mount('get', '/users/:userId', 'ops.read', getUserDetail);
mount('post', '/users/:userId/points', 'ops.write', adjustPoints);
mount('post', '/users/:userId/roles', 'ops.admin', opsAccess.grantRole);
mount('post', '/users/:userId/roles/:role/revoke', 'ops.admin', opsAccess.revokeRole);
mount('post', '/users/:userId/disable', 'ops.admin', opsAccess.disableUser);
mount('post', '/users/:userId/enable', 'ops.admin', opsAccess.enableUser);
mount('get', '/roles', 'ops.admin', opsAccess.listRoles);
mount('get', '/audit', 'ops.admin', opsAccess.listAudit);
mount('get', '/identity-conflicts', 'ops.support', opsAccess.listIdentityConflicts);
mount('get', '/sso/clients', 'ops.read', listClients);
mount('post', '/sso/planet-manager', 'ops.admin', opsAccess.assignPlanetManager);

module.exports = router;
module.exports.opsRoutes = opsRoutes;
