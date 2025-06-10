const express = require('express');
const passRoutes = require('./passRoutes');
const transactionRoutes = require('./transactionRoutes');

const setupRoutes = (app) => {
  // API 路由前缀
  app.use('/api/assets/passes', passRoutes);
  app.use('/api/transactions', transactionRoutes);
  app.use('/api/organization/transactions', transactionRoutes);
};

module.exports = setupRoutes; 