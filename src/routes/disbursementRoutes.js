const express = require('express');
const disbursement = require('../controllers/disbursementController');

const router = express.Router();

router.post('/:slug/batches', disbursement.requirePartnerKey, disbursement.submitBatch);
router.get('/:slug/items/:payoutId', disbursement.requirePartnerKey, disbursement.showItem);
router.post('/:slug/items/:payoutId/process', disbursement.requirePartnerKey, disbursement.retryItem);

module.exports = router;
