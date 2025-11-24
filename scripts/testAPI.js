/**
 * API 测试脚本
 * 
 * 测试后端 API 功能，包括：
 * 1. 登录获取 token
 * 2. 获取 DataNFT 列表
 * 3. 获取特定 DataNFT
 * 4. 测试 DDC NFT Metadata API
 */

const http = require('http');

const BASE_URL = 'http://localhost:3000';

// 发送 HTTP 请求的辅助函数
function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: body, headers: res.headers });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// 测试登录
async function testLogin(email, password) {
  console.log(`\n🔐 Testing login: ${email}`);
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await makeRequest(options, { email, password });
    
    // 处理不同的响应格式
    const token = response.data.token || response.data.data?.token;
    
    if (response.status === 200 && token) {
      console.log(`✅ Login successful`);
      console.log(`   Token: ${token.substring(0, 50)}...`);
      console.log(`   User: ${response.data.data?.user?.name || response.data.user?.name || 'N/A'}`);
      return token;
    } else {
      console.log(`❌ Login failed:`, response.data);
      return null;
    }
  } catch (error) {
    console.error(`❌ Login error:`, error.message);
    return null;
  }
}

// 测试获取 DataNFT 列表
async function testGetDataNFTs(token) {
  console.log(`\n📦 Testing GET /api/data-nfts`);
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/data-nfts',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  try {
    const response = await makeRequest(options);
    
    if (response.status === 200) {
      console.log(`✅ Get DataNFTs successful`);
      const data = response.data;
      if (data.data && Array.isArray(data.data)) {
        console.log(`   Found ${data.data.length} DataNFTs`);
        if (data.pagination) {
          console.log(`   Total: ${data.pagination.total}`);
          console.log(`   Page: ${data.pagination.page}/${data.pagination.pages}`);
        }
        
        // 显示前 3 个
        console.log(`\n   First 3 DataNFTs:`);
        data.data.slice(0, 3).forEach((nft, index) => {
          console.log(`   ${index + 1}. ${nft.name}`);
          console.log(`      Price: ${nft.price}`);
          console.log(`      Published: ${nft.isPublished}`);
          console.log(`      Merchant: ${nft.merchant?.name || 'N/A'}`);
        });
      }
      return response.data;
    } else {
      console.log(`❌ Get DataNFTs failed:`, response.data);
      return null;
    }
  } catch (error) {
    console.error(`❌ Get DataNFTs error:`, error.message);
    return null;
  }
}

// 测试获取特定 DataNFT
async function testGetDataNFTById(token, nftId) {
  console.log(`\n📄 Testing GET /api/data-nfts/${nftId}`);
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: `/api/data-nfts/${nftId}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  try {
    const response = await makeRequest(options);
    
    if (response.status === 200) {
      console.log(`✅ Get DataNFT by ID successful`);
      const nft = response.data;
      console.log(`   Name: ${nft.name}`);
      console.log(`   Description: ${nft.description?.substring(0, 50)}...`);
      console.log(`   Price: ${nft.price}`);
      console.log(`   Published: ${nft.isPublished}`);
      console.log(`   Data Source: ${nft.dataSource || 'N/A'}`);
      if (nft.dataRecords) {
        console.log(`   Records: ${nft.dataRecords.recordCount || 'N/A'}`);
      }
      return response.data;
    } else {
      console.log(`❌ Get DataNFT by ID failed:`, response.data);
      return null;
    }
  } catch (error) {
    console.error(`❌ Get DataNFT by ID error:`, error.message);
    return null;
  }
}

// 测试 DDC NFT Metadata API
async function testDDCNFTMetadata(token, tokenId) {
  console.log(`\n🔗 Testing GET /metadata/ddcnft/${tokenId}`);
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: `/metadata/ddcnft/${tokenId}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  try {
    const response = await makeRequest(options);
    
    if (response.status === 200) {
      console.log(`✅ Get DDC NFT Metadata successful`);
      const metadata = response.data.data || response.data;
      console.log(`   Name: ${metadata.name}`);
      console.log(`   Description: ${metadata.description?.substring(0, 50)}...`);
      console.log(`   Image: ${metadata.image}`);
      console.log(`   Attributes: ${metadata.attributes?.length || 0} items`);
      if (metadata.attributes) {
        metadata.attributes.slice(0, 3).forEach(attr => {
          console.log(`     - ${attr.trait_type}: ${attr.value}`);
        });
      }
      return response.data;
    } else {
      console.log(`❌ Get DDC NFT Metadata failed:`, response.data);
      return null;
    }
  } catch (error) {
    console.error(`❌ Get DDC NFT Metadata error:`, error.message);
    return null;
  }
}

// 主测试函数
async function runTests() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 API 测试');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  // 使用刚才创建的商家账户登录
  const testEmail = 'merchant-europe-fashion-apparel@datadance.io';
  const testPassword = 'Merchant@123';
  
  // 1. 测试登录
  const token = await testLogin(testEmail, testPassword);
  
  if (!token) {
    console.log('\n❌ 无法获取 token，停止测试');
    return;
  }
  
  // 2. 测试获取 DataNFT 列表
  const dataNFTs = await testGetDataNFTs(token);
  
  // 3. 测试获取特定 DataNFT
  if (dataNFTs && dataNFTs.data && dataNFTs.data.length > 0) {
    const firstNFT = dataNFTs.data[0];
    await testGetDataNFTById(token, firstNFT.id);
  }
  
  // 4. 测试 DDC NFT Metadata API
  await testDDCNFTMetadata(token, 1);
  await testDDCNFTMetadata(token, 2);
  
  // 5. 测试获取支持的 token IDs
  console.log(`\n📋 Testing GET /metadata/ddcnft/list/supported`);
  const supportedOptions = {
    hostname: 'localhost',
    port: 3000,
    path: '/metadata/ddcnft/list/supported',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };
  
  try {
    const response = await makeRequest(supportedOptions);
    if (response.status === 200) {
      console.log(`✅ Get supported token IDs successful`);
      console.log(`   Supported IDs: ${response.data.data?.supportedTokenIds?.join(', ') || 'N/A'}`);
    }
  } catch (error) {
    console.error(`❌ Error:`, error.message);
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 测试完成');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// 运行测试
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = {
  testLogin,
  testGetDataNFTs,
  testGetDataNFTById,
  testDDCNFTMetadata
};

