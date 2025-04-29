const express = require('express');
const passRoutes = require('./passRoutes');

const setupRoutes = (app) => {
  // API 路由前缀
  app.use('/api/assets/passes', passRoutes);
};

module.exports = setupRoutes; 