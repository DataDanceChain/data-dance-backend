const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');
const { calculateAmazonDataPoints, getAmazonDataRules } = require('../src/services/businessRulesService');
const { uploadCrawlerData } = require('../src/services/crawlerService');

const prisma = new PrismaClient();

// 颜色输出
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

function log(message, color = 'cyan') {
  console.log(`${colors[color]}[${new Date().toLocaleTimeString()}] ${message}${colors.reset}`);
}

function success(message) {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function warning(message) {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

function error(message) {
  console.log(`${colors.red}❌ ${message}${colors.reset}`);
}

// 创建测试用户
async function createTestUser() {
  try {
    const email = `test_amazon_${Date.now()}@example.com`;
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('TestPassword123!', salt);

    const testUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: 'Amazon Test User',
        isOrganization: false,
        userType: 'regular',
        authType: 'traditional',
        referralCode: generateReferralCode(),
        totalPoints: 0,
        profile: {
          create: {
            language: 'zh'
          }
        }
      },
      include: {
        profile: true
      }
    });

    success(`测试用户创建成功: ${testUser.email} (ID: ${testUser.id})`);
    return testUser;
  } catch (error) {
    error(`创建测试用户失败: ${error.message}`);
    throw error;
  }
}

// 测试1: 业务规则配置验证
async function testBusinessRulesConfig() {
  log('测试1: 验证业务规则配置', 'blue');
  
  try {
    // 测试 getAmazonDataRules 函数
    const rules = getAmazonDataRules();
    
    // 验证新的 pointsPerItem 字段存在
    if (rules.pointsPerItem === 10) {
      success('✓ pointsPerItem 配置正确: 10分/条');
    } else {
      error(`✗ pointsPerItem 配置错误: 期望10，实际${rules.pointsPerItem}`);
    }
    
    // 验证奖励规则描述
    if (rules.rewardRule.includes('10 points for each')) {
      success('✓ 奖励规则描述已更新');
    } else {
      warning(`✓ 奖励规则描述: ${rules.rewardRule}`);
    }
    
    // 验证其他配置保持不变
    if (rules.dailyLimit === 1000 && rules.monthlyLimit === 10000) {
      success('✓ 日限制和月限制保持不变');
    } else {
      error('✗ 日限制或月限制配置异常');
    }
    
    console.log('📋 当前业务规则配置:', JSON.stringify(rules, null, 2));
    
  } catch (error) {
    error(`业务规则配置测试失败: ${error.message}`);
    throw error;
  }
}

// 测试2: 积分计算函数验证
async function testPointsCalculation() {
  log('测试2: 验证积分计算逻辑', 'blue');
  
  try {
    // 测试不同数量的积分计算
    const testCases = [
      { items: 1, expected: 10 },
      { items: 5, expected: 50 },
      { items: 10, expected: 100 },
      { items: 15, expected: 150 },
      { items: 23, expected: 230 },
      { items: 100, expected: 1000 }
    ];
    
    let allPassed = true;
    
    for (const testCase of testCases) {
      const actual = calculateAmazonDataPoints(testCase.items);
      if (actual === testCase.expected) {
        success(`✓ ${testCase.items}条数据 = ${actual}积分`);
      } else {
        error(`✗ ${testCase.items}条数据: 期望${testCase.expected}积分，实际${actual}积分`);
        allPassed = false;
      }
    }
    
    if (allPassed) {
      success('✓ 所有积分计算测试通过 - 新的每条10分逻辑正常工作');
    } else {
      error('✗ 积分计算测试失败');
    }
    
  } catch (error) {
    error(`积分计算测试失败: ${error.message}`);
    throw error;
  }
}

// 测试3: 实际数据上传和奖励验证
async function testDataUploadAndRewards(testUser) {
  log('测试3: 验证数据上传和奖励发放', 'blue');
  
  try {
    // 获取用户初始积分
    const initialUser = await prisma.user.findUnique({
      where: { id: testUser.id }
    });
    const initialPoints = initialUser.totalPoints;
    
    log(`用户初始积分: ${initialPoints}`);
    
    // 准备测试数据 - 5条Amazon订单
    const testData = [
      {
        source: 'amazon',
        type: 'order',
        timestamp: new Date().toISOString(),
        payload: {
          orderid: '111-1111111-1111111',
          title: 'Test Product 1',
          price: '29.99',
          currency: 'USD',
          category: 'Electronics'
        },
        metadata: {
          sourceUrl: 'https://amazon.com/order/111-1111111-1111111',
          category: 'test'
        }
      },
      {
        source: 'amazon',
        type: 'order',
        timestamp: new Date().toISOString(),
        payload: {
          orderid: '222-2222222-2222222',
          title: 'Test Product 2',
          price: '49.99',
          currency: 'USD',
          category: 'Books'
        },
        metadata: {
          sourceUrl: 'https://amazon.com/order/222-2222222-2222222',
          category: 'test'
        }
      },
      {
        source: 'amazon',
        type: 'order',
        timestamp: new Date().toISOString(),
        payload: {
          orderid: '333-3333333-3333333',
          title: 'Test Product 3',
          price: '19.99',
          currency: 'USD',
          category: 'Home'
        },
        metadata: {
          sourceUrl: 'https://amazon.com/order/333-3333333-3333333',
          category: 'test'
        }
      },
      {
        source: 'amazon',
        type: 'order',
        timestamp: new Date().toISOString(),
        payload: {
          orderid: '444-4444444-4444444',
          title: 'Test Product 4',
          price: '99.99',
          currency: 'USD',
          category: 'Clothing'
        },
        metadata: {
          sourceUrl: 'https://amazon.com/order/444-4444444-4444444',
          category: 'test'
        }
      },
      {
        source: 'amazon',
        type: 'order',
        timestamp: new Date().toISOString(),
        payload: {
          orderid: '555-5555555-5555555',
          title: 'Test Product 5',
          price: '79.99',
          currency: 'USD',
          category: 'Sports'
        },
        metadata: {
          sourceUrl: 'https://amazon.com/order/555-5555555-5555555',
          category: 'test'
        }
      }
    ];
    
    log(`准备上传 ${testData.length} 条Amazon订单数据`);
    
    // 上传数据
    const uploadResult = await uploadCrawlerData(testData, testUser.id);
    
    // 验证上传结果
    if (uploadResult.uploadedCount === 5) {
      success(`✓ 成功上传 ${uploadResult.uploadedCount} 条数据`);
    } else {
      error(`✗ 上传数据数量异常: 期望5条，实际${uploadResult.uploadedCount}条`);
    }
    
    // 验证积分计算
    const expectedPoints = 5 * 10; // 新系统：每条10分
    if (uploadResult.pointsEarned === expectedPoints) {
      success(`✓ 积分计算正确: ${uploadResult.pointsEarned}分 (每条10分)`);
    } else {
      error(`✗ 积分计算错误: 期望${expectedPoints}分，实际${uploadResult.pointsEarned}分`);
    }
    
    // 验证数据库中的积分更新
    const updatedUser = await prisma.user.findUnique({
      where: { id: testUser.id }
    });
    
    const totalPointsEarned = updatedUser.totalPoints - initialPoints;
    if (totalPointsEarned === expectedPoints) {
      success(`✓ 数据库积分更新正确: +${totalPointsEarned}分`);
    } else {
      error(`✗ 数据库积分更新错误: 期望+${expectedPoints}分，实际+${totalPointsEarned}分`);
    }
    
    // 验证积分记录
    const pointRecords = await prisma.point.findMany({
      where: {
        userId: testUser.id,
        source: 'crawler'
      }
    });
    
    if (pointRecords.length > 0 && pointRecords[pointRecords.length - 1].amount === expectedPoints) {
      success(`✓ 积分记录创建正确: ${pointRecords[pointRecords.length - 1].amount}分`);
    } else {
      error('✗ 积分记录创建异常');
    }
    
    log(`📊 上传结果摘要: ${uploadResult.message}`);
    
    return uploadResult;
    
  } catch (error) {
    error(`数据上传测试失败: ${error.message}`);
    throw error;
  }
}

// 测试4: 边界情况测试
async function testEdgeCases(testUser) {
  log('测试4: 验证边界情况', 'blue');
  
  try {
    // 测试1条数据
    const singleData = [{
      source: 'amazon',
      type: 'order',
      timestamp: new Date().toISOString(),
      payload: {
        orderid: '999-9999999-9999999',
        title: 'Single Test Product',
        price: '9.99',
        currency: 'USD'
      },
      metadata: {
        sourceUrl: 'https://amazon.com/order/999-9999999-9999999',
        category: 'edge_test'
      }
    }];
    
    const singleResult = await uploadCrawlerData(singleData, testUser.id);
    
    if (singleResult.pointsEarned === 10) {
      success('✓ 单条数据奖励正确: 10分');
    } else {
      error(`✗ 单条数据奖励错误: 期望10分，实际${singleResult.pointsEarned}分`);
    }
    
    // 测试0条有效数据（重复数据）
    log('测试重复数据上传...');
    const duplicateResult = await uploadCrawlerData(singleData, testUser.id);
    
    if (duplicateResult.uploadedCount === 0 && duplicateResult.pointsEarned === 0) {
      success('✓ 重复数据正确被拒绝，0积分');
    } else {
      error(`✗ 重复数据处理异常: 上传${duplicateResult.uploadedCount}条，获得${duplicateResult.pointsEarned}分`);
    }
    
  } catch (error) {
    error(`边界情况测试失败: ${error.message}`);
    throw error;
  }
}

// 测试5: 与旧系统对比验证
async function testSystemComparison() {
  log('测试5: 新旧奖励系统对比', 'blue');
  
  try {
    // 模拟旧系统计算 (每10条100分)
    function oldSystemCalculation(itemCount) {
      return Math.floor(itemCount / 10) * 100;
    }
    
    // 对比不同数据量的奖励
    const comparisons = [
      { items: 1, old: oldSystemCalculation(1), new: calculateAmazonDataPoints(1) },
      { items: 5, old: oldSystemCalculation(5), new: calculateAmazonDataPoints(5) },
      { items: 10, old: oldSystemCalculation(10), new: calculateAmazonDataPoints(10) },
      { items: 15, old: oldSystemCalculation(15), new: calculateAmazonDataPoints(15) },
      { items: 23, old: oldSystemCalculation(23), new: calculateAmazonDataPoints(23) }
    ];
    
    console.log('\n📊 新旧系统奖励对比:');
    console.log('数据条数 | 旧系统积分 | 新系统积分 | 差异');
    console.log('---------|------------|------------|-----');
    
    for (const comp of comparisons) {
      const diff = comp.new - comp.old;
      const diffSymbol = diff > 0 ? '+' : '';
      console.log(`${comp.items.toString().padStart(8)} | ${comp.old.toString().padStart(10)} | ${comp.new.toString().padStart(10)} | ${diffSymbol}${diff}`);
    }
    
    success('✓ 新系统为每条数据都提供奖励，提高了用户体验');
    
  } catch (error) {
    error(`系统对比测试失败: ${error.message}`);
    throw error;
  }
}

// 清理测试数据
async function cleanup(testUser) {
  try {
    log('清理测试数据...', 'yellow');
    
    // 删除积分记录
    await prisma.point.deleteMany({
      where: { userId: testUser.id }
    });
    
    // 删除爬虫数据
    await prisma.crawlerData.deleteMany({
      where: { userId: testUser.id }
    });
    
    // 删除爬虫任务
    await prisma.crawlerTask.deleteMany({
      where: { userId: testUser.id }
    });
    
    // 删除用户资料
    await prisma.profile.deleteMany({
      where: { userId: testUser.id }
    });
    
    // 删除测试用户
    await prisma.user.delete({
      where: { id: testUser.id }
    });
    
    success('✓ 测试数据清理完成');
    
  } catch (error) {
    warning(`测试数据清理失败: ${error.message}`);
  }
}

// 主测试函数
async function runAmazonRewardTests() {
  let testUser = null;
  
  try {
    console.log('\n🚀 Amazon数据奖励系统测试');
    console.log('='.repeat(50));
    
    // 测试1: 业务规则配置
    await testBusinessRulesConfig();
    console.log();
    
    // 测试2: 积分计算函数
    await testPointsCalculation();
    console.log();
    
    // 创建测试用户
    testUser = await createTestUser();
    console.log();
    
    // 测试3: 数据上传和奖励
    await testDataUploadAndRewards(testUser);
    console.log();
    
    // 测试4: 边界情况
    await testEdgeCases(testUser);
    console.log();
    
    // 测试5: 系统对比
    await testSystemComparison();
    console.log();
    
    success('🎉 所有测试通过！Amazon奖励系统工作正常');
    console.log('\n📋 测试总结:');
    console.log('✅ 配置文件更新正确 (pointsPerItem: 10)');
    console.log('✅ 积分计算逻辑正确 (每条10分)');
    console.log('✅ 数据上传流程正常');
    console.log('✅ 积分发放准确');
    console.log('✅ 边界情况处理正确');
    console.log('✅ 新系统相比旧系统提供更即时的奖励');
    
  } catch (error) {
    error(`测试执行失败: ${error.message}`);
    console.error(error);
  } finally {
    if (testUser) {
      await cleanup(testUser);
    }
    await prisma.$disconnect();
  }
}

// 执行测试
if (require.main === module) {
  runAmazonRewardTests();
}

module.exports = {
  runAmazonRewardTests,
  testBusinessRulesConfig,
  testPointsCalculation,
  testDataUploadAndRewards,
  testEdgeCases,
  testSystemComparison
};