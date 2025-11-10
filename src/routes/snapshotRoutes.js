const express = require('express');
const router = express.Router();
const snapshotController = require('../controllers/snapshotController');
const { protect } = require('../middlewares/authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

console.log('snapshotController:', snapshotController);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Create a snapshot from CSV upload (standalone data pack, no activity required)
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

router.post('/upload-csv', protect, upload.single('file'), snapshotController.createSnapshotFromCSV);

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