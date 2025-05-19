const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const apn = require('apn');
const path = require('path');

// 配置 APN
const apnProvider = new apn.Provider({
  token: {
    key: path.join(__dirname, '../../keys_fixed/apn_key.p8'),
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID
  },
  production: process.env.NODE_ENV === 'production',
  // 添加更多的配置选项
  debug: true,
  connectionRetryLimit: 3,
  gateway: process.env.NODE_ENV === 'production' 
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com'
});

console.log(
  '[APNs] 当前使用的服务器:',
  process.env.NODE_ENV === 'production'
    ? 'api.push.apple.com (Production)'
    : 'api.sandbox.push.apple.com (Sandbox)'
);

// 监听 APN Provider 的错误
apnProvider.on('error', (error) => {
  console.error('APN Provider Error:', error);
});

apnProvider.on('transmitted', (notification, device) => {
  console.log('Notification transmitted to:', device);
});

apnProvider.on('completed', (notification) => {
  console.log('Notification completed:', notification);
});

/**
 * 处理日志请求
 * @route POST /v1/passes/v1/log
 */
exports.logRequest = async (req, res) => {
  try {
    console.log('Apple Wallet Log:', req.body);
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('处理日志请求失败:', error);
    res.status(500).json({
      status: 'error',
      message: '处理日志请求失败'
    });
  }
};

/**
 * 设备注册
 * @route POST /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber
 */
exports.registerDevice = async (req, res) => {
  try {
    console.log('收到注册请求 - Headers:', req.headers);
    console.log('收到注册请求 - Body:', req.body);
    console.log('收到注册请求 - Params:', req.params);

    const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
    const { pushToken } = req.body;

    if (!pushToken) {
      console.log('请求中没有 pushToken');
      return res.status(400).json({
        status: 'error',
        message: 'Push token is required'
      });
    }

    console.log('设备注册请求:', {
      deviceLibraryIdentifier,
      passTypeIdentifier,
      serialNumber,
      pushToken
    });

    // 查找 pass
    const pass = await prisma.pass.findFirst({
      where: {
        serialNumber
      }
    });

    if (!pass) {
      console.log('未找到对应的 pass');
      return res.status(404).json({
        status: 'error',
        message: 'Pass not found'
      });
    }

    // 检查这个 pass 是否已经在其他设备上注册
    if (pass.pushToken && pass.pushToken !== pushToken) {
      console.log('Pass 已在其他设备上注册，更新为新设备');
    }

    // 更新当前 pass 的 pushToken
    const updatedPass = await prisma.pass.update({
      where: {
        id: pass.id
      },
      data: {
        pushToken,
        updatedAt: new Date()
      }
    });

    console.log('Pass 更新成功:', updatedPass);

    return res.status(200).json({
      status: 'success',
      message: 'Device registered successfully'
    });
  } catch (error) {
    console.error('设备注册失败:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

/**
 * 获取更新的 passes
 * @route GET /v1/passes/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier
 */
exports.getUpdatedPasses = async (req, res) => {
  try {
    const { deviceLibraryIdentifier, passTypeIdentifier } = req.params;
    const { passesUpdatedSince } = req.query;

    console.log('获取更新请求:', {
      deviceLibraryIdentifier,
      passTypeIdentifier,
      passesUpdatedSince
    });

    // 验证 passTypeIdentifier
    if (passTypeIdentifier !== 'pass.ai.datadance.app') {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid pass type identifier'
      });
    }

    // 构建查询条件
    const whereCondition = {
      pushToken: { not: null }
    };

    // 只有在提供了 passesUpdatedSince 时才添加时间过滤
    if (passesUpdatedSince) {
      try {
        const updateSinceDate = new Date(passesUpdatedSince);
        if (!isNaN(updateSinceDate.getTime())) {
          whereCondition.updatedAt = { gt: updateSinceDate };
        }
      } catch (error) {
        console.warn('无效的 passesUpdatedSince 参数:', passesUpdatedSince);
      }
    }

    // 查找需要更新的 passes
    const updatedPasses = await prisma.pass.findMany({
      where: whereCondition,
      select: {
        serialNumber: true,
        updatedAt: true
      }
    });

    console.log('找到的更新:', {
      count: updatedPasses.length,
      passes: updatedPasses
    });

    res.status(200).json({
      serialNumbers: updatedPasses.map(pass => pass.serialNumber),
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取更新失败:', error);
    res.status(500).json({
      status: 'error',
      message: '获取更新失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 获取 pass
 * @route GET /v1/passes/:passTypeIdentifier/:serialNumber
 */
exports.getPass = async (req, res) => {
  try {
    const { passTypeIdentifier, serialNumber } = req.params;
    console.log('获取 Pass 请求:', { passTypeIdentifier, serialNumber });

    // 验证 passTypeIdentifier
    if (passTypeIdentifier !== 'pass.ai.datadance.app') {
      console.log('无效的 passTypeIdentifier:', passTypeIdentifier);
      return res.status(401).json({
        status: 'error',
        message: 'Invalid pass type identifier'
      });
    }

    // 查找 pass
    const pass = await prisma.pass.findFirst({
      where: {
        serialNumber
      }
    });

    if (!pass) {
      console.log('未找到 Pass:', serialNumber);
      return res.status(404).json({
        status: 'error',
        message: 'Pass not found'
      });
    }

    console.log('找到 Pass，准备发送文件:', pass.passUrl);

    // 返回 pass 文件
    const filePath = path.join(__dirname, `../../public${pass.passUrl}`);
    console.log('完整文件路径:', filePath);
    
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('发送文件失败:', err);
        res.status(500).json({
          status: 'error',
          message: '发送 Pass 文件失败'
        });
      } else {
        console.log('Pass 文件发送成功');
        // 不再立即删除 pass 文件，交由定时删除逻辑处理
      }
    });
  } catch (error) {
    console.error('获取 pass 失败:', error);
    res.status(500).json({
      status: 'error',
      message: '获取 pass 失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 注销设备
 * @route DELETE /v1/passes/:passTypeIdentifier/passes/:serialNumber/registration/:deviceLibraryIdentifier
 */
exports.unregisterDevice = async (req, res) => {
  try {
    const { passTypeIdentifier, serialNumber, deviceLibraryIdentifier } = req.params;

    // 验证 passTypeIdentifier
    if (passTypeIdentifier !== 'pass.ai.datadance.app') {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid pass type identifier'
      });
    }

    // 查找并更新 pass
    const pass = await prisma.pass.findFirst({
      where: {
        serialNumber
      }
    });

    if (pass) {
      await prisma.pass.update({
        where: {
          id: pass.id
        },
        data: {
          pushToken: null
        }
      });
    }

    res.status(200).json({
      status: 'success'
    });
  } catch (error) {
    console.error('注销设备失败:', error);
    res.status(500).json({
      status: 'error',
      message: '注销设备失败'
    });
  }
};

/**
 * 发送推送通知
 */
exports.sendPushNotification = async (pushToken, passTypeIdentifier, serialNumber, options = {}) => {
  try {
    console.log('准备发送推送通知:', {
      pushToken,
      passTypeIdentifier,
      serialNumber,
      options
    });

    if (!pushToken) {
      console.log('没有 pushToken，跳过推送');
      return;
    }

    const notification = new apn.Notification();
    
    // 设置通知主题
    notification.topic = passTypeIdentifier;
    
    // 设置通知内容
    notification.alert = {
      title: options.title || 'Pass 更新通知',
      body: options.message || 'Your pass has been updated'
    };
    
    // 设置声音
    notification.sound = "default";
    
    // 设置自定义数据
    notification.payload = {
      'aps': {
        'alert': notification.alert,
        'sound': notification.sound
      },
      'serialNumber': serialNumber,
      'type': options.type || 'pass_update',
      'data': options.data || {}
    };

    console.log('发送推送通知:', {
      notification,
      pushToken
    });

    const result = await apnProvider.send(notification, pushToken);
    console.log('推送结果:', result);

    if (result.failed.length > 0) {
      console.error('推送失败:', result.failed[0].response);
    }

    return result;
  } catch (error) {
    console.error('发送推送通知失败:', error);
    throw error;
  }
};

/**
 * 更新 Pass 并发送推送通知
 */
exports.updatePassAndNotify = async (passId, updateData, notificationOptions = {}) => {
  try {
    // 更新 pass
    const updatedPass = await prisma.pass.update({
      where: {
        id: passId
      },
      data: updateData
    });

    // 如果有 pushToken，发送推送通知
    if (updatedPass.pushToken) {
      await exports.sendPushNotification(
        updatedPass.pushToken, 
        updatedPass.passTypeIdentifier, 
        updatedPass.serialNumber,
        notificationOptions
      );
    }

    return updatedPass;
  } catch (error) {
    console.error('更新 Pass 并发送通知失败:', error);
    throw error;
  }
}; 