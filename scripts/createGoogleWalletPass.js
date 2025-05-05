const { google } = require('googleapis');
require('dotenv').config();

const ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID;
const SERVICE_ACCOUNT = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT;
const PRIVATE_KEY = process.env.GOOGLE_WALLET_PRIVATE_KEY;
const CLASS_ID = 'DataDanceGoogleWalletPass'; // 你的classId

async function main() {
  // 1. 认证（直接用 .env 里的 service account 信息）
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: SERVICE_ACCOUNT,
      private_key: PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });

  const client = google.walletobjects({
    version: 'v1',
    auth: auth,
  });

  // 2. 构造 class 数据（参考你的模板）
  const classResource = {
    id: `${ISSUER_ID}.${CLASS_ID}`,
    classTemplateInfo: {
      cardTemplateOverride: {
        cardRowTemplateInfos: [
          {
            threeItems: {
              startItem: {
                firstValue: {
                  fields: [
                    { fieldPath: "object.textModulesData['wallet']" }
                  ]
                }
              },
              middleItem: {
                firstValue: {
                  fields: [
                    { fieldPath: "object.textModulesData['name']" }
                  ]
                }
              },
              endItem: {
                firstValue: {
                  fields: [
                    { fieldPath: "object.textModulesData['status']" }
                  ]
                }
              }
            }
          }
        ]
      }
    }
    // 你可以根据需要补充更多字段，比如 issuerName, reviewStatus, etc.
  };

  // 3. 尝试创建 class
  try {
    // 检查是否已存在
    await client.genericclass.get({ resourceId: `${ISSUER_ID}.${CLASS_ID}` });
    console.log(`Class ${ISSUER_ID}.${CLASS_ID} already exists!`);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      // 不存在则创建
      const response = await client.genericclass.insert({
        requestBody: classResource
      });
      console.log('Class created:', response.data);
    } else {
      // 其它错误
      console.error('Error:', err);
    }
  }
}

main();