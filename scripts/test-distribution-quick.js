/**
 * 分润系统快速验证测试
 * 快速验证分润系统的核心功能是否正常工作
 */

// 设置测试数据库连接
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const { distributeUplineRewards, validateDistributionConfig } = require('../src/services/distributionService');
const prisma = require('../src/utils/prisma');

async function quickTest() {
  console.log('🚀 分润系统快速验证测试\n');
  
  let testUsers = [];
  
  try {
    // 1. 配置验证
    console.log('1. 验证分润配置...');
    const isValid = validateDistributionConfig();
    if (isValid) {
      console.log('✅ 分润配置有效');
    } else {
      throw new Error('分润配置无效');
    }
    
    // 2. 创建简单的测试用户链
    console.log('\n2. 创建测试用户...');
    
    for (let i = 0; i < 3; i++) {
      const user = await prisma.user.create({
        data: {
          email: `quick-test-${i}-${Date.now()}@example.com`,
          name: `Quick Test User ${String.fromCharCode(65 + i)}`,
          referralCode: `QUICK-${i}-${Date.now()}`,
          totalPoints: 0
        }
      });
      testUsers.push(user);
    }
    
    // 创建邀请关系: A -> B -> C
    await prisma.referral.create({
      data: {
        inviterId: testUsers[0].id,
        inviteeId: testUsers[1].id,
        code: testUsers[0].referralCode
      }
    });
    
    await prisma.referral.create({
      data: {
        inviterId: testUsers[1].id,
        inviteeId: testUsers[2].id,
        code: testUsers[1].referralCode
      }
    });
    
    console.log(`✅ 创建邀请链: ${testUsers[0].name} -> ${testUsers[1].name} -> ${testUsers[2].name}`);
    
    // 3. 测试基础分润功能
    console.log('\n3. 测试基础分润功能...');
    
    const result = await prisma.$transaction(async (tx) => {
      return await distributeUplineRewards(testUsers[2].id, 100, tx, 'quick-test-task');
    });
    
    console.log(`✅ 分润执行成功:`);
    console.log(`   Level 1 (${testUsers[1].name}): +${result.distributedRewards[0].amount}分`);
    console.log(`   Level 2 (${testUsers[0].name}): +${result.distributedRewards[1].amount}分`);
    console.log(`   总分润: ${result.totalDistributed}分`);
    
    // 4. 验证积分更新
    console.log('\n4. 验证积分更新...');
    
    const updatedUsers = await prisma.user.findMany({
      where: { id: { in: testUsers.map(u => u.id) } },
      orderBy: { email: 'asc' }
    });
    
    console.log('积分状态:');
    updatedUsers.forEach((user, index) => {
      const originalUser = testUsers[index];
      console.log(`   ${originalUser.name}: ${user.totalPoints}分`);
    });
    
    // 验证期望值
    if (updatedUsers[1].totalPoints === 10 && updatedUsers[0].totalPoints === 5) {
      console.log('✅ 积分分润正确');
    } else {
      throw new Error('积分分润不正确');
    }
    
    // 5. 验证积分记录
    console.log('\n5. 验证积分记录...');
    
    const pointRecords = await prisma.point.findMany({
      where: { userId: { in: testUsers.map(u => u.id) } },
      orderBy: { createdAt: 'asc' }
    });
    
    console.log(`✅ 创建了 ${pointRecords.length} 条积分记录:`);
    pointRecords.forEach(record => {
      const user = testUsers.find(u => u.id === record.userId);
      console.log(`   ${user.name}: +${record.amount}分 (${record.source})`);
    });
    
    if (pointRecords.length === 2 && 
        pointRecords.every(r => r.source === 'upline_reward')) {
      console.log('✅ 积分记录正确');
    } else {
      throw new Error('积分记录不正确');
    }
    
    console.log('\n🎉 快速验证测试全部通过！分润系统核心功能正常。');
    
  } catch (error) {
    console.error('\n❌ 快速验证测试失败:', error.message);
    process.exit(1);
  } finally {
    // 清理测试数据
    if (testUsers.length > 0) {
      console.log('\n🧹 清理测试数据...');
      
      const userIds = testUsers.map(u => u.id);
      
      await prisma.referral.deleteMany({
        where: {
          OR: [
            { inviterId: { in: userIds } },
            { inviteeId: { in: userIds } }
          ]
        }
      });
      
      await prisma.point.deleteMany({
        where: { userId: { in: userIds } }
      });
      
      await prisma.user.deleteMany({
        where: { id: { in: userIds } }
      });
      
      console.log('✅ 测试数据清理完成');
    }
    
    await prisma.$disconnect();
  }
}

// 运行快速测试
if (require.main === module) {
  quickTest();
}

module.exports = { quickTest };