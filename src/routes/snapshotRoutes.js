const express = require('express');
const router = express.Router();
const snapshotController = require('../controllers/snapshotController');
const { protect } = require('../middlewares/authMiddleware');

console.log('snapshotController:', snapshotController);

// Create a snapshot
router.post('/', protect, snapshotController.createSnapshot);

// Get all snapshots (with pagination and filters)
router.get('/', protect, snapshotController.getSnapshots);

// Get a specific snapshot
router.get('/:id', protect, snapshotController.getSnapshotById);

// Update a snapshot
router.put('/:id', protect, snapshotController.updateSnapshot);

// Delete a snapshot
router.delete('/:id', protect, snapshotController.deleteSnapshot);

// Get snapshots by activity
router.get('/activity/:activityId', protect, snapshotController.getSnapshotsByActivity);

// Get snapshots by merchant
router.get('/merchant/:merchantId', protect, snapshotController.getSnapshotsByMerchant);

module.exports = router; 