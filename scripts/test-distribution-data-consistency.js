/**
 * 分润系统数据一致性验证测试
 * 验证分润系统的数据完整性和一致性
 */

// 设置测试数据库连接
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const { distributeUplineRewards } = require('../src/services/distributionService');
const prisma = require('../src/utils/prisma');

// 测试工具函数
function assertEquals(actual, expected, message, tolerance = 0.001) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected}, got ${actual} (tolerance: ${tolerance})`);
  }
  console.log(`✅ ${message}`);
}

function assertGreaterThan(actual, expected, message) {
  if (actual <= expected) {
    throw new Error(`${message}: expected > ${expected}, got ${actual}`);
  }
  console.log(`✅ ${message}`);
}

async function createTestEnvironment() {
  console.log('创建测试环境...');
  
  // 创建用户链: A -> B -> C -> D -> E
  const users = [];
  for (let i = 0; i < 5; i++) {
    const user = await prisma.user.create({
      data: {
        email: `consistency-test-${i}-${Date.now()}@example.com`,
        name: `Consistency Test User ${String.fromCharCode(65 + i)}`,
        referralCode: `CONS-${i}-${Date.now()}`,
        totalPoints: 0
      }
    });
    users.push(user);
  }
  
  // 创建邀请关系
  for (let i = 1; i < users.length; i++) {
    await prisma.referral.create({
      data: {
        inviterId: users[i-1].id,
        inviteeId: users[i].id,
        code: users[i-1].referralCode
      }
    });
  }
  
  console.log(`✅ 创建了 ${users.length} 个用户的邀请链`);
  return users;
}

async function cleanupTestEnvironment(users) {
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

async function getDetailedUserStats(users) {
  const stats = {};
  
  for (const user of users) {
    const userRecord = await prisma.user.findUnique({ where: { id: user.id } });
    const pointRecords = await prisma.point.findMany({ 
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' }
    });
    
    const pointsBySource = {};
    let totalFromRecords = 0;
    
    pointRecords.forEach(point => {
      if (!pointsBySource[point.source]) {
        pointsBySource[point.source] = { count: 0, total: 0, records: [] };
      }
      pointsBySource[point.source].count++;
      pointsBySource[point.source].total += point.amount;
      pointsBySource[point.source].records.push(point);
      totalFromRecords += point.amount;
    });
    
    stats[user.id] = {
      name: user.name,
      currentTotalPoints: userRecord.totalPoints,
      totalFromRecords,
      pointRecordCount: pointRecords.length,
      pointsBySource,
      isConsistent: Math.abs(userRecord.totalPoints - totalFromRecords) < 0.001
    };
  }
  
  return stats;
}

async function simulateTaskCompletion(users, taskRewards) {
  console.log('模拟任务完成序列...');
  
  const completionLog = [];
  
  for (const { userId, amount, taskId } of taskRewards) {
    console.log(`  用户 ${users.find(u => u.id === userId)?.name} 完成任务 ${taskId}: ${amount}分`);
    
    const beforeStats = await getDetailedUserStats(users);
    
    const result = await prisma.$transaction(async (tx) => {
      // 给用户发放基础积分
      await tx.user.update({
        where: { id: userId },
        data: { totalPoints: { increment: amount } }
      });
      
      await tx.point.create({
        data: {
          userId,
          amount,
          source: 'TASK_CLAIM',
          sourceId: taskId
        }
      });
      
      // 执行分润
      return await distributeUplineRewards(userId, amount, tx, taskId);
    });
    
    const afterStats = await getDetailedUserStats(users);
    
    completionLog.push({
      taskId,
      userId,
      amount,
      distributionResult: result,
      beforeStats,
      afterStats
    });
  }
  
  return completionLog;
}

async function validateDistributionMath(completionLog) {
  console.log('\n=== 分润数学计算验证 ===');
  
  for (const log of completionLog) {
    console.log(`\n任务 ${log.taskId} (${log.amount}分):`);
    
    const { distributionResult } = log;
    let expectedTotal = 0;
    
    distributionResult.distributedRewards.forEach((reward, index) => {
      const expectedPercentages = [0.10, 0.05, 0.02];
      const expectedAmount = log.amount * expectedPercentages[index];
      
      console.log(`  Level ${index + 1}: ${reward.amount}分 (期望: ${expectedAmount.toFixed(2)}分)`);
      
      // 验证计算精度
      assertEquals(reward.amount, expectedAmount, `Level ${index + 1} 分润计算`, 0.01);
      expectedTotal += expectedAmount;
    });
    
    // 验证总分润金额
    assertEquals(distributionResult.totalDistributed, expectedTotal, '总分润金额', 0.01);
  }
}

async function validatePointRecordIntegrity(users, completionLog) {
  console.log('\n=== 积分记录完整性验证 ===');
  
  const finalStats = await getDetailedUserStats(users);
  
  // 验证每个用户的数据一致性
  Object.entries(finalStats).forEach(([userId, stats]) => {
    console.log(`\n用户 ${stats.name}:`);
    console.log(`  当前总积分: ${stats.currentTotalPoints}`);
    console.log(`  记录总和: ${stats.totalFromRecords}`);
    console.log(`  记录数量: ${stats.pointRecordCount}`);
    
    assertEquals(stats.currentTotalPoints, stats.totalFromRecords, 
      `${stats.name} 的积分一致性`);
    
    // 验证积分来源分类
    Object.entries(stats.pointsBySource).forEach(([source, sourceStats]) => {
      console.log(`    ${source}: ${sourceStats.count}条记录, 总计${sourceStats.total}分`);
      
      // 验证每条记录的完整性
      sourceStats.records.forEach(record => {
        if (!record.createdAt || !record.updatedAt) {
          throw new Error(`${stats.name} 的 ${source} 记录缺少时间戳`);
        }
        if (record.amount <= 0 && source !== 'ADJUSTMENT') {
          throw new Error(`${stats.name} 的 ${source} 记录金额异常: ${record.amount}`);
        }
      });
    });
  });
  
  console.log('\n所有用户积分记录完整性验证通过 ✅');
}

async function validateDistributionChain(users, completionLog) {
  console.log('\n=== 分润链验证 ===');
  
  // 验证分润链的完整性
  for (const log of completionLog) {
    const taskCompleter = users.find(u => u.id === log.userId);
    console.log(`\n任务 ${log.taskId} 分润链验证:`);
    console.log(`  完成者: ${taskCompleter.name}`);
    
    // 获取完成者在链中的位置
    const completerIndex = users.findIndex(u => u.id === log.userId);
    
    // 验证分润对象的正确性
    log.distributionResult.distributedRewards.forEach((reward, level) => {
      const expectedUplineIndex = completerIndex - (level + 1);
      
      if (expectedUplineIndex >= 0) {
        const expectedUpline = users[expectedUplineIndex];
        assertEquals(reward.referrerId, expectedUpline.id, 
          `Level ${level + 1} 分润对象应该是 ${expectedUpline.name}`);
        console.log(`    Level ${level + 1}: ${expectedUpline.name} (+${reward.amount}分) ✅`);
      } else {
        throw new Error(`不应该给不存在的上级分润: Level ${level + 1}`);
      }
    });
    
    // 验证分润层级不超过配置
    if (log.distributionResult.distributedRewards.length > 3) {
      throw new Error(`分润层级超出配置: ${log.distributionResult.distributedRewards.length}`);
    }
  }
  
  console.log('\n分润链验证完成 ✅');
}

async function validateTemporalConsistency(users, completionLog) {
  console.log('\n=== 时序一致性验证 ===');
  
  // 获取所有Point记录并按时间排序
  const allPointRecords = await prisma.point.findMany({
    where: { userId: { in: users.map(u => u.id) } },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { name: true } } }
  });
  
  console.log(`总计 ${allPointRecords.length} 条积分记录`);
  
  // 验证记录的时间顺序
  let previousTime = new Date(0);
  let taskClaimCount = 0;
  let uplineRewardCount = 0;
  
  allPointRecords.forEach((record, index) => {
    // 验证时间递增
    if (record.createdAt < previousTime) {
      throw new Error(`积分记录时间顺序错误: 记录 ${index}`);
    }
    previousTime = record.createdAt;
    
    // 统计记录类型
    if (record.source === 'TASK_CLAIM') {
      taskClaimCount++;
    } else if (record.source === 'upline_reward') {
      uplineRewardCount++;
    }
    
    console.log(`  ${record.createdAt.toISOString()}: ${record.user.name} ${record.source} +${record.amount}分`);
  });
  
  console.log(`\n记录统计:`);
  console.log(`  任务完成记录: ${taskClaimCount}`);
  console.log(`  分润记录: ${uplineRewardCount}`);
  
  // 验证记录数量的合理性
  assertEquals(taskClaimCount, completionLog.length, '任务完成记录数量');
  
  // 计算期望的分润记录数量
  let expectedUplineRewards = 0;
  completionLog.forEach(log => {
    expectedUplineRewards += log.distributionResult.distributedRewards.length;
  });
  
  assertEquals(uplineRewardCount, expectedUplineRewards, '分润记录数量');
  
  console.log('\n时序一致性验证完成 ✅');
}

// 主测试函数
async function runDataConsistencyTests() {
  console.log('🧪 开始分润系统数据一致性验证测试\n');
  
  let testUsers = [];
  
  try {
    // 1. 创建测试环境
    console.log('=== 1. 环境准备 ===');
    testUsers = await createTestEnvironment();
    console.log('');
    
    // 2. 模拟复杂的任务完成序列
    console.log('=== 2. 模拟任务完成序列 ===');
    const taskSequence = [
      { userId: testUsers[4].id, amount: 100, taskId: 'task-1' },  // E完成100分任务
      { userId: testUsers[3].id, amount: 50, taskId: 'task-2' },   // D完成50分任务
      { userId: testUsers[2].id, amount: 75, taskId: 'task-3' },   // C完成75分任务
      { userId: testUsers[4].id, amount: 25, taskId: 'task-4' },   // E再完成25分任务
      { userId: testUsers[1].id, amount: 200, taskId: 'task-5' },  // B完成200分任务
      { userId: testUsers[0].id, amount: 150, taskId: 'task-6' },  // A完成150分任务
      { userId: testUsers[3].id, amount: 33.33, taskId: 'task-7' }, // D完成33.33分任务(测试小数)
    ];
    
    const completionLog = await simulateTaskCompletion(testUsers, taskSequence);
    console.log('');
    
    // 3. 分润数学计算验证
    await validateDistributionMath(completionLog);
    
    // 4. 积分记录完整性验证
    await validatePointRecordIntegrity(testUsers, completionLog);
    
    // 5. 分润链验证
    await validateDistributionChain(testUsers, completionLog);
    
    // 6. 时序一致性验证
    await validateTemporalConsistency(testUsers, completionLog);
    
    // 7. 最终统计报告
    console.log('\n=== 最终统计报告 ===');
    const finalStats = await getDetailedUserStats(testUsers);
    let totalSystemPoints = 0;
    let totalTaskRewards = 0;
    let totalUplineRewards = 0;
    
    Object.entries(finalStats).forEach(([userId, stats]) => {
      console.log(`\n${stats.name}:`);
      console.log(`  总积分: ${stats.currentTotalPoints}`);
      
      totalSystemPoints += stats.currentTotalPoints;
      
      if (stats.pointsBySource['TASK_CLAIM']) {
        const taskPoints = stats.pointsBySource['TASK_CLAIM'].total;
        console.log(`  任务积分: ${taskPoints}`);
        totalTaskRewards += taskPoints;
      }
      
      if (stats.pointsBySource['upline_reward']) {
        const uplinePoints = stats.pointsBySource['upline_reward'].total;
        console.log(`  分润积分: ${uplinePoints}`);
        totalUplineRewards += uplinePoints;
      }
    });
    
    console.log(`\n系统总计:`);
    console.log(`  总积分: ${totalSystemPoints.toFixed(2)}`);
    console.log(`  任务奖励: ${totalTaskRewards.toFixed(2)}`);
    console.log(`  分润奖励: ${totalUplineRewards.toFixed(2)}`);
    console.log(`  预期总和: ${(totalTaskRewards + totalUplineRewards).toFixed(2)}`);
    
    // 验证系统积分总和
    assertEquals(totalSystemPoints, totalTaskRewards + totalUplineRewards, 
      '系统积分总和与任务+分润总和');
    
    // 验证积分守恒
    const inputTaskPoints = taskSequence.reduce((sum, task) => sum + task.amount, 0);
    assertGreaterThan(totalSystemPoints, inputTaskPoints, 
      '系统总积分应大于输入任务积分(包含分润)');
    
    console.log('\n🎉 所有数据一致性验证测试通过！');
    
  } catch (error) {
    console.error('❌ 数据一致性测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // 清理测试数据
    if (testUsers.length > 0) {
      console.log('\n🧹 清理测试数据...');
      await cleanupTestEnvironment(testUsers);
      console.log('测试数据清理完成');
    }
    
    await prisma.$disconnect();
  }
}

// 运行测试
if (require.main === module) {
  runDataConsistencyTests();
}

module.exports = { runDataConsistencyTests };