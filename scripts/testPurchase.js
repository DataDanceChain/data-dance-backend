/**
 * 测试 DataNFT 购买功能
 * 
 * 测试场景：
 * 1. 创建一个买家账户（组织账户）
 * 2. 为买家充值
 * 3. 购买 DataNFT
 * 4. 验证购买记录和交易流水
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createBuyer() {
  console.log('\n👤 创建测试买家账户...');
  
  const buyerEmail = 'test-buyer@datadance.io';
  
  // 查找或创建买家
  let buyer = await prisma.user.findFirst({
    where: {
      email: buyerEmail,
      isOrganization: true
    }
  });
  
  if (!buyer) {
    const bcrypt = require('bcryptjs');
    const { generateReferralCode } = require('../src/utils/referralUtils');
    
    const hashedPassword = await bcrypt.hash('Buyer@123', 10);
    buyer = await prisma.user.create({
      data: {
        email: buyerEmail,
        name: 'Test Buyer',
        password: hashedPassword,
        isOrganization: true,
        userType: 'organization',
        authType: 'traditional',
        description: 'Test buyer account for DataNFT purchases',
        referralCode: generateReferralCode()
      }
    });
    
    console.log(`✅ 创建买家账户: ${buyer.name} (${buyer.email})`);
  } else {
    console.log(`✓ 买家账户已存在: ${buyer.name} (${buyer.email})`);
  }
  
  return buyer;
}

async function depositBalance(userId, amount) {
  console.log(`\n💰 为买家充值 ${amount}...`);
  
  // 检查当前余额
  const [depositSum, withdrawSum] = await Promise.all([
    prisma.organizationTransaction.aggregate({
      _sum: { amount: true },
      where: { userId, type: 'DEPOSIT', status: 'COMPLETED' }
    }),
    prisma.organizationTransaction.aggregate({
      _sum: { amount: true },
      where: { userId, type: 'WITHDRAW', status: 'COMPLETED' }
    })
  ]);
  
  const currentBalance = (depositSum._sum.amount || 0) - (withdrawSum._sum.amount || 0);
  console.log(`   当前余额: ${currentBalance}`);
  
  if (currentBalance >= amount) {
    console.log(`   ✓ 余额充足，无需充值`);
    return currentBalance;
  }
  
  // 创建充值交易
  const deposit = await prisma.organizationTransaction.create({
    data: {
      amount: amount,
      type: 'DEPOSIT',
      status: 'COMPLETED',
      description: `Test deposit for DataNFT purchase testing`,
      userId: userId,
      metadata: { source: 'test-script' }
    }
  });
  
  const newBalance = currentBalance + amount;
  console.log(`   ✅ 充值成功，新余额: ${newBalance}`);
  
  return newBalance;
}

async function testPurchase(buyerId, dataNFTId) {
  console.log(`\n🛒 测试购买 DataNFT: ${dataNFTId}`);
  
  // 获取 DataNFT 信息
  const dataNFT = await prisma.dataNFT.findUnique({
    where: { id: dataNFTId },
    include: { merchant: true }
  });
  
  if (!dataNFT) {
    throw new Error(`DataNFT not found: ${dataNFTId}`);
  }
  
  if (!dataNFT.isPublished) {
    throw new Error(`DataNFT is not published: ${dataNFTId}`);
  }
  
  console.log(`   DataNFT: ${dataNFT.name}`);
  console.log(`   价格: ${dataNFT.price}`);
  console.log(`   商家: ${dataNFT.merchant.name}`);
  
  // 检查余额
  const [depositSum, withdrawSum] = await Promise.all([
    prisma.organizationTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: buyerId, type: 'DEPOSIT', status: 'COMPLETED' }
    }),
    prisma.organizationTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: buyerId, type: 'WITHDRAW', status: 'COMPLETED' }
    })
  ]);
  
  const balance = (depositSum._sum.amount || 0) - (withdrawSum._sum.amount || 0);
  console.log(`   买家余额: ${balance}`);
  
  if (balance < dataNFT.price) {
    throw new Error(`Insufficient balance: ${balance} < ${dataNFT.price}`);
  }
  
  // 检查是否已购买
  const existingPurchase = await prisma.dataNFTPurchase.findFirst({
    where: {
      dataNFTId: dataNFTId,
      buyerId: buyerId
    }
  });
  
  if (existingPurchase) {
    console.log(`   ⚠️  已购买过此 DataNFT，跳过`);
    return existingPurchase;
  }
  
  // 创建购买记录
  const purchase = await prisma.dataNFTPurchase.create({
    data: {
      dataNFTId: dataNFTId,
      buyerId: buyerId,
      quantity: 1
    },
    include: {
      dataNFT: {
        include: {
          merchant: true
        }
      }
    }
  });
  
  console.log(`   ✅ 购买成功！`);
  console.log(`      购买 ID: ${purchase.id}`);
  console.log(`      数量: ${purchase.quantity}`);
  
  // 验证交易流水
  const transactions = await prisma.organizationTransaction.findMany({
    where: {
      userId: buyerId,
      metadata: {
        path: ['dataNFTId'],
        equals: dataNFTId
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 2
  });
  
  if (transactions.length > 0) {
    console.log(`\n   💳 交易流水:`);
    transactions.forEach(tx => {
      console.log(`      ${tx.type}: ${tx.amount} (${tx.status})`);
    });
  }
  
  return purchase;
}

async function runTests() {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🧪 DataNFT 购买功能测试');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // 1. 创建买家
    const buyer = await createBuyer();
    
    // 2. 充值
    await depositBalance(buyer.id, 1000);
    
    // 3. 获取一个 DataNFT 进行测试
    const testNFT = await prisma.dataNFT.findFirst({
      where: {
        isPublished: true,
        merchantId: { not: buyer.id } // 不能购买自己的
      },
      orderBy: { createdAt: 'desc' }
    });
    
    if (!testNFT) {
      console.log('\n❌ 没有可购买的 DataNFT');
      return;
    }
    
    console.log(`\n📦 选择测试 DataNFT:`);
    console.log(`   ID: ${testNFT.id}`);
    console.log(`   名称: ${testNFT.name}`);
    console.log(`   价格: ${testNFT.price}`);
    
    // 4. 测试购买
    const purchase = await testPurchase(buyer.id, testNFT.id);
    
    // 5. 验证购买记录
    console.log(`\n📋 验证购买记录...`);
    const purchaseCount = await prisma.dataNFTPurchase.count({
      where: { buyerId: buyer.id }
    });
    
    const purchasedNFTs = await prisma.dataNFTPurchase.findMany({
      where: { buyerId: buyer.id },
      include: {
        dataNFT: {
          select: { name: true, price: true }
        }
      },
      take: 5
    });
    
    console.log(`   总购买数: ${purchaseCount}`);
    console.log(`   已购买的 DataNFT:`);
    purchasedNFTs.forEach((p, i) => {
      console.log(`     ${i + 1}. ${p.dataNFT.name} (${p.dataNFT.price})`);
    });
    
    // 6. 检查余额变化
    const [finalDeposit, finalWithdraw] = await Promise.all([
      prisma.organizationTransaction.aggregate({
        _sum: { amount: true },
        where: { userId: buyer.id, type: 'DEPOSIT', status: 'COMPLETED' }
      }),
      prisma.organizationTransaction.aggregate({
        _sum: { amount: true },
        where: { userId: buyer.id, type: 'WITHDRAW', status: 'COMPLETED' }
      })
    ]);
    
    const finalBalance = (finalDeposit._sum.amount || 0) - (finalWithdraw._sum.amount || 0);
    console.log(`\n💰 最终余额: ${finalBalance}`);
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ 购买功能测试完成');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runTests();
}

module.exports = {
  createBuyer,
  depositBalance,
  testPurchase
};









