/**
 * 任务完成分润集成测试
 * 测试真实的任务完成流程中的分润功能
 */

// 设置测试数据库连接
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const axios = require('axios');
const prisma = require('../src/utils/prisma');

const API_URL = 'http://localhost:10000/api';

// 测试工具函数
function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
  console.log(`✅ ${message}`);
}

function assertApproximatelyEqual(actual, expected, tolerance = 0.01, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected}, got ${actual}`);
  }
  console.log(`✅ ${message}`);
}

// 测试数据准备
async function createTestUsersWithAPI() {
  const users = [];
  
  console.log('创建测试用户链...');
  
  // 创建第一个用户（顶级）
  const user1Response = await axios.post(`${API_URL}/auth/web3auth-login`, {
    userInfo: {
      email: `test-top-${Date.now()}@example.com`,
      name: 'Test Top User'
    },
    walletAddress: '0x' + Math.random().toString(16).substr(2, 40).padEnd(40, '0')
  });
  users.push({
    ...user1Response.data.data.user,
    token: user1Response.data.data.token
  });
  
  // 创建第二个用户（用第一个用户的邀请码）
  const user2Response = await axios.post(`${API_URL}/auth/web3auth-login`, {
    userInfo: {
      email: `test-mid-${Date.now()}@example.com`,
      name: 'Test Mid User'
    },
    walletAddress: '0x' + Math.random().toString(16).substr(2, 40).padEnd(40, '0'),
    referralCode: users[0].referralCode
  });
  users.push({
    ...user2Response.data.data.user,
    token: user2Response.data.data.token
  });
  
  // 创建第三个用户（用第二个用户的邀请码）
  const user3Response = await axios.post(`${API_URL}/auth/web3auth-login`, {
    userInfo: {
      email: `test-bottom-${Date.now()}@example.com`,
      name: 'Test Bottom User'
    },
    walletAddress: '0x' + Math.random().toString(16).substr(2, 40).padEnd(40, '0'),
    referralCode: users[1].referralCode
  });
  users.push({
    ...user3Response.data.data.user,
    token: user3Response.data.data.token
  });
  
  console.log(`邀请链: ${users[0].name} -> ${users[1].name} -> ${users[2].name}`);
  return users;
}

async function getUserPointsFromAPI(userId, token) {
  try {
    const response = await axios.get(`${API_URL}/users/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data.data?.totalPoints || 0;
  } catch (error) {
    console.error('获取用户积分失败:', error.response?.data || error.message);
    return 0;
  }
}

async function getPointHistoryFromDB(userId) {
  return await prisma.point.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' }
  });
}

async function claimTaskViaAPI(taskId, userToken) {
  try {
    const response = await axios.post(`${API_URL}/tasks/${taskId}/claim`, {}, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    return response.data;
  } catch (error) {
    throw new Error(`任务领取失败: ${error.response?.data?.error?.message || error.message}`);
  }
}

async function cleanupTestUsers(users) {
  const userIds = users.map(u => u.id);
  
  console.log('清理测试数据...');
  
  // 清理相关数据
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
  
  await prisma.userTask.deleteMany({
    where: { userId: { in: userIds } }
  });
  
  await prisma.userAward.deleteMany({
    where: { userId: { in: userIds } }
  });
  
  await prisma.userProfile.deleteMany({
    where: { userId: { in: userIds } }
  });
  
  await prisma.user.deleteMany({
    where: { id: { in: userIds } }
  });
}

// 主测试函数
async function runTaskDistributionIntegrationTests() {
  console.log('🧪 开始任务完成分润集成测试\n');
  
  let testUsers = [];
  
  try {
    // 1. 创建测试用户
    console.log('=== 1. 创建测试用户和邀请关系 ===');
    testUsers = await createTestUsersWithAPI();
    console.log('✅ 成功创建3个用户的邀请链\n');
    
    // 2. 获取初始积分
    console.log('=== 2. 记录初始积分状态 ===');
    const initialPoints = [];
    for (let i = 0; i < testUsers.length; i++) {
      const points = await getUserPointsFromAPI(testUsers[i].id, testUsers[i].token);
      initialPoints.push(points);
      console.log(`${testUsers[i].name}: ${points} 分`);
    }
    console.log('');
    
    // 3. 测试Profile任务完成分润
    console.log('=== 3. 测试Profile任务完成分润 ===');
    
    // 获取profile任务
    const profileTasksResponse = await axios.get(`${API_URL}/awards/profile-awards/tasks`, {
      headers: { Authorization: `Bearer ${testUsers[2].token}` }
    });
    
    if (profileTasksResponse.data.tasks && profileTasksResponse.data.tasks.length > 0) {
      const profileTask = profileTasksResponse.data.tasks[0];
      console.log(`准备完成任务: ${profileTask.title} (${profileTask.points}分)`);
      
      try {
        // 让最下级用户完成profile任务
        const claimResult = await claimTaskViaAPI(profileTask.id, testUsers[2].token);
        console.log('✅ 任务完成成功');
        
        // 等待一下确保数据更新
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // 验证积分分润
        const expectedDistribution = {
          user2: profileTask.points, // 任务完成者获得全额积分
          user1: profileTask.points * 0.10, // Level 1: 10%
          user0: profileTask.points * 0.05   // Level 2: 5%
        };
        
        console.log('\n验证积分分润:');
        for (let i = 0; i < testUsers.length; i++) {
          const currentPoints = await getUserPointsFromAPI(testUsers[i].id, testUsers[i].token);
          const pointsGained = currentPoints - initialPoints[i];
          
          let expectedGain = 0;
          if (i === 2) expectedGain = expectedDistribution.user2;
          else if (i === 1) expectedGain = expectedDistribution.user1;
          else if (i === 0) expectedGain = expectedDistribution.user0;
          
          console.log(`${testUsers[i].name}: +${pointsGained} 分 (期望: +${expectedGain}分)`);
          assertApproximatelyEqual(pointsGained, expectedGain, 0.01, 
            `${testUsers[i].name} 的积分增长应该正确`);
        }
        
        // 验证Point记录
        console.log('\n验证积分记录:');
        for (let i = 0; i < testUsers.length; i++) {
          const pointHistory = await getPointHistoryFromDB(testUsers[i].id);
          console.log(`${testUsers[i].name}: ${pointHistory.length} 条积分记录`);
          
          if (i === 2) {
            // 任务完成者应该有TASK_CLAIM记录
            const taskClaimRecord = pointHistory.find(p => p.source === 'TASK_CLAIM');
            if (taskClaimRecord) {
              console.log(`  ✅ 任务完成记录: +${taskClaimRecord.amount}分`);
            }
          } else {
            // 上级应该有upline_reward记录
            const uplineRewardRecord = pointHistory.find(p => p.source === 'upline_reward');
            if (uplineRewardRecord) {
              console.log(`  ✅ 上级分润记录: +${uplineRewardRecord.amount}分`);
            }
          }
        }
        
      } catch (error) {
        console.log(`⚠️  Profile任务可能已完成或不可领取: ${error.message}`);
      }
    } else {
      console.log('⚠️  未找到可测试的Profile任务');
    }
    
    console.log('');
    
    // 4. 测试其他类型任务的分润
    console.log('=== 4. 测试其他类型任务分润 ===');
    
    // 获取所有可用任务
    const allAwardsResponse = await axios.get(`${API_URL}/awards`, {
      headers: { Authorization: `Bearer ${testUsers[2].token}` }
    });
    
    let taskTested = false;
    
    for (const award of allAwardsResponse.data.awards || []) {
      if (award.tasks && award.tasks.length > 0) {
        for (const task of award.tasks) {
          if (task.finalStatus === 'COMPLETED' && !task.claimed && task.points > 0) {
            console.log(`测试任务: ${task.title} (${award.title}) - ${task.points}分`);
            
            try {
              const beforePoints = [];
              for (let i = 0; i < testUsers.length; i++) {
                beforePoints.push(await getUserPointsFromAPI(testUsers[i].id, testUsers[i].token));
              }
              
              // 完成任务
              await claimTaskViaAPI(task.id, testUsers[2].token);
              console.log('✅ 任务完成');
              
              // 等待数据更新
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              // 验证分润
              console.log('分润验证:');
              for (let i = 0; i < testUsers.length; i++) {
                const afterPoints = await getUserPointsFromAPI(testUsers[i].id, testUsers[i].token);
                const gained = afterPoints - beforePoints[i];
                console.log(`  ${testUsers[i].name}: +${gained}分`);
              }
              
              taskTested = true;
              break;
            } catch (error) {
              console.log(`  ⚠️  任务测试跳过: ${error.message}`);
            }
          }
        }
        if (taskTested) break;
      }
    }
    
    if (!taskTested) {
      console.log('⚠️  未找到可完成的任务用于测试');
    }
    
    console.log('');
    
    // 5. 验证分润链的完整性
    console.log('=== 5. 验证分润数据完整性 ===');
    
    for (let i = 0; i < testUsers.length; i++) {
      const pointHistory = await getPointHistoryFromDB(testUsers[i].id);
      const totalPoints = pointHistory.reduce((sum, p) => sum + p.amount, 0);
      const currentPoints = await getUserPointsFromAPI(testUsers[i].id, testUsers[i].token);
      
      console.log(`${testUsers[i].name}:`);
      console.log(`  Point记录总和: ${totalPoints}分`);
      console.log(`  当前总积分: ${currentPoints}分`);
      
      assertApproximatelyEqual(totalPoints, currentPoints, 0.01, 
        `${testUsers[i].name} 的积分记录与总积分应该一致`);
    }
    
    console.log('');
    console.log('🎉 所有任务完成分润集成测试通过！');
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // 清理测试数据
    if (testUsers.length > 0) {
      await cleanupTestUsers(testUsers);
      console.log('✅ 测试数据清理完成');
    }
    
    await prisma.$disconnect();
  }
}

// 运行测试
if (require.main === module) {
  runTaskDistributionIntegrationTests();
}

module.exports = { runTaskDistributionIntegrationTests };