const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
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

const app = express();

// CORS configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:8100',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
};

// 中间件
app.use(cors(corsOptions));
app.use(express.json());
app.use(morgan('dev'));

// Add request logging
const logger = createLogger('app');
app.use(logger.requestLogger);

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
app.use('/api/x', xRoutes); // Updated usage

// 错误处理中间件
app.use(errorHandler);

// Add error logging
app.use(logger.errorLogger);

module.exports = app;