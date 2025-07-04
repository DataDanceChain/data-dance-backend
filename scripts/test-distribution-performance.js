/**
 * 分润系统性能压力测试
 * 测试大量用户和高并发场景下的系统性能
 */

// 设置测试数据库连接
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const { distributeUplineRewards } = require('../src/services/distributionService');
const prisma = require('../src/utils/prisma');

// 性能测试配置
const PERFORMANCE_CONFIG = {
  SMALL_SCALE: {
    users: 50,
    concurrent: 10,
    iterations: 100
  },
  MEDIUM_SCALE: {
    users: 200,
    concurrent: 20,
    iterations: 500
  },
  LARGE_SCALE: {
    users: 1000,
    concurrent: 50,
    iterations: 1000
  }
};

// 测试工具函数
function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatThroughput(operations, durationMs) {
  const opsPerSecond = (operations / durationMs) * 1000;
  return `${opsPerSecond.toFixed(2)} ops/sec`;
}

async function createTestUsers(count) {
  console.log(`创建 ${count} 个测试用户...`);
  const users = [];
  
  // 批量创建用户
  const userData = [];
  for (let i = 0; i < count; i++) {
    userData.push({
      email: `perf-test-${i}-${Date.now()}@example.com`,
      name: `Perf Test User ${i}`,
      referralCode: `PERF-${i}-${Date.now()}`,
      totalPoints: 0
    });
  }
  
  // 分批创建以避免一次性插入过多数据
  const batchSize = 100;
  for (let i = 0; i < userData.length; i += batchSize) {
    const batch = userData.slice(i, i + batchSize);
    const createdUsers = await prisma.user.createMany({
      data: batch
    });
    
    // 获取创建的用户
    const batchUsers = await prisma.user.findMany({
      where: {
        email: { in: batch.map(u => u.email) }
      }
    });
    
    users.push(...batchUsers);
  }
  
  console.log(`✅ 成功创建 ${users.length} 个用户`);
  return users;
}

async function createReferralChains(users, chainLength = 3) {
  console.log(`创建邀请链 (长度: ${chainLength})...`);
  
  const referrals = [];
  
  // 创建多个独立的邀请链
  for (let start = 0; start < users.length; start += chainLength) {
    for (let i = 1; i < chainLength && start + i < users.length; i++) {
      referrals.push({
        inviterId: users[start + i - 1].id,
        inviteeId: users[start + i].id,
        code: users[start + i - 1].referralCode
      });
    }
  }
  
  // 批量创建邀请关系
  const batchSize = 100;
  for (let i = 0; i < referrals.length; i += batchSize) {
    const batch = referrals.slice(i, i + batchSize);
    await prisma.referral.createMany({
      data: batch
    });
  }
  
  console.log(`✅ 成功创建 ${referrals.length} 个邀请关系`);
  return referrals;
}

async function cleanupTestUsers(users) {
  console.log('清理性能测试数据...');
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
  
  console.log('✅ 性能测试数据清理完成');
}

async function runSingleDistributionTest(userId, amount) {
  const startTime = Date.now();
  
  await prisma.$transaction(async (tx) => {
    await distributeUplineRewards(userId, amount, tx, 'perf-test-task');
  });
  
  return Date.now() - startTime;
}

async function runConcurrentDistributionTest(userIds, amount, concurrentCount) {
  console.log(`执行并发测试: ${concurrentCount} 个并发操作...`);
  
  const startTime = Date.now();
  const promises = [];
  
  for (let i = 0; i < concurrentCount; i++) {
    const userId = userIds[i % userIds.length];
    promises.push(runSingleDistributionTest(userId, amount));
  }
  
  const results = await Promise.all(promises);
  const totalTime = Date.now() - startTime;
  
  return {
    totalTime,
    individualTimes: results,
    averageTime: results.reduce((sum, time) => sum + time, 0) / results.length,
    minTime: Math.min(...results),
    maxTime: Math.max(...results)
  };
}

async function runPerformanceTestSuite(scale) {
  console.log(`\n=== ${scale.toUpperCase()} 规模性能测试 ===`);
  const config = PERFORMANCE_CONFIG[scale.toUpperCase()];
  
  if (!config) {
    throw new Error(`Unknown scale: ${scale}`);
  }
  
  console.log(`配置: ${config.users} 用户, ${config.concurrent} 并发, ${config.iterations} 次迭代`);
  
  let testUsers = [];
  
  try {
    // 1. 创建测试数据
    const setupStart = Date.now();
    testUsers = await createTestUsers(config.users);
    await createReferralChains(testUsers);
    const setupTime = Date.now() - setupStart;
    
    console.log(`数据准备耗时: ${formatDuration(setupTime)}`);
    
    // 2. 单次操作性能测试
    console.log('\n--- 单次操作性能测试 ---');
    const singleTestUsers = testUsers.slice(-10); // 使用最后10个用户测试
    const singleTestResults = [];
    
    for (let i = 0; i < 10; i++) {
      const duration = await runSingleDistributionTest(singleTestUsers[i].id, 100);
      singleTestResults.push(duration);
    }
    
    const avgSingle = singleTestResults.reduce((sum, time) => sum + time, 0) / singleTestResults.length;
    console.log(`单次分润平均耗时: ${formatDuration(avgSingle)}`);
    console.log(`单次分润范围: ${formatDuration(Math.min(...singleTestResults))} - ${formatDuration(Math.max(...singleTestResults))}`);
    
    // 3. 并发性能测试
    console.log('\n--- 并发性能测试 ---');
    const concurrentTestUsers = testUsers.slice(-config.concurrent);
    
    const concurrentResult = await runConcurrentDistributionTest(
      concurrentTestUsers.map(u => u.id),
      100,
      config.concurrent
    );
    
    console.log(`并发总耗时: ${formatDuration(concurrentResult.totalTime)}`);
    console.log(`并发平均耗时: ${formatDuration(concurrentResult.averageTime)}`);
    console.log(`并发吞吐量: ${formatThroughput(config.concurrent, concurrentResult.totalTime)}`);
    console.log(`并发范围: ${formatDuration(concurrentResult.minTime)} - ${formatDuration(concurrentResult.maxTime)}`);
    
    // 4. 连续压力测试
    console.log('\n--- 连续压力测试 ---');
    const stressTestStart = Date.now();
    
    const stressTestUsers = testUsers.slice(-20);
    const stressBatchSize = Math.min(10, config.concurrent);
    const totalBatches = Math.ceil(config.iterations / stressBatchSize);
    
    let completedOperations = 0;
    const progressInterval = Math.max(1, Math.floor(totalBatches / 10));
    
    for (let batch = 0; batch < totalBatches; batch++) {
      const batchPromises = [];
      const currentBatchSize = Math.min(stressBatchSize, config.iterations - completedOperations);
      
      for (let i = 0; i < currentBatchSize; i++) {
        const userId = stressTestUsers[i % stressTestUsers.length].id;
        batchPromises.push(runSingleDistributionTest(userId, 50));
      }
      
      await Promise.all(batchPromises);
      completedOperations += currentBatchSize;
      
      if (batch % progressInterval === 0 || batch === totalBatches - 1) {
        const progress = (completedOperations / config.iterations * 100).toFixed(1);
        console.log(`  进度: ${progress}% (${completedOperations}/${config.iterations})`);
      }
    }
    
    const stressTestDuration = Date.now() - stressTestStart;
    console.log(`压力测试总耗时: ${formatDuration(stressTestDuration)}`);
    console.log(`压力测试吞吐量: ${formatThroughput(config.iterations, stressTestDuration)}`);
    
    // 5. 数据库性能验证
    console.log('\n--- 数据库性能验证 ---');
    const dbTestStart = Date.now();
    
    // 验证积分总和
    const totalPoints = await prisma.point.aggregate({
      where: { userId: { in: testUsers.map(u => u.id) } },
      _sum: { amount: true },
      _count: { id: true }
    });
    
    const userPoints = await prisma.user.aggregate({
      where: { id: { in: testUsers.map(u => u.id) } },
      _sum: { totalPoints: true }
    });
    
    const dbTestDuration = Date.now() - dbTestStart;
    
    console.log(`积分记录数量: ${totalPoints._count.id}`);
    console.log(`积分记录总和: ${totalPoints._sum.amount || 0}`);
    console.log(`用户积分总和: ${userPoints._sum.totalPoints || 0}`);
    console.log(`数据验证耗时: ${formatDuration(dbTestDuration)}`);
    
    // 验证数据一致性
    const pointSum = totalPoints._sum.amount || 0;
    const userSum = userPoints._sum.totalPoints || 0;
    const diff = Math.abs(pointSum - userSum);
    
    if (diff < 0.01) {
      console.log('✅ 数据一致性验证通过');
    } else {
      console.log(`⚠️  数据一致性问题: 差异 ${diff}`);
    }
    
    // 6. 内存使用情况
    const memUsage = process.memoryUsage();
    console.log('\n--- 内存使用情况 ---');
    console.log(`RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Heap Used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Heap Total: ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    
    return {
      scale,
      config,
      setupTime,
      singleOperation: {
        average: avgSingle,
        min: Math.min(...singleTestResults),
        max: Math.max(...singleTestResults)
      },
      concurrent: {
        totalTime: concurrentResult.totalTime,
        average: concurrentResult.averageTime,
        throughput: (config.concurrent / concurrentResult.totalTime) * 1000
      },
      stress: {
        duration: stressTestDuration,
        throughput: (config.iterations / stressTestDuration) * 1000
      },
      database: {
        pointRecords: totalPoints._count.id,
        pointSum: pointSum,
        userSum: userSum,
        consistent: diff < 0.01
      },
      memory: memUsage
    };
    
  } finally {
    if (testUsers.length > 0) {
      await cleanupTestUsers(testUsers);
    }
  }
}

// 主测试函数
async function runPerformanceTests() {
  console.log('🚀 开始分润系统性能压力测试\n');
  
  const results = [];
  
  try {
    // 运行不同规模的测试
    for (const scale of ['SMALL_SCALE', 'MEDIUM_SCALE']) {
      const result = await runPerformanceTestSuite(scale);
      results.push(result);
    }
    
    // 输出总结报告
    console.log('\n🎯 性能测试总结报告');
    console.log('================================');
    
    results.forEach(result => {
      console.log(`\n${result.scale}:`);
      console.log(`  用户数量: ${result.config.users}`);
      console.log(`  单次分润: ${formatDuration(result.singleOperation.average)} (平均)`);
      console.log(`  并发吞吐: ${result.concurrent.throughput.toFixed(2)} ops/sec`);
      console.log(`  压力吞吐: ${result.stress.throughput.toFixed(2)} ops/sec`);
      console.log(`  数据一致: ${result.database.consistent ? '✅' : '❌'}`);
      console.log(`  内存使用: ${(result.memory.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    });
    
    console.log('\n🎉 所有性能测试完成！');
    
  } catch (error) {
    console.error('❌ 性能测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行测试
if (require.main === module) {
  runPerformanceTests();
}

module.exports = { runPerformanceTests, runPerformanceTestSuite };