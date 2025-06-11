const { PrismaClient } = require('@prisma/client');
const { generateReferralCode } = require('../src/utils/referralUtils');

const prisma = new PrismaClient();

async function fixMissingReferralCodes() {
  try {
    console.log('🔍 查找没有邀请码的用户...');
    
    // 查找没有邀请码的用户
    const usersWithoutCode = await prisma.user.findMany({
      where: {
        OR: [
          { referralCode: null },
          { referralCode: '' }
        ]
      },
      select: { id: true, email: true, name: true }
    });

    if (usersWithoutCode.length === 0) {
      console.log('✅ 所有用户都已有邀请码');
      return;
    }

    console.log(`📊 找到 ${usersWithoutCode.length} 个用户需要生成邀请码`);

    // 串行更新以避免并发冲突
    const results = [];
    for (const user of usersWithoutCode) {
      let attempts = 0;
      let uniqueCode;
      
      // 确保邀请码唯一性
      while (attempts < 10) {
        uniqueCode = generateReferralCode();
        
        const existing = await prisma.user.findUnique({
          where: { referralCode: uniqueCode }
        });
        
        if (!existing) break;
        attempts++;
      }
      
      if (attempts >= 10) {
        throw new Error(`无法为用户 ${user.email} 生成唯一邀请码`);
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { referralCode: uniqueCode }
      });

      console.log(`✅ ${user.email || user.name || user.id}: ${uniqueCode}`);
      results.push({ userId: user.id, code: uniqueCode });
    }
    
    console.log(`🎉 成功为 ${results.length} 个用户生成邀请码`);
    
  } catch (error) {
    console.error('❌ 生成邀请码失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// 执行脚本
if (require.main === module) {
  fixMissingReferralCodes()
    .then(() => {
      console.log('🏁 脚本执行完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 脚本执行失败:', error);
      process.exit(1);
    });
}

module.exports = { fixMissingReferralCodes }; 