const { PrismaClient } = require('@prisma/client');
const apnsService = require('./apnsService');
const prisma = new PrismaClient();

class PassService {
  constructor() {
    this.passTypeId = process.env.PASS_TYPE_ID; // 从环境变量获取Pass Type ID
    if (!this.passTypeId) {
      console.warn('警告: PASS_TYPE_ID 未设置，请检查 .env 文件');
    }
  }

  /**
   * 注册设备的推送令牌
   * @param {string} serialNumber - Pass序列号
   * @param {string} pushToken - 设备的推送令牌
   */
  async registerPushToken(serialNumber, pushToken) {
    try {
      console.log(`注册推送令牌: serialNumber=${serialNumber}, pushToken=${pushToken}`);
      
      const pass = await prisma.pass.update({
        where: { serialNumber },
        data: { pushToken }
      });

      console.log('推送令牌注册成功:', pass.id);
      return pass;
    } catch (error) {
      console.error('注册推送令牌失败:', error);
      if (error.code === 'P2025') {
        throw new Error(`找不到序列号为 ${serialNumber} 的Pass`);
      }
      throw error;
    }
  }

  /**
   * 取消注册设备的推送令牌
   * @param {string} serialNumber - Pass序列号
   */
  async unregisterPushToken(serialNumber) {
    try {
      console.log(`取消注册推送令牌: serialNumber=${serialNumber}`);
      
      const pass = await prisma.pass.update({
        where: { serialNumber },
        data: { pushToken: null }
      });

      console.log('推送令牌取消注册成功:', pass.id);
      return pass;
    } catch (error) {
      console.error('取消注册推送令牌失败:', error);
      if (error.code === 'P2025') {
        throw new Error(`找不到序列号为 ${serialNumber} 的Pass`);
      }
      throw error;
    }
  }

  /**
   * 更新Pass并发送推送通知
   * @param {string} serialNumber - Pass序列号
   * @param {Object} updateData - 要更新的数据
   */
  async updatePassAndNotify(serialNumber, updateData) {
    try {
      console.log(`更新Pass并发送通知: serialNumber=${serialNumber}`);
      console.log('更新数据:', updateData);

      // 更新Pass数据
      const updatedPass = await prisma.pass.update({
        where: { serialNumber },
        data: updateData
      });

      // 如果有推送令牌，发送更新通知
      if (updatedPass.pushToken) {
        console.log('发送APNS通知...');
        try {
          await apnsService.sendPassUpdate(
            updatedPass.pushToken,
            this.passTypeId,
            serialNumber
          );
          console.log('APNS通知发送成功');
        } catch (apnsError) {
          console.error('APNS通知发送失败:', apnsError);
          // 如果APNS通知失败，我们仍然返回更新后的Pass
          // 但记录错误以便后续处理
        }
      } else {
        console.log('Pass没有注册推送令牌，跳过发送通知');
      }

      return updatedPass;
    } catch (error) {
      console.error('更新Pass失败:', error);
      if (error.code === 'P2025') {
        throw new Error(`找不到序列号为 ${serialNumber} 的Pass`);
      }
      throw error;
    }
  }

  /**
   * 获取用户的所有Pass
   * @param {string} userId - 用户ID
   */
  async getUserPasses(userId) {
    try {
      console.log(`获取用户Pass列表: userId=${userId}`);
      
      const passes = await prisma.pass.findMany({
        where: { userId }
      });

      console.log(`找到 ${passes.length} 个Pass`);
      return passes;
    } catch (error) {
      console.error('获取用户Pass列表失败:', error);
      throw error;
    }
  }

  /**
   * 获取创作者的所有Pass
   * @param {string} creatorId - 创作者ID
   */
  async getCreatorPasses(creatorId) {
    try {
      console.log(`获取创作者Pass列表: creatorId=${creatorId}`);
      
      const passes = await prisma.pass.findMany({
        where: { creatorId }
      });

      console.log(`找到 ${passes.length} 个Pass`);
      return passes;
    } catch (error) {
      console.error('获取创作者Pass列表失败:', error);
      throw error;
    }
  }

  /**
   * 批量更新创作者的所有Pass
   * @param {string} creatorId - 创作者ID
   * @param {Object} updateData - 要更新的数据
   */
  async updateCreatorPassesAndNotify(creatorId, updateData) {
    try {
      console.log(`批量更新创作者Pass: creatorId=${creatorId}`);
      console.log('更新数据:', updateData);

      // 获取创作者的所有有效Pass
      const passes = await prisma.pass.findMany({
        where: {
          creatorId,
          status: 'active',
          pushToken: { not: null }
        }
      });

      console.log(`找到 ${passes.length} 个需要更新的Pass`);

      // 批量更新并发送通知
      const results = await Promise.allSettled(
        passes.map(pass =>
          this.updatePassAndNotify(pass.serialNumber, updateData)
        )
      );

      // 统计成功和失败的数量
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      const failureCount = results.filter(r => r.status === 'rejected').length;

      console.log(`更新完成: 成功 ${successCount} 个, 失败 ${failureCount} 个`);

      return {
        total: passes.length,
        success: successCount,
        failed: failureCount
      };
    } catch (error) {
      console.error('批量更新创作者Pass失败:', error);
      throw error;
    }
  }
}

// 创建单例实例
const passService = new PassService();

module.exports = passService; 