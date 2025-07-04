/**
 * 分润服务单元测试
 * 测试 distributionService.js 的核心逻辑
 */

// 设置测试数据库连接
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const { distributeUplineRewards, getDistributionConfig, validateDistributionConfig } = require('../src/services/distributionService');
const prisma = require('../src/utils/prisma');

// 测试工具函数
function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
  console.log(`✅ ${message}`);
}

function assertArrayLength(array, expectedLength, message) {
  if (array.length !== expectedLength) {
    throw new Error(`${message}: expected length ${expectedLength}, got ${array.length}`);
  }
  console.log(`✅ ${message}`);
}

function assertApproximatelyEqual(actual, expected, tolerance = 0.01, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected}, got ${actual}`);
  }
  console.log(`✅ ${message}`);
}

// 测试数据准备函数
async function createTestUsers() {
  const users = [];
  
  // 创建4层用户：A -> B -> C -> D
  for (let i = 0; i < 4; i++) {
    const user = await prisma.user.create({
      data: {
        email: `test-user-${i}-${Date.now()}@example.com`,
        name: `Test User ${i}`,
        referralCode: `TEST-${i}-${Date.now()}`,
        totalPoints: 0
      }
    });
    users.push(user);
  }
  
  // 创建邀请关系链：A邀请B，B邀请C，C邀请D
  for (let i = 1; i < users.length; i++) {
    await prisma.referral.create({
      data: {
        inviterId: users[i-1].id,
        inviteeId: users[i].id,
        code: users[i-1].referralCode
      }
    });
  }
  
  return users;
}

async function cleanupTestUsers(users) {
  const userIds = users.map(u => u.id);
  
  // 清理测试数据
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
}

// 主测试函数
async function runDistributionServiceTests() {
  console.log('🧪 开始分润服务单元测试\n');
  
  let testUsers = [];
  
  try {
    // 1. 配置验证测试
    console.log('=== 1. 配置验证测试 ===');
    
    const isConfigValid = validateDistributionConfig();
    assertEquals(isConfigValid, true, '分润配置应该有效');
    
    const config = getDistributionConfig();
    assertEquals(config.uplineRewardPercentages.length, 3, '分润层级数量正确');
    assertEquals(config.maxLevels, 3, '最大层级设置正确');
    console.log('');
    
    // 2. 创建测试用户
    console.log('=== 2. 创建测试用户和邀请关系 ===');
    testUsers = await createTestUsers();
    console.log(`创建了 ${testUsers.length} 个测试用户`);
    console.log(`邀请链: ${testUsers[0].name} -> ${testUsers[1].name} -> ${testUsers[2].name} -> ${testUsers[3].name}`);
    console.log('');
    
    // 3. 基础分润测试
    console.log('=== 3. 基础分润测试 (用户D完成100分任务) ===');
    
    await prisma.$transaction(async (tx) => {
      // 模拟用户D完成100分任务，触发分润
      const result = await distributeUplineRewards(testUsers[3].id, 100, tx, 'test-task-1');
      
      assertArrayLength(result.distributedRewards, 3, '应该分润给3个上级');
      
      // 验证分润金额
      assertEquals(result.distributedRewards[0].amount, 10, 'Level 1 (C) 应获得 10分 (10%)');
      assertEquals(result.distributedRewards[1].amount, 5, 'Level 2 (B) 应获得 5分 (5%)');
      assertEquals(result.distributedRewards[2].amount, 2, 'Level 3 (A) 应获得 2分 (2%)');
      
      assertEquals(result.totalDistributed, 17, '总分润金额应为 17分');
      
      // 验证层级顺序
      assertEquals(result.distributedRewards[0].referrerId, testUsers[2].id, 'Level 1 应该是用户C');
      assertEquals(result.distributedRewards[1].referrerId, testUsers[1].id, 'Level 2 应该是用户B');
      assertEquals(result.distributedRewards[2].referrerId, testUsers[0].id, 'Level 3 应该是用户A');
    });
    
    console.log('');
    
    // 4. 小数精度测试
    console.log('=== 4. 小数精度测试 (用户D完成33分任务) ===');
    
    await prisma.$transaction(async (tx) => {
      const result = await distributeUplineRewards(testUsers[3].id, 33, tx, 'test-task-2');
      
      // 33 * 0.10 = 3.3 -> 3.3
      // 33 * 0.05 = 1.65 -> 1.65 
      // 33 * 0.02 = 0.66 -> 0.66
      assertApproximatelyEqual(result.distributedRewards[0].amount, 3.3, 0.01, 'Level 1 小数计算正确');
      assertApproximatelyEqual(result.distributedRewards[1].amount, 1.65, 0.01, 'Level 2 小数计算正确');
      assertApproximatelyEqual(result.distributedRewards[2].amount, 0.66, 0.01, 'Level 3 小数计算正确');
    });
    
    console.log('');
    
    // 5. 分润链中断测试
    console.log('=== 5. 分润链中断测试 (用户B完成任务，只有1个上级) ===');
    
    await prisma.$transaction(async (tx) => {
      const result = await distributeUplineRewards(testUsers[1].id, 100, tx, 'test-task-3');
      
      assertArrayLength(result.distributedRewards, 1, '用户B只有1个上级A');
      assertEquals(result.distributedRewards[0].referrerId, testUsers[0].id, '上级应该是用户A');
      assertEquals(result.distributedRewards[0].amount, 10, '用户A应获得10分');
    });
    
    console.log('');
    
    // 6. 无上级用户测试
    console.log('=== 6. 无上级用户测试 (用户A完成任务，无上级) ===');
    
    await prisma.$transaction(async (tx) => {
      const result = await distributeUplineRewards(testUsers[0].id, 100, tx, 'test-task-4');
      
      assertArrayLength(result.distributedRewards, 0, '用户A无上级，分润列表应为空');
      assertEquals(result.totalDistributed, 0, '总分润金额应为0');
    });
    
    console.log('');
    
    // 7. 验证数据库记录
    console.log('=== 7. 验证数据库记录 ===');
    
    // 检查Point记录
    const pointRecords = await prisma.point.findMany({
      where: {
        userId: { in: testUsers.map(u => u.id) },
        source: 'upline_reward'
      },
      orderBy: { createdAt: 'asc' }
    });
    
    console.log(`创建了 ${pointRecords.length} 条分润积分记录`);
    
    // 检查用户积分更新
    const updatedUsers = await prisma.user.findMany({
      where: { id: { in: testUsers.map(u => u.id) } },
      orderBy: { email: 'asc' }
    });
    
    console.log('用户积分更新情况:');
    updatedUsers.forEach((user, index) => {
      console.log(`  ${testUsers[index].name}: ${user.totalPoints} 分`);
    });
    
    console.log('');
    
    console.log('🎉 所有分润服务单元测试通过！');
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // 清理测试数据
    if (testUsers.length > 0) {
      console.log('\n🧹 清理测试数据...');
      await cleanupTestUsers(testUsers);
      console.log('测试数据清理完成');
    }
    
    await prisma.$disconnect();
  }
}

// 运行测试
if (require.main === module) {
  runDistributionServiceTests();
}

module.exports = { runDistributionServiceTests };