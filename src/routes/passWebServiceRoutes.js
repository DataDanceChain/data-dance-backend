const express = require('express');
const router = express.Router();
const passWebServiceController = require('../controllers/passWebServiceController');

// 设备注册 - Apple 标准路径
router.post('/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', passWebServiceController.registerDevice);

// 获取更新的 passes - Apple 标准路径
router.get('/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier', passWebServiceController.getUpdatedPasses);

// 获取 pass - Apple 标准路径
router.get('/passes/:passTypeIdentifier/:serialNumber', passWebServiceController.getPass);

// 注销设备 - Apple 标准路径
router.delete('/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', passWebServiceController.unregisterDevice);

// 处理日志 - Apple 标准路径
router.post('/log', passWebServiceController.logRequest);

module.exports = router; 