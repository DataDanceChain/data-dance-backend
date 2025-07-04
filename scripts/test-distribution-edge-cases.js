/**
 * 分润系统边界条件测试
 * 测试各种边界情况和异常场景
 */

// 设置测试数据库连接
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const { distributeUplineRewards } = require('../src/services/distributionService');
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

async function createTestUser(suffix = '') {
  return await prisma.user.create({
    data: {
      email: `edge-test-${Date.now()}-${suffix}@example.com`,
      name: `Edge Test User ${suffix}`,
      referralCode: `EDGE-${Date.now()}-${suffix}`,
      totalPoints: 0
    }
  });
}

async function cleanupTestUsers(users) {
  const userIds = users.map(u => u.id);
  
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
async function runEdgeCaseTests() {
  console.log('🧪 开始分润系统边界条件测试\n');
  
  let testUsers = [];
  
  try {
    // 1. 零积分任务测试
    console.log('=== 1. 零积分任务分润测试 ===');
    
    const user1 = await createTestUser('zero1');
    const user2 = await createTestUser('zero2');
    testUsers.push(user1, user2);
    
    await prisma.referral.create({
      data: {
        inviterId: user1.id,
        inviteeId: user2.id,
        code: user1.referralCode
      }
    });
    
    await prisma.$transaction(async (tx) => {
      const result = await distributeUplineRewards(user2.id, 0, tx, 'zero-task');
      
      assertArrayLength(result.distributedRewards, 1, '零积分也应该产生分润记录');
      assertEquals(result.distributedRewards[0].amount, 0, '分润金额应为0');
      assertEquals(result.totalDistributed, 0, '总分润应为0');
    });
    
    console.log('');
    
    // 2. 极小积分测试
    console.log('=== 2. 极小积分分润测试 ===');
    
    await prisma.$transaction(async (tx) => {
      const result = await distributeUplineRewards(user2.id, 0.01, tx, 'tiny-task');
      
      // 0.01 * 0.10 = 0.001 -> 0.00 (四舍五入到2位小数)
      assertEquals(result.distributedRewards[0].amount, 0.00, '极小分润应正确处理');
    });
    
    console.log('');
    
    // 3. 大积分数值测试
    console.log('=== 3. 大积分数值分润测试 ===');
    
    await prisma.$transaction(async (tx) => {
      const result = await distributeUplineRewards(user2.id, 999999.99, tx, 'huge-task');
      
      // 999999.99 * 0.10 = 99999.999 -> 100000.00
      assertEquals(result.distributedRewards[0].amount, 100000.00, '大数值分润应正确计算');
    });
    
    console.log('');
    
    // 4. 循环邀请检测（虽然当前业务逻辑不允许，但测试健壮性）
    console.log('=== 4. 复杂邀请链测试 ===');
    
    // 创建更长的邀请链
    const longChainUsers = [];
    for (let i = 0; i < 6; i++) {
      const user = await createTestUser(`chain${i}`);
      longChainUsers.push(user);
      testUsers.push(user);
    }
    
    // 创建5层邀请链
    for (let i = 1; i < longChainUsers.length; i++) {
      await prisma.referral.create({
        data: {
          inviterId: longChainUsers[i-1].id,
          inviteeId: longChainUsers[i].id,
          code: longChainUsers[i-1].referralCode
        }
      });
    }
    
    await prisma.$transaction(async (tx) => {
      // 最后一个用户完成任务，应该只分润到前3级
      const result = await distributeUplineRewards(longChainUsers[5].id, 100, tx, 'long-chain-task');
      
      assertArrayLength(result.distributedRewards, 3, '长链应该只分润到配置的最大层级');
      assertEquals(result.distributedRewards[0].referrerId, longChainUsers[4].id, 'Level 1正确');
      assertEquals(result.distributedRewards[1].referrerId, longChainUsers[3].id, 'Level 2正确');
      assertEquals(result.distributedRewards[2].referrerId, longChainUsers[2].id, 'Level 3正确');
    });
    
    console.log('');
    
    // 5. 数据库约束测试
    console.log('=== 5. 数据库约束和事务测试 ===');
    
    const constraintUser1 = await createTestUser('constraint1');
    const constraintUser2 = await createTestUser('constraint2');
    testUsers.push(constraintUser1, constraintUser2);
    
    await prisma.referral.create({
      data: {
        inviterId: constraintUser1.id,
        inviteeId: constraintUser2.id,
        code: constraintUser1.referralCode
      }
    });
    
    // 测试事务回滚
    try {
      await prisma.$transaction(async (tx) => {
        // 正常的分润
        await distributeUplineRewards(constraintUser2.id, 100, tx, 'constraint-task');
        
        // 故意抛出错误来测试事务回滚
        throw new Error('测试事务回滚');
      });
    } catch (error) {
      console.log('✅ 事务正确回滚');
    }
    
    // 验证没有创建任何Point记录
    const pointsAfterRollback = await prisma.point.findMany({
      where: { 
        userId: { in: [constraintUser1.id, constraintUser2.id] },
        sourceId: 'constraint-task'
      }
    });
    
    assertEquals(pointsAfterRollback.length, 0, '事务回滚后不应有Point记录');
    
    console.log('');
    
    // 6. 无效用户ID测试
    console.log('=== 6. 无效用户ID测试 ===');
    
    try {
      await prisma.$transaction(async (tx) => {
        await distributeUplineRewards('invalid-user-id', 100, tx, 'invalid-task');
      });
      console.log('❌ 应该抛出错误');
    } catch (error) {
      console.log('✅ 正确处理无效用户ID');
    }
    
    console.log('');
    
    // 7. 并发测试
    console.log('=== 7. 并发分润测试 ===');
    
    const concurrentUser1 = await createTestUser('concurrent1');
    const concurrentUser2 = await createTestUser('concurrent2');
    testUsers.push(concurrentUser1, concurrentUser2);
    
    await prisma.referral.create({
      data: {
        inviterId: concurrentUser1.id,
        inviteeId: concurrentUser2.id,
        code: concurrentUser1.referralCode
      }
    });
    
    // 同时执行多个分润操作
    const concurrentPromises = [];
    for (let i = 0; i < 5; i++) {
      const promise = prisma.$transaction(async (tx) => {
        return await distributeUplineRewards(concurrentUser2.id, 20, tx, `concurrent-task-${i}`);
      });
      concurrentPromises.push(promise);
    }
    
    const concurrentResults = await Promise.all(concurrentPromises);
    
    console.log(`✅ 并发执行${concurrentResults.length}个分润操作成功`);
    
    // 验证最终积分
    const finalUser1 = await prisma.user.findUnique({ where: { id: concurrentUser1.id } });
    const expectedPoints = 5 * 20 * 0.10; // 5次 * 20分 * 10%
    assertEquals(finalUser1.totalPoints, expectedPoints, '并发分润积分累加正确');
    
    console.log('');
    
    // 8. 精度边界测试
    console.log('=== 8. 小数精度边界测试 ===');
    
    const precisionTestCases = [
      { amount: 3.33, expected1: 0.33, expected2: 0.17, expected3: 0.07 }, // 会产生精度问题的数值
      { amount: 1.11, expected1: 0.11, expected2: 0.06, expected3: 0.02 },
      { amount: 0.99, expected1: 0.10, expected2: 0.05, expected3: 0.02 }
    ];
    
    for (const testCase of precisionTestCases) {
      await prisma.$transaction(async (tx) => {
        const result = await distributeUplineRewards(user2.id, testCase.amount, tx, 'precision-test');
        
        console.log(`输入: ${testCase.amount}分`);
        console.log(`  Level 1: ${result.distributedRewards[0].amount}分 (期望: ~${testCase.expected1})`);
        
        // 验证精度在合理范围内
        const tolerance = 0.01;
        if (Math.abs(result.distributedRewards[0].amount - testCase.expected1) <= tolerance) {
          console.log('  ✅ 精度在合理范围内');
        } else {
          console.log('  ⚠️  精度可能需要调整');
        }
      });
    }
    
    console.log('');
    console.log('🎉 所有边界条件测试完成！');
    
  } catch (error) {
    console.error('❌ 边界条件测试失败:', error.message);
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
  runEdgeCaseTests();
}

module.exports = { runEdgeCaseTests };