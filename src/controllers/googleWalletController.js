const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();
const { google } = require('googleapis');

// Node.js 18+ 有全局 fetch，否则用 node-fetch polyfill
let fetchFn;
try {
  fetchFn = global.fetch || require('node-fetch');
} catch (e) {
  fetchFn = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
}
const googleWalletUtils = require('../utils/googleWalletUtils');

const WALLET_API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';

/**
 * Google Wallet Web Service 接口
 * 处理 Google Wallet 的更新请求
 */
exports.handleGoogleWalletWebService = async (req, res) => {
  try {
    const { objectId, classId } = req.params;
    const jwt = req.headers.authorization?.split(' ')[1];

    if (!jwt) {
      return res.status(401).json({
        status: 'error',
        message: 'Missing JWT'
      });
    }

    // 验证 JWT
    const decoded = googleWalletUtils.verifyJWT(jwt);

    // 查找对应的 Pass 记录
    const pass = await prisma.pass.findFirst({
      where: {
        googleObjectId: objectId,
        googleClassId: classId,
        platform: 'google'
      }
    });

    if (!pass) {
      return res.status(404).json({
        status: 'error',
        message: 'Pass not found'
      });
    }

    // 检查 Pass 状态
    if (pass.status !== 'active') {
      return res.status(403).json({
        status: 'error',
        message: 'Pass is not active'
      });
    }

    // 返回 Pass 数据
    res.status(200).json({
      id: `${process.env.GOOGLE_WALLET_ISSUER_ID}.${pass.googleObjectId}`,
      classId: `${process.env.GOOGLE_WALLET_ISSUER_ID}.${pass.googleClassId}`,
      state: 'active',
      barcode: {
        type: 'QR_CODE',
        value: pass.userWalletAddress
      },
      textModulesData: [
        {
          header: 'NFTs',
          body: '0' // 这里可以根据需要返回实际的 NFT 数量
        },
        {
          header: 'Wallet',
          body: `${pass.userWalletAddress.slice(0, 6)}...${pass.userWalletAddress.slice(-4)}`
        },
        {
          header: 'Name',
          body: pass.userName
        },
        {
          header: 'Status',
          body: 'MEMBER'
        }
      ],
      linksModuleData: {
        uris: [
          {
            uri: 'https://datadance.app',
            description: 'DataDance Website'
          }
        ]
      }
    });
  } catch (error) {
    console.error('Google Wallet Web Service 错误:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

/**
 * 更新 Google Wallet Pass
 * 通过 Google Wallet API 发送更新通知
 */
exports.updateGoogleWalletPass = async (passId) => {
  try {
    const pass = await prisma.pass.findUnique({
      where: { id: passId }
    });

    if (!pass || pass.platform !== 'google') {
      throw new Error('Invalid pass or not a Google Wallet pass');
    }

    // 这里需要实现 Google Wallet API 的调用
    // 由于需要 Google Wallet API 密钥，这里只提供框架
    console.log(`Updating Google Wallet pass: ${passId}`);
    console.log('Object ID:', pass.googleObjectId);
    console.log('Class ID:', pass.googleClassId);

    // 实际实现时，需要：
    // 1. 使用 Google Wallet API 客户端
    // 2. 调用 update 方法更新 pass
    // 3. 处理响应和错误

    return true;
  } catch (error) {
    console.error('更新 Google Wallet Pass 失败:', error);
    throw error;
  }
};

/**
 * 处理 Google Wallet 回调
 * 当用户添加/更新/删除 pass 时，Google 会调用此接口
 */
exports.handleGoogleWalletCallback = async (req, res) => {
  try {
    const { event, objectId, classId } = req.body;

    // 验证回调数据
    if (!event || !objectId || !classId) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid callback data'
      });
    }

    // 查找对应的 Pass 记录
    const pass = await prisma.pass.findFirst({
      where: {
        googleObjectId: objectId,
        googleClassId: classId,
        platform: 'google'
      }
    });

    if (!pass) {
      return res.status(404).json({
        status: 'error',
        message: 'Pass not found'
      });
    }

    // 根据事件类型处理
    switch (event) {
      case 'save':
        console.log(`Pass ${pass.id} saved to Google Wallet`);
        break;
      case 'del':
        console.log(`Pass ${pass.id} deleted from Google Wallet`);
        // 可以选择更新数据库状态
        await prisma.pass.update({
          where: { id: pass.id },
          data: { status: 'revoked' }
        });
        break;
      default:
        console.log(`Unknown event type: ${event}`);
    }

    res.status(200).json({
      status: 'success'
    });
  } catch (error) {
    console.error('处理 Google Wallet 回调失败:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};


// 检查 GenericObject 是否存在
exports.genericObjectExists = async (objectId) => {
  const accessToken = await getAccessToken();
  const url = `${WALLET_API_BASE}/genericObject/${objectId}`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return res.status === 200;
};



// 创建 GenericObject
exports.createGenericObject = async (issuerId, objectSuffix, objectData) => {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_WALLET_SERVICE_ACCOUNT,
      private_key: process.env.GOOGLE_WALLET_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });

  const client = google.walletobjects({
    version: 'v1',
    auth: auth,
  });

  let response;

  // Check if the object exists
  try {
    response = await client.genericobject.get({
      resourceId: `${issuerId}.${objectSuffix}`
    });

    console.log(`Object ${issuerId}.${objectSuffix} already exists!`);

    return `${issuerId}.${objectSuffix}`;
  } catch (err) {
    if (err.response && err.response.status !== 404) {
      // Something else went wrong...
      console.log(err);
      return `${issuerId}.${objectSuffix}`;
    }
  }
  response = await client.genericobject.insert({
    requestBody: objectData
  });

  console.log('Object insert response');
  console.log(response);

  return `${issuerId}.${objectSuffix}`;



};

// 检查 GenericClass 是否存在
exports.classExists = async (classId) => {
  const accessToken = await getAccessToken();
  const url = `${WALLET_API_BASE}/genericClass/${classId}`;
  console.log('Checking classId:', classId);
  console.log('Checking class exists:', url);
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const text = await res.text();
  console.log('classExists response:', res.status, text);
  return res.status === 200;
}; 