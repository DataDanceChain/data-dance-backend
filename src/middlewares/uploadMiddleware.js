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
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

module.exports = { uploadNFTImage }; 