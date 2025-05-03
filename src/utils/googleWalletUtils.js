const jwt = require('jsonwebtoken');
const crypto = require('crypto');

class GoogleWalletUtils {
  constructor() {
    this.issuerId = process.env.GOOGLE_WALLET_ISSUER_ID;
    this.serviceAccountEmail = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL;
    this.privateKey = process.env.GOOGLE_WALLET_PRIVATE_KEY;
  }

  /**
   * 生成 Google Wallet JWT
   * @param {Object} payload JWT 载荷
   * @param {string} payload.objectId Google Wallet 对象 ID
   * @param {string} payload.classId Google Wallet 类 ID
   * @returns {string} JWT 令牌
   */
  generateJWT(payload) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.serviceAccountEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: now,
      exp: now + 3600, // 1 小时过期
      payload: {
        genericObjects: [{
          id: `${this.issuerId}.${payload.objectId}`,
          classId: `${this.issuerId}.${payload.classId}`,
          ...payload.extraData
        }]
      }
    };

    return jwt.sign(claims, this.privateKey, { algorithm: 'RS256' });
  }

  /**
   * 生成 Google Wallet 添加链接
   * @param {Object} payload JWT 载荷
   * @returns {string} Google Wallet 添加链接
   */
  generateAddToWalletUrl(payload) {
    const jwt = this.generateJWT(payload);
    return `https://pay.google.com/gp/v/save/${jwt}`;
  }

  /**
   * 验证 Google Wallet 回调的 JWT
   * @param {string} token JWT 令牌
   * @returns {Object} 解码后的数据
   */
  verifyJWT(token) {
    try {
      return jwt.verify(token, this.privateKey, { algorithms: ['RS256'] });
    } catch (error) {
      console.error('JWT 验证失败:', error);
      throw new Error('Invalid JWT');
    }
  }

  /**
   * 生成 Google Wallet 对象 ID
   * @param {string} userId 用户 ID
   * @param {string} creatorId 创建者 ID
   * @returns {string} 对象 ID
   */
  generateObjectId(userId, creatorId) {
    const baseString = `${userId}-${creatorId}-${Date.now()}`;
    return crypto.createHash('sha256').update(baseString).digest('hex').substring(0, 32);
  }

  /**
   * 生成 Google Wallet 类 ID
   * @param {string} creatorId 创建者 ID
   * @returns {string} 类 ID
   */
  generateClassId(creatorId) {
    return `membership_${creatorId}`;
  }
}

module.exports = new GoogleWalletUtils(); 