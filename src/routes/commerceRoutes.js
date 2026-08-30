const express = require('express');
const router = express.Router();
const commerceController = require('../controllers/commerceController');
const { authenticate, isOrganization } = require('../middlewares/auth');
const { uploadCommerceFile } = require('../middlewares/uploadMiddleware');

router.use(authenticate);
router.use(isOrganization);

router.get('/legal-entity', commerceController.getLegalEntity);
router.put('/legal-entity', commerceController.updateLegalEntity);
router.get('/counterparties', commerceController.listCounterparties);

router.get('/orders', commerceController.listOrders);
router.post('/orders', commerceController.createOrder);
router.get('/orders/:id', commerceController.getOrder);
router.post(
  '/orders/:id/contract',
  uploadCommerceFile.single('file'),
  commerceController.uploadContract,
);

router.get('/invoices', commerceController.listInvoices);
router.get('/invoices/:id', commerceController.getInvoice);
router.get('/invoices/:id/pdf', commerceController.downloadInvoicePdf);

router.get('/payments', commerceController.listPayments);
router.post('/payments', uploadCommerceFile.single('file'), commerceController.createPayment);
router.get('/payments/:id', commerceController.getPayment);
router.post('/payments/:id/confirm', commerceController.confirmPayment);
router.post('/payments/:id/reject', commerceController.rejectPayment);

router.get('/settings', commerceController.getSettings);
router.put('/settings', commerceController.updateSettings);

router.get('/allocations', commerceController.listAllocations);
router.post('/orders/:id/allocations', commerceController.addAllocations);
router.delete('/allocations/:id', commerceController.deleteAllocation);
router.post('/orders/:id/attest', commerceController.attestOrder);

router.get('/cost-items', commerceController.listCostItems);

router.get('/redemptions', commerceController.listRedemptions);
router.post('/redemptions', uploadCommerceFile.single('file'), commerceController.createRedemption);
router.post('/redemptions/:id/proof', uploadCommerceFile.single('file'), commerceController.attachRedemptionProof);
router.post('/redemptions/:id/confirm', commerceController.confirmRedemption);

module.exports = router;
