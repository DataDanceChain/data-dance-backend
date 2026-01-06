const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { errorHandler } = require('./middlewares/errorMiddleware');
const xRoutes = require('./routes/xRoutes'); // Updated import
const { createLogger } = require('./utils/logger');

// 导入路由
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const assetRoutes = require('./routes/assetRoutes');
const activityRoutes = require('./routes/activityRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const dataDanceIdRoutes = require('./routes/dataDanceIdRoutes');
const web3AuthRoutes = require('./routes/web3AuthRoutes');
const awardRoutes = require('./routes/awardRoutes');
const taskRoutes = require('./routes/taskRoutes');
const referralRoutes = require('./routes/referralRoutes');
const passRoutes = require('./routes/passRoutes');
const passWebServiceRoutes = require('./routes/passWebServiceRoutes');
const googleWalletRoutes = require('./routes/googleWalletRoutes');
const crawlerRoutes = require('./routes/crawlerRoutes');
const tagRoutes = require('./routes/tagRoutes');
const nftMarketRoutes = require('./routes/nftMarketRoutes');
const snapshotRoutes = require('./routes/snapshotRoutes');
const dataNFTRoutes = require('./routes/dataNFTRoutes');
const promotionRoutes = require('./routes/promotionRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const ddcNFTMetadataRoutes = require('./routes/ddcNFTMetadataRoutes');

const app = express();

// 确保上传目录存在
const publicDir = path.join(__dirname, '../public');
const bannerDir = path.join(publicDir, 'assets/banners');
const nftDir = path.join(publicDir, 'assets/nfts');
const dataPackDir = path.join(publicDir, 'data-pack');

[publicDir, bannerDir, nftDir, dataPackDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// 配置文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // 根据字段名决定存储目录
    const dest = file.fieldname === 'banner' ? bannerDir : nftDir;
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// 创建 multer 实例
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 20 * 1024 * 1024 // 限制20MB
  }
});

// 将 multer 实例添加到 app 对象中，以便路由可以使用
app.set('upload', upload);

// CORS 配置
const corsOptions = {
  origin: process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? '*' : 'http://localhost:8100'),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
};

// 中间件 - 生产环境也需要 CORS
app.use(cors(corsOptions));
app.use(express.json({ limit: '20mb' }));
app.use(morgan('dev'));

// Add request logging
const logger = createLogger('app');
app.use(logger.requestLogger);

// 设置请求超时时间为 5 分钟
app.use((req, res, next) => {
  req.setTimeout(300000); // 5分钟
  res.setTimeout(300000); // 5分钟
  next();
});

// 添加 urlencoded 中间件支持
app.use(express.urlencoded({ extended: true }));

// 配置 MIME 类型
express.static.mime.define({ 'application/vnd.apple.pkpass': ['pkpass'] });

// 静态文件服务 - Assets (avatars, logos, banners, nfts, etc.)
app.use('/assets', express.static(path.join(__dirname, '../public/assets'), {
  setHeaders: (res, filePath) => {
    // Apple Wallet pass 文件
    if (filePath.endsWith('.pkpass')) {
      res.set('Content-Type', 'application/vnd.apple.pkpass');
    }
    // 图片文件设置缓存和 MIME 类型
    else if (filePath.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i)) {
      // 设置缓存头（图片文件可以缓存）
      res.set('Cache-Control', 'public, max-age=31536000'); // 1年
      // Express static 会自动设置正确的 MIME 类型
    }
    // SVG 图标文件
    else if (filePath.endsWith('.svg')) {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=31536000'); // 1年
    }
  }
}));

// 静态文件服务 - Data Pack Images
app.use('/data-pack', express.static(path.join(__dirname, '../public/data-pack'), {
  setHeaders: (res, filePath) => {
    // 确保 SVG 文件返回正确的 MIME 类型
    if (filePath.endsWith('.svg')) {
      res.set('Content-Type', 'image/svg+xml');
      // 设置缓存头（可选，SVG 文件通常可以缓存）
      res.set('Cache-Control', 'public, max-age=31536000'); // 1年
    }
  }
}));

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/data-dance-ids', dataDanceIdRoutes);
app.use('/api/auth', web3AuthRoutes);
// 调整 awardRoutes 和 taskRoutes 的挂载路径
app.use('/api', awardRoutes);
app.use('/api', taskRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/x', xRoutes);
app.use('/api/assets/passes', passRoutes);
app.use('/v1', passWebServiceRoutes);
app.use('/api/google-wallet', googleWalletRoutes);
app.use('/api', crawlerRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/nft-market', nftMarketRoutes);
app.use('/api/snapshots', snapshotRoutes);
app.use('/api/data-nfts', dataNFTRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/organization/transactions', transactionRoutes);
// DDC NFT Metadata API - 需要后端权限控制
app.use('/metadata/ddcnft', ddcNFTMetadataRoutes);

// Add error logging (must be before errorHandler)
app.use(logger.errorLogger);

// 错误处理中间件 (must be last)
app.use(errorHandler);

module.exports = app;