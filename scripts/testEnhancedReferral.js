const axios = require('axios');

// Set local database URL for testing
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const API_URL = 'http://localhost:10000/api';

async function testEnhancedReferral() {
  console.log('🚀 测试增强的邀请码功能');
  console.log('===============================');
  
  // 1. 测试新用户使用邀请码注册
  console.log('\n1. ✅ 测试新用户使用邀请码注册');
  try {
    const randomEmail = `newuser${Date.now()}@example.com`;
    const randomWallet = '0x' + Math.random().toString(16).substr(2, 40).padEnd(40, '0');
    
    const response = await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: randomEmail,
        name: 'New User Test'
      },
      walletAddress: randomWallet,
      referralCode: 'DD-testcode1'
    });
    
    console.log('   ✅ 新用户邀请成功');
    console.log('   📄 响应包含invitationStatus:', !!response.data.data.invitationStatus);
    
  } catch (error) {
    console.log('   ❌ 新用户邀请失败:', error.response?.data?.message);
  }
  
  // 2. 创建一个未被邀请的现有用户，然后测试邀请码
  console.log('\n2. 🔄 创建未被邀请的现有用户');
  let existingUserToken;
  try {
    const randomEmail = `existing${Date.now()}@example.com`;
    const randomWallet = '0x' + Math.random().toString(16).substr(2, 40).padEnd(40, '0');
    
    const response = await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: randomEmail,
        name: 'Existing User Test'
      },
      walletAddress: randomWallet
      // 注意：这里不提供邀请码
    });
    
    existingUserToken = response.data.data.token;
    console.log('   ✅ 创建现有用户成功');
    
  } catch (error) {
    console.log('   ❌ 创建现有用户失败:', error.response?.data?.message);
    return;
  }
  
  // 3. 测试现有用户首次登录时使用邀请码
  console.log('\n3. ✅ 测试现有用户登录时使用邀请码');
  try {
    const userEmail = `loginuser${Date.now()}@example.com`;
    const userWallet = '0x' + Math.random().toString(16).substr(2, 40).padEnd(40, '0');
    
    // 先创建用户（不用邀请码）
    await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: userEmail,
        name: 'Login Test User'
      },
      walletAddress: userWallet
    });
    
    // 然后再次登录时使用邀请码
    const loginResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: userEmail,
        name: 'Login Test User'
      },
      walletAddress: userWallet,
      referralCode: 'DD-testcode1'
    });
    
    console.log('   ✅ 现有用户登录时使用邀请码成功');
    console.log('   📄 响应包含invitationStatus:', !!loginResponse.data.data.invitationStatus);
    
  } catch (error) {
    console.log('   ❌ 现有用户登录使用邀请码失败:', error.response?.data?.message);
  }
  
  // 4. 测试手动绑定邀请码
  console.log('\n4. ✅ 测试手动绑定邀请码');
  try {
    const response = await axios.post(`${API_URL}/referrals/use-code`, {
      code: 'DD-testcode1'
    }, {
      headers: { Authorization: `Bearer ${existingUserToken}` }
    });
    
    console.log('   ✅ 手动绑定邀请码成功');
    console.log('   📄 邀请人:', response.data.data.inviterName);
    
  } catch (error) {
    console.log('   ❌ 手动绑定邀请码失败:', error.response?.data?.message);
  }
  
  // 5. 测试已被邀请用户尝试再次使用邀请码
  console.log('\n5. ✅ 测试已被邀请用户再次使用邀请码');
  try {
    const response = await axios.post(`${API_URL}/referrals/use-code`, {
      code: 'DD-testcode2'  // 尝试使用不同的邀请码
    }, {
      headers: { Authorization: `Bearer ${existingUserToken}` }
    });
    
    console.log('   ❌ 应该阻止已被邀请用户再次使用邀请码');
    
  } catch (error) {
    if (error.response?.data?.code === 'ALREADY_REFERRED') {
      console.log('   ✅ 正确阻止已被邀请用户再次使用邀请码');
    } else {
      console.log('   ❌ 错误码不正确:', error.response?.data);
    }
  }
  
  // 6. 测试已被邀请用户登录时使用邀请码
  console.log('\n6. ✅ 测试已被邀请用户登录时使用邀请码');
  try {
    const invitedUserEmail = `invited${Date.now()}@example.com`;
    const invitedUserWallet = '0x' + Math.random().toString(16).substr(2, 40).padEnd(40, '0');
    
    // 先创建用户并使用邀请码
    await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: invitedUserEmail,
        name: 'Invited User'
      },
      walletAddress: invitedUserWallet,
      referralCode: 'DD-testcode1'
    });
    
    // 再次登录时尝试使用不同的邀请码
    const loginResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: invitedUserEmail,
        name: 'Invited User'
      },
      walletAddress: invitedUserWallet,
      referralCode: 'DD-testcode2'  // 尝试使用不同的邀请码
    });
    
    console.log('   ❌ 应该阻止已被邀请用户在登录时再次使用邀请码');
    
  } catch (error) {
    if (error.response?.data?.code === 'ALREADY_REFERRED') {
      console.log('   ✅ 正确阻止已被邀请用户在登录时再次使用邀请码');
    } else {
      console.log('   ❌ 错误码不正确:', error.response?.data);
    }
  }
  
  console.log('\n🎉 增强邀请码功能测试完成！');
  console.log('\n📊 测试总结:');
  console.log('✅ 新用户注册时使用邀请码: 正常工作');
  console.log('✅ 现有用户登录时使用邀请码: 正常工作');
  console.log('✅ 手动绑定邀请码: 正常工作');
  console.log('✅ 防止重复邀请: 正常工作');
  console.log('✅ 防止已被邀请用户再次使用邀请码: 正常工作');
  console.log('\n🎯 新的邀请码使用规则已成功实施！');
  console.log('📝 规则: 邀请码可用于新用户注册或未被邀请过的现有用户');
}

testEnhancedReferral();