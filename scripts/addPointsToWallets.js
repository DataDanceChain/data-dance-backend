const prisma = require('../src/utils/prisma');

/**
 * 给指定钱包地址的用户添加积分
 * @param {string[]} walletAddresses - 钱包地址数组
 * @param {number} points - 要添加的积分数量
 * @param {string} source - 积分来源（可选，默认为 'MANUAL_ADJUSTMENT'）
 * @param {string} sourceId - 积分来源ID（可选）
 */
async function addPointsToWallets(walletAddresses, points, source = 'MANUAL_ADJUSTMENT', sourceId = null) {
  console.log(`\n🎯 Starting to add ${points} points to ${walletAddresses.length} wallet address(es)...\n`);
  
  const results = [];
  
  for (const walletAddress of walletAddresses) {
    try {
      console.log(`Processing wallet: ${walletAddress}...`);
      
      // 查找用户
      const user = await prisma.user.findFirst({
        where: { walletAddress },
        select: {
          id: true,
          email: true,
          name: true,
          walletAddress: true,
          totalPoints: true
        }
      });
      
      if (!user) {
        console.log(`  ⚠️  User not found for wallet address: ${walletAddress}`);
        results.push({
          walletAddress,
          success: false,
          error: 'User not found',
          pointsAdded: 0
        });
        continue;
      }
      
      console.log(`  ✅ Found user: ${user.name || user.email} (ID: ${user.id})`);
      console.log(`  📊 Current total points: ${user.totalPoints || 0}`);
      
      // 使用事务添加积分
      const result = await prisma.$transaction(async (tx) => {
        // 更新用户总积分
        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: {
            totalPoints: { increment: points }
          },
          select: {
            totalPoints: true
          }
        });
        
        // 创建积分记录
        const pointRecord = await tx.point.create({
          data: {
            userId: user.id,
            amount: points,
            source: source,
            sourceId: sourceId || walletAddress
          }
        });
        
        return {
          updatedUser,
          pointRecord
        };
      });
      
      console.log(`  ✅ Points added successfully!`);
      console.log(`  📊 New total points: ${result.updatedUser.totalPoints}`);
      console.log(`  📝 Point record created: ${result.pointRecord.id}\n`);
      
      results.push({
        walletAddress,
        userId: user.id,
        userName: user.name || user.email,
        success: true,
        pointsAdded: points,
        previousTotal: user.totalPoints || 0,
        newTotal: result.updatedUser.totalPoints,
        pointRecordId: result.pointRecord.id
      });
      
    } catch (error) {
      console.error(`  ❌ Error processing wallet ${walletAddress}:`, error.message);
      results.push({
        walletAddress,
        success: false,
        error: error.message,
        pointsAdded: 0
      });
    }
  }
  
  return results;
}

/**
 * 主函数
 */
async function main() {
  // 要添加积分的钱包地址
  const walletAddresses = [
    '0x48f624c63F0FdFA57ed36a492ef60f9aEeBFa82f',
    '0x1Fe85177912dA2FF0Cd611915a2C5ADF69822142'
  ];
  
  // 要添加的积分数量
  const pointsToAdd = 750;
  
  // 积分来源（可选）
  const source = 'MANUAL_ADJUSTMENT';
  const sourceId = 'admin_script_2025';
  
  try {
    console.log('🚀 Starting points addition script...');
    console.log(`📋 Configuration:`);
    console.log(`   - Wallet addresses: ${walletAddresses.length}`);
    console.log(`   - Points per wallet: ${pointsToAdd}`);
    console.log(`   - Source: ${source}`);
    console.log(`   - Source ID: ${sourceId}`);
    
    const results = await addPointsToWallets(walletAddresses, pointsToAdd, source, sourceId);
    
    // 打印汇总
    console.log('\n📊 Summary:');
    console.log('='.repeat(60));
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    console.log(`✅ Successful: ${successful.length}`);
    successful.forEach(r => {
      console.log(`   - ${r.walletAddress}`);
      console.log(`     User: ${r.userName} (${r.userId})`);
      console.log(`     Points: ${r.previousTotal} → ${r.newTotal} (+${r.pointsAdded})`);
    });
    
    if (failed.length > 0) {
      console.log(`\n❌ Failed: ${failed.length}`);
      failed.forEach(r => {
        console.log(`   - ${r.walletAddress}: ${r.error}`);
      });
    }
    
    console.log('='.repeat(60));
    console.log(`\n✨ Script completed!`);
    
  } catch (error) {
    console.error('\n💥 Script failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// 运行脚本
if (require.main === module) {
  main()
    .then(() => {
      console.log('\n✅ All done!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { addPointsToWallets };

