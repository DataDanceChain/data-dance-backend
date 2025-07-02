const axios = require('axios');

// Set local database URL for testing
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const API_URL = 'http://localhost:10000/api';

async function testSelfReferral() {
  console.log('测试自我邀请防护...');
  
  try {
    // 测试Web3Auth登录时的自我邀请
    const response = await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: 'inviter@test.com',  // 使用已存在的邀请人邮箱
        name: 'Self Referral Test'
      },
      walletAddress: '0x' + Math.random().toString(16).substr(2, 40).padEnd(40, '0'),
      referralCode: 'DD-testcode1'  // 使用邀请人自己的邀请码
    });
    
    console.log('❌ 应该拒绝自我邀请，但没有阻止');
    console.log('响应:', response.data);
    
  } catch (error) {
    if (error.response?.data?.code === 'SELF_REFERRAL_NOT_ALLOWED') {
      console.log('✅ 自我邀请防护测试通过:', error.response.data.message);
    } else {
      console.log('❌ 错误码不正确:', error.response?.data);
    }
  }
}

testSelfReferral();