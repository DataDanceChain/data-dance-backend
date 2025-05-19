const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const apn = require('apn');
const path = require('path');
require('dotenv').config();

// 验证环境变量
const requiredEnvVars = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'PASS_TYPE_ID'];
console.log(process.env.APNS_KEY_ID,process.env.APNS_TEAM_ID,process.env.PASS_TYPE_ID);
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`错误: 缺少必要的环境变量 ${envVar}`);
    process.exit(1);
  }
}

console.log('环境配置:', {
  NODE_ENV: process.env.NODE_ENV,
  PASS_TYPE_ID: process.env.PASS_TYPE_ID,
  APNS_KEY_ID: process.env.APNS_KEY_ID,
  APNS_TEAM_ID: process.env.APNS_TEAM_ID,
  isProduction: process.env.NODE_ENV === 'production'
});

// 配置 APN Provider
const apnProvider = new apn.Provider({
  token: {
    key: path.join(__dirname, '../keys_fixed/apn_key.p8'),
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID
  },
  production: process.env.NODE_ENV === 'production',
  requestTimeout: 10000, // 10 seconds timeout
  connectionTimeout: 10000 // 10 seconds timeout
});

console.log(
  '[APNs] 当前使用的服务器:',
  process.env.NODE_ENV === 'production'
    ? 'api.push.apple.com (Production)'
    : 'api.sandbox.push.apple.com (Sandbox)'
);

// 添加错误处理
apnProvider.on('error', (error) => {
  console.error('APN Provider Error:', error);
});

apnProvider.on('socketError', (error) => {
  console.error('APN Socket Error:', error);
});

async function sendTestNotification() {
  try {
    const serialNumber = '1645d74f-aa0f-42ac-8c44-481eed58f27c';
    const pushToken = '82972be85a9ccd3ec8829baafbf17cb10c107f897578647dfe90027e335adc19';

    // 验证设备令牌格式
    if (!/^[a-f0-9]{64}$/.test(pushToken)) {
      throw new Error('Invalid device token format');
    }

    // 创建通知
    const notification = new apn.Notification();
    
    // 设置通知内容
    notification.alert = {
      title: "Pass 更新测试",
      body: "这是一条测试推送通知"
    };
    
    // 设置声音和角标
    notification.sound = "default";
    notification.badge = 1;
    
    // 设置自定义数据
    notification.payload = {
      type: "pass_update",
      serialNumber: serialNumber
    };

    // 设置推送主题（使用环境变量）
    notification.topic = process.env.PASS_TYPE_ID;

    console.log('准备发送推送通知:', {
      serialNumber,
      pushToken,
      notification: {
        alert: notification.alert,
        payload: notification.payload,
        topic: notification.topic
      },
      tokenLength: pushToken.length,
      providerConfig: {
        keyId: process.env.APNS_KEY_ID,
        teamId: process.env.APNS_TEAM_ID,
        isProduction: process.env.NODE_ENV === 'production'
      }
    });

    // 发送通知
    const result = await apnProvider.send(notification, pushToken);
    
    console.log('推送结果:', {
      sent: result.sent.length,
      failed: result.failed.length
    });

    if (result.failed.length > 0) {
      console.error('推送失败详情:', {
        error: result.failed[0].response,
        status: result.failed[0].status,
        reason: result.failed[0].reason,
        device: result.failed[0].device
      });
    }

    // 关闭 Provider
    await apnProvider.shutdown();
    
    // 关闭 Prisma
    await prisma.$disconnect();
  } catch (error) {
    console.error('发送通知时出错:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    
    // 确保关闭连接
    try {
      await apnProvider.shutdown();
      await prisma.$disconnect();
    } catch (e) {
      console.error('关闭连接时出错:', e);
    }
    
    process.exit(1);
  }
}

// 运行测试
console.log('开始发送测试通知...');
sendTestNotification()
  .then(() => {
    console.log('测试完成');
    process.exit(0);
  })
  .catch(error => {
    console.error('测试失败:', error);
    process.exit(1);
  }); 