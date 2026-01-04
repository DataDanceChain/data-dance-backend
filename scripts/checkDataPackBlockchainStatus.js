/**
 * Check Data Pack Blockchain Status Script
 * 
 * This script checks if all data pack DataNFTs have been recorded to blockchain
 * 
 * Usage:
 * node scripts/checkDataPackBlockchainStatus.js
 */

require('dotenv').config();
const prisma = require('../src/utils/prisma');

// Main function
async function checkDataPackBlockchainStatus() {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⛓️  Data Pack Blockchain Status Check');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // 1. Get all data pack DataNFTs
    console.log('📦 Fetching all data pack DataNFTs...');
    const dataNFTs = await prisma.dataNFT.findMany({
      where: {
        dataSource: 'upload'
      },
      select: {
        id: true,
        name: true,
        isPublished: true,
        blockchainTokenId: true,
        blockchainTxHash: true,
        blockchainRecordedAt: true,
        createdAt: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    console.log(`✅ Found ${dataNFTs.length} data pack DataNFTs\n`);
    
    if (dataNFTs.length === 0) {
      console.log('ℹ️  No data packs found.\n');
      return;
    }
    
    // 2. Analyze blockchain status
    console.log('🔍 Analyzing blockchain status...\n');
    
    const stats = {
      total: dataNFTs.length,
      onChain: 0,
      offChain: 0,
      published: 0,
      unpublished: 0,
      onChainAndPublished: 0,
      offChainButPublished: 0
    };
    
    const onChainNFTs = [];
    const offChainNFTs = [];
    
    for (const dataNFT of dataNFTs) {
      const isOnChain = !!(dataNFT.blockchainTokenId && dataNFT.blockchainTxHash);
      
      if (isOnChain) {
        stats.onChain++;
        onChainNFTs.push(dataNFT);
        if (dataNFT.isPublished) {
          stats.onChainAndPublished++;
        }
      } else {
        stats.offChain++;
        offChainNFTs.push(dataNFT);
        if (dataNFT.isPublished) {
          stats.offChainButPublished++;
        }
      }
      
      if (dataNFT.isPublished) {
        stats.published++;
      } else {
        stats.unpublished++;
      }
    }
    
    // 3. Summary
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 Blockchain Status Summary');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log(`Total DataNFTs: ${stats.total}`);
    console.log(`⛓️  On Chain: ${stats.onChain} (${(stats.onChain / stats.total * 100).toFixed(1)}%)`);
    console.log(`   └─ Published: ${stats.onChainAndPublished}`);
    console.log(`   └─ Unpublished: ${stats.onChain - stats.onChainAndPublished}`);
    console.log(`🔗 Off Chain: ${stats.offChain} (${(stats.offChain / stats.total * 100).toFixed(1)}%)`);
    console.log(`   └─ Published: ${stats.offChainButPublished}`);
    console.log(`   └─ Unpublished: ${stats.offChain - stats.offChainButPublished}\n`);
    
    console.log(`📢 Publishing Status:`);
    console.log(`   Published: ${stats.published}`);
    console.log(`   Unpublished: ${stats.unpublished}\n`);
    
    // 4. Show on-chain examples
    if (onChainNFTs.length > 0) {
      console.log('✅ On-Chain DataNFTs (Sample):');
      onChainNFTs.slice(0, 5).forEach((nft, index) => {
        console.log(`   ${index + 1}. ${nft.name}`);
        console.log(`      Token ID: ${nft.blockchainTokenId}`);
        console.log(`      Tx Hash: ${nft.blockchainTxHash?.substring(0, 20)}...`);
        console.log(`      Recorded At: ${nft.blockchainRecordedAt?.toISOString() || 'N/A'}`);
        console.log(`      Published: ${nft.isPublished ? 'Yes' : 'No'}\n`);
      });
      if (onChainNFTs.length > 5) {
        console.log(`   ... and ${onChainNFTs.length - 5} more\n`);
      }
    }
    
    // 5. Show off-chain examples
    if (offChainNFTs.length > 0) {
      console.log('❌ Off-Chain DataNFTs (Sample):');
      offChainNFTs.slice(0, 5).forEach((nft, index) => {
        console.log(`   ${index + 1}. ${nft.name}`);
        console.log(`      Published: ${nft.isPublished ? 'Yes' : 'No'}`);
        console.log(`      Created At: ${nft.createdAt.toISOString()}\n`);
      });
      if (offChainNFTs.length > 5) {
        console.log(`   ... and ${offChainNFTs.length - 5} more\n`);
      }
    }
    
    // 6. Recommendation
    if (stats.offChain > 0) {
      console.log('💡 Recommendation:');
      if (stats.offChainButPublished > 0) {
        console.log(`   ⚠️  ${stats.offChainButPublished} published DataNFTs are not on-chain yet.`);
        console.log('   Consider recording them to blockchain for full functionality.\n');
      }
      console.log('   To record DataNFTs to blockchain, use:');
      console.log('   node scripts/recordDataNFTToBlockchain.js <dataNFT-id>\n');
    } else {
      console.log('✅ All data packs are on-chain!\n');
    }
    
  } catch (error) {
    console.error('\n❌ Error checking blockchain status:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  checkDataPackBlockchainStatus()
    .then(() => {
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { checkDataPackBlockchainStatus };



