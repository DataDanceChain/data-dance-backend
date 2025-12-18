/**
 * 查看商家和 DataNFT 统计信息
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkStats() {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 商家和 DataNFT 统计');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // 商家统计
    const merchants = await prisma.user.count({
      where: {
        isOrganization: true,
        email: { contains: 'merchant-' }
      }
    });
    
    // DataNFT 统计
    const totalNFTs = await prisma.dataNFT.count({
      where: { isPublished: true }
    });
    
    const priceStats = await prisma.dataNFT.aggregate({
      where: { isPublished: true },
      _sum: { price: true },
      _avg: { price: true },
      _min: { price: true },
      _max: { price: true }
    });
    
    // 按价格分组
    const byPrice = await prisma.$queryRaw`
      SELECT price, COUNT(*) as count
      FROM "DataNFT"
      WHERE "isPublished" = true
      GROUP BY price
      ORDER BY price DESC
    `;
    
    // 按区域统计（从 dataRecords 中提取）
    const sampleNFTs = await prisma.dataNFT.findMany({
      where: { isPublished: true },
      select: {
        name: true,
        price: true,
        dataRecords: true,
        merchant: {
          select: { name: true }
        }
      },
      take: 10,
      orderBy: { createdAt: 'desc' }
    });
    
    console.log('📈 总体统计:');
    console.log(`   商家账户总数: ${merchants}`);
    console.log(`   已发布的 DataNFT: ${totalNFTs}`);
    console.log(`   总价值: ${priceStats._sum.price || 0}`);
    console.log(`   平均价格: ${Math.round(priceStats._avg.price || 0)}`);
    console.log(`   价格范围: ${priceStats._min.price || 0} - ${priceStats._max.price || 0}`);
    
    console.log('\n💰 按价格分组:');
    byPrice.forEach(p => {
      console.log(`   价格 ${p.price}: ${p.count} 个`);
    });
    
    console.log('\n📦 最新创建的 DataNFT (前 10 个):');
    sampleNFTs.forEach((nft, i) => {
      const records = nft.dataRecords?.recordCount || 0;
      console.log(`   ${i + 1}. ${nft.name}`);
      console.log(`      价格: ${nft.price}, 记录数: ${records}, 商家: ${nft.merchant.name}`);
    });
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  checkStats();
}

module.exports = { checkStats };









