const express = require('express');
const router = express.Router();
const demandController = require('../controllers/demandController');
const { authenticate, isOrganization } = require('../middlewares/auth');

router.use(authenticate);
router.use(isOrganization);

router.get('/', demandController.list);
router.post('/', demandController.create);
router.get('/:id', demandController.get);
router.post('/:id/cancel', demandController.cancel);
router.post('/:id/accept', demandController.accept);

module.exports = router;
