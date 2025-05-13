const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { errorHandler } = require('./middlewares/errorMiddleware');

// 导入路由
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const assetRoutes = require('./routes/assetRoutes');
const activityRoutes = require('./routes/activityRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const dataDanceIdRoutes = require('./routes/dataDanceIdRoutes');
const web3AuthRoutes = require('./routes/web3AuthRoutes');
const passRoutes = require('./routes/passRoutes');
const passWebServiceRoutes = require('./routes/passWebServiceRoutes');
const googleWalletRoutes = require('./routes/googleWalletRoutes');
const tagRoutes = require('./routes/tagRoutes');
const nftMarketRoutes = require('./routes/nftMarketRoutes');
const snapshotRoutes = require('./routes/snapshotRoutes');
const dataNFTRoutes = require('./routes/dataNFTRoutes');

const app = express();

// CORS 配置
app.use(cors({
  origin: '*', // 允许所有来源访问
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// 设置请求超时时间为 5 分钟
app.use((req, res, next) => {
  req.setTimeout(300000); // 5分钟
  res.setTimeout(300000); // 5分钟
  next();
});

// 中间件
app.use(express.json());
app.use(morgan('dev'));

// 配置 MIME 类型
express.static.mime.define({'application/vnd.apple.pkpass': ['pkpass']});

// 静态文件服务
app.use('/assets', express.static(path.join(__dirname, '../public/assets'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.pkpass')) {
      res.set('Content-Type', 'application/vnd.apple.pkpass');
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
app.use('/api/assets/passes', passRoutes);
app.use('/v1', passWebServiceRoutes);
app.use('/api/google-wallet', googleWalletRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/nft-market', nftMarketRoutes);
app.use('/api/snapshots', snapshotRoutes);
app.use('/api/data-nfts', dataNFTRoutes);

// 错误处理中间件
app.use(errorHandler);

module.exports = app; 