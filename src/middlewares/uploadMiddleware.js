const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 确保目标目录存在
const nftDir = path.join(__dirname, '../../public/assets/nfts');
if (!fs.existsSync(nftDir)) {
  fs.mkdirSync(nftDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, nftDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, basename + '-' + uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  // 只允许图片类型
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
};

const uploadNFTImage = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

const commerceDirs = {
  contracts: path.join(__dirname, '../../public/assets/commerce/contracts'),
  slips: path.join(__dirname, '../../public/assets/commerce/slips'),
  invoices: path.join(__dirname, '../../public/assets/commerce/invoices'),
};

Object.values(commerceDirs).forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const commerceStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const folder = req.path.includes('/contract') ? 'contracts' : 'slips';
    cb(null, commerceDirs[folder]);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${req.user?.id || 'org'}-${uniqueSuffix}${ext}`);
  }
});

const commerceFileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF or image files are allowed'), false);
  }
};

const uploadCommerceFile = multer({
  storage: commerceStorage,
  fileFilter: commerceFileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }
});

const campaignCoverDir = path.join(__dirname, '../../public/assets/campaigns');
if (!fs.existsSync(campaignCoverDir)) {
  fs.mkdirSync(campaignCoverDir, { recursive: true });
}

const COVER_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const campaignCoverStorage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, campaignCoverDir);
  },
  filename: function (_req, file, cb) {
    const ext = COVER_EXT[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.jpg';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `cover-${uniqueSuffix}${ext}`);
  },
});

const campaignCoverFilter = (req, file, cb) => {
  if (COVER_EXT[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, WebP, or GIF images are allowed'), false);
  }
};

const uploadCampaignCover = multer({
  storage: campaignCoverStorage,
  fileFilter: campaignCoverFilter,
  limits: { fileSize: 8 * 1024 * 1024 },
});

module.exports = { uploadNFTImage, uploadCommerceFile, uploadCampaignCover }; 