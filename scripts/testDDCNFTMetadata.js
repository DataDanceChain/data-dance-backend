/**
 * DDC NFT Metadata API 测试脚本
 * 
 * 测试链上交互和 metadata API
 * 
 * 使用方法:
 * node scripts/testDDCNFTMetadata.js
 */

require('dotenv').config();
const ethers = require('ethers');
const ddcNFTMetadataService = require('../src/services/ddcNFTMetadataService');

// 配置
const CONFIG = {
  contractAddress: '0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2',
  RPC_URL: process.env.DDC_RPC_URL || 'https://dev-exp-alpha.datadance.ai/eth/rpc',
  CHAIN_ID: process.env.DDC_CHAIN_ID ? parseInt(process.env.DDC_CHAIN_ID, 10) : 44508,
  supportedTokenIds: [1, 2]
};

async function testProviderConnection() {
  console.log('\n=== 测试 Provider 连接 ===');
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL, CONFIG.CHAIN_ID, {
      batchMaxCount: 1,
    });
    
    // 设置超时，避免长时间等待
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout')), 5000)
    );
    
    const blockNumberPromise = provider.getBlockNumber();
    const blockNumber = await Promise.race([blockNumberPromise, timeoutPromise]);
    
    console.log('✅ Provider 连接成功');
    console.log(`   当前区块号: ${blockNumber}`);
    console.log(`   RPC URL: ${CONFIG.RPC_URL}`);
    console.log(`   Chain ID: ${CONFIG.CHAIN_ID}`);
    return true;
  } catch (error) {
    console.error('⚠️  Provider 连接失败:', error.message);
    console.log('   注意: Metadata API 不依赖链上查询也能工作');
    console.log('   如果只是测试 metadata 返回，可以继续测试');
    return false;
  }
}

async function testContractInstance() {
  console.log('\n=== 测试合约实例 ===');
  try {
    const { provider, contract } = ddcNFTMetadataService.getContractInstance();
    console.log('✅ 合约实例创建成功');
    console.log(`   合约地址: ${CONFIG.contractAddress}`);
    
    // 测试查询合约名称（如果支持）
    try {
      const name = await contract.name();
      console.log(`   合约名称: ${name}`);
    } catch (error) {
      console.log('   ⚠️  合约名称不可用（可能未实现）');
    }
    
    // 测试查询合约符号（如果支持）
    try {
      const symbol = await contract.symbol();
      console.log(`   合约符号: ${symbol}`);
    } catch (error) {
      console.log('   ⚠️  合约符号不可用（可能未实现）');
    }
    
    return true;
  } catch (error) {
    console.error('❌ 合约实例创建失败:', error.message);
    return false;
  }
}

async function testTokenQueries(tokenId) {
  console.log(`\n=== 测试 Token ${tokenId} 查询 ===`);
  try {
    const { contract } = ddcNFTMetadataService.getContractInstance();
    
    // 测试 ownerOf
    try {
      const owner = await contract.ownerOf(tokenId);
      console.log(`✅ Token ${tokenId} Owner: ${owner}`);
    } catch (error) {
      console.log(`⚠️  Token ${tokenId} ownerOf 不可用: ${error.message}`);
    }
    
    // 测试 tokenURI
    try {
      const tokenURI = await contract.tokenURI(tokenId);
      console.log(`✅ Token ${tokenId} URI: ${tokenURI}`);
    } catch (error) {
      console.log(`⚠️  Token ${tokenId} tokenURI 不可用: ${error.message}`);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Token ${tokenId} 查询失败:`, error.message);
    return false;
  }
}

async function testMetadataService(tokenId) {
  console.log(`\n=== 测试 Metadata Service (Token ${tokenId}) ===`);
  try {
    const metadata = await ddcNFTMetadataService.getMetadataByTokenId(tokenId);
    console.log('✅ Metadata 获取成功:');
    console.log(JSON.stringify(metadata, null, 2));
    return true;
  } catch (error) {
    console.error('❌ Metadata 获取失败:', error.message);
    console.error(error.stack);
    return false;
  }
}

async function testOnChainInfo(tokenId) {
  console.log(`\n=== 测试链上信息查询 (Token ${tokenId}) ===`);
  try {
    const info = await ddcNFTMetadataService.getOnChainInfo(tokenId);
    console.log('✅ 链上信息查询成功:');
    console.log(JSON.stringify(info, null, 2));
    return true;
  } catch (error) {
    console.error('❌ 链上信息查询失败:', error.message);
    return false;
  }
}

async function testConfig() {
  console.log('\n=== 测试配置信息 ===');
  try {
    const config = ddcNFTMetadataService.getConfig();
    console.log('✅ 配置信息:');
    console.log(JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('❌ 配置获取失败:', error.message);
    return false;
  }
}

async function runAllTests() {
  console.log('🚀 开始测试 DDC NFT Metadata 功能\n');
  console.log('='.repeat(60));
  
  const results = {
    provider: false,
    contract: false,
    config: false,
    token1: false,
    token2: false,
    metadata1: false,
    metadata2: false,
    onChain1: false,
    onChain2: false
  };
  
  // 1. 测试 Provider 连接
  results.provider = await testProviderConnection();
  
  // 2. 测试配置
  results.config = await testConfig();
  
  // 3. 测试合约实例（即使 provider 失败也尝试，因为可能只是网络检测问题）
  results.contract = await testContractInstance();
  
  // 4. 测试 Token 1 - Metadata 服务不依赖链上查询
  results.metadata1 = await testMetadataService(1);
  
  // 5. 测试 Token 2 - Metadata 服务不依赖链上查询
  results.metadata2 = await testMetadataService(2);
  
  // 6. 如果合约实例可用，测试链上查询
  if (results.contract) {
    results.token1 = await testTokenQueries(1);
    results.onChain1 = await testOnChainInfo(1);
    results.token2 = await testTokenQueries(2);
    results.onChain2 = await testOnChainInfo(2);
  } else {
    console.log('\n⚠️  跳过链上查询测试（合约实例不可用）');
    console.log('   Metadata 服务测试已完成，这是主要功能');
  }
  
  // 总结
  console.log('\n' + '='.repeat(60));
  console.log('📊 测试结果总结:');
  console.log('='.repeat(60));
  console.log(`Provider 连接:     ${results.provider ? '✅' : '❌'}`);
  console.log(`配置信息:          ${results.config ? '✅' : '❌'}`);
  console.log(`合约实例:          ${results.contract ? '✅' : '❌'}`);
  console.log(`Token 1 查询:      ${results.token1 ? '✅' : '❌'}`);
  console.log(`Token 1 Metadata:  ${results.metadata1 ? '✅' : '❌'}`);
  console.log(`Token 1 链上信息: ${results.onChain1 ? '✅' : '❌'}`);
  console.log(`Token 2 查询:      ${results.token2 ? '✅' : '❌'}`);
  console.log(`Token 2 Metadata:  ${results.metadata2 ? '✅' : '❌'}`);
  console.log(`Token 2 链上信息: ${results.onChain2 ? '✅' : '❌'}`);
  console.log('='.repeat(60));
  
  const successCount = Object.values(results).filter(r => r).length;
  const totalCount = Object.keys(results).length;
  console.log(`\n总计: ${successCount}/${totalCount} 项测试通过\n`);
  
  if (successCount === totalCount) {
    console.log('🎉 所有测试通过！');
  } else {
    console.log('⚠️  部分测试失败，请检查上述错误信息');
  }
}

// 运行测试
if (require.main === module) {
  runAllTests()
    .then(() => {
      console.log('\n✅ 测试完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ 测试过程中发生错误:', error);
      process.exit(1);
    });
}

module.exports = {
  testProviderConnection,
  testContractInstance,
  testTokenQueries,
  testMetadataService,
  testOnChainInfo,
  testConfig,
  runAllTests
};

