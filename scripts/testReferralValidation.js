const axios = require('axios');

// Set local database URL for testing
process.env.DATABASE_URL = 'postgresql://ddc:ddc@localhost:15432/ddc';

const prisma = require('../src/utils/prisma');

const API_URL = 'http://localhost:10000/api';

async function testReferralValidation() {
  try {
    console.log('开始测试邀请码验证逻辑...');
    
    // 先清理测试数据
    await cleanupTestData();
    
    // 1. 创建一个测试用户作为邀请人
    console.log('\n1. 创建测试邀请人');
    let inviter = await prisma.user.findUnique({
      where: { email: 'inviter@test.com' }
    });
    
    if (!inviter) {
      inviter = await prisma.user.create({
        data: {
          email: 'inviter@test.com',
          name: 'Test Inviter',
          walletAddress: '0x' + 'a'.repeat(40),
          authType: 'web3auth',
          userType: 'regular',
          referralCode: 'DD-testcode1',
          profile: { create: { language: 'en' } }
        }
      });
    }
    console.log('邀请人:', inviter.referralCode);

    // 2. 测试 Web3Auth 登录时的邀请码验证
    console.log('\n2. 测试 Web3Auth 登录 - 有效邀请码');
    try {
      const response = await axios.post(`${API_URL}/auth/web3auth-login`, {
        userInfo: {
          email: 'newuser@test.com',
          name: 'New User',
          profileImage: 'https://example.com/profile.jpg'
        },
        walletAddress: '0x' + 'b'.repeat(40),
        referralCode: 'DD-testcode1'
      });
      console.log('✅ 有效邀请码测试通过:', response.data.status);
      
      // 保存新用户的token用于后续测试
      const newUserToken = response.data.data.token;
      const newUser = response.data.data.user;
      console.log('新用户创建成功:', newUser.email);
    } catch (error) {
      console.log('❌ 有效邀请码测试失败:', error.response?.data || error.message);
    }

    // 3. 测试无效邀请码
    console.log('\n3. 测试 Web3Auth 登录 - 无效邀请码');
    try {
      const response = await axios.post(`${API_URL}/auth/web3auth-login`, {
        userInfo: {
          email: 'user2@test.com',
          name: 'User 2'
        },
        walletAddress: '0x' + 'c'.repeat(40),
        referralCode: 'DD-invalid'
      });
      console.log('❌ 应该拒绝无效邀请码');
    } catch (error) {
      if (error.response?.data?.code === 'INVALID_CODE') {
        console.log('✅ 无效邀请码测试通过:', error.response.data.message);
      } else {
        console.log('❌ 错误码不正确:', error.response?.data);
      }
    }

    // 4. 测试自我邀请
    console.log('\n4. 测试 Web3Auth 登录 - 自我邀请');
    try {
      const response = await axios.post(`${API_URL}/auth/web3auth-login`, {
        userInfo: {
          email: 'inviter@test.com',  // 与邀请人相同邮箱
          name: 'Self Referral Attempt'
        },
        walletAddress: '0x' + 'd'.repeat(40),
        referralCode: 'DD-testcode1'
      });
      console.log('❌ 应该拒绝自我邀请');
    } catch (error) {
      if (error.response?.data?.code === 'SELF_REFERRAL_NOT_ALLOWED') {
        console.log('✅ 自我邀请防护测试通过:', error.response.data.message);
      } else {
        console.log('❌ 错误码不正确:', error.response?.data);
      }
    }

    // 5. 测试已被邀请的用户再次注册
    console.log('\n5. 测试 Web3Auth 登录 - 已被邀请的用户');
    try {
      const response = await axios.post(`${API_URL}/auth/web3auth-login`, {
        userInfo: {
          email: 'newuser@test.com',  // 之前已经被邀请的用户
          name: 'Duplicate Referral Attempt'
        },
        walletAddress: '0x' + 'e'.repeat(40),
        referralCode: 'DD-testcode1'
      });
      console.log('❌ 应该拒绝重复邀请');
    } catch (error) {
      if (error.response?.data?.code === 'ALREADY_REFERRED') {
        console.log('✅ 重复邀请防护测试通过:', error.response.data.message);
      } else {
        console.log('❌ 错误码不正确:', error.response?.data);
      }
    }

    // 6. 测试手动绑定邀请码API的一致性
    console.log('\n6. 测试手动绑定邀请码API');
    
    // 先创建一个未被邀请的用户
    const unrefUser = await prisma.user.create({
      data: {
        email: 'unref@test.com',
        name: 'UnReferred User',
        walletAddress: '0x' + 'f'.repeat(40),
        authType: 'web3auth',
        userType: 'regular',
        referralCode: 'DD-testcode2',
        profile: { create: { language: 'en' } }
      }
    });

    // 获取这个用户的token
    const unrefUserResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: 'unref@test.com',
        name: 'UnReferred User'
      },
      walletAddress: '0x' + 'f'.repeat(40)
    });
    const unrefToken = unrefUserResponse.data.data.token;

    // 测试使用无效邀请码
    try {
      const response = await axios.post(`${API_URL}/referrals/use-code`, {
        code: 'DD-invalid'
      }, {
        headers: { Authorization: `Bearer ${unrefToken}` }
      });
      console.log('❌ 应该拒绝无效邀请码');
    } catch (error) {
      if (error.response?.data?.code === 'INVALID_CODE') {
        console.log('✅ 手动绑定 - 无效邀请码测试通过');
      } else {
        console.log('❌ 手动绑定错误码不正确:', error.response?.data);
      }
    }

    // 测试自我邀请
    try {
      const response = await axios.post(`${API_URL}/referrals/use-code`, {
        code: 'DD-testcode2'  // 用户自己的邀请码
      }, {
        headers: { Authorization: `Bearer ${unrefToken}` }
      });
      console.log('❌ 应该拒绝自我邀请');
    } catch (error) {
      if (error.response?.data?.code === 'SELF_REFERRAL_NOT_ALLOWED') {
        console.log('✅ 手动绑定 - 自我邀请防护测试通过');
      } else {
        console.log('❌ 手动绑定自我邀请错误码不正确:', error.response?.data);
      }
    }

    // 测试有效邀请码
    try {
      const response = await axios.post(`${API_URL}/referrals/use-code`, {
        code: 'DD-testcode1'  // 邀请人的邀请码
      }, {
        headers: { Authorization: `Bearer ${unrefToken}` }
      });
      console.log('✅ 手动绑定 - 有效邀请码测试通过:', response.data.message);
    } catch (error) {
      console.log('❌ 手动绑定有效邀请码失败:', error.response?.data);
    }

    // 测试重复绑定
    try {
      const response = await axios.post(`${API_URL}/referrals/use-code`, {
        code: 'DD-testcode1'
      }, {
        headers: { Authorization: `Bearer ${unrefToken}` }
      });
      console.log('❌ 应该拒绝重复绑定');
    } catch (error) {
      if (error.response?.data?.code === 'ALREADY_REFERRED') {
        console.log('✅ 手动绑定 - 重复绑定防护测试通过');
      } else {
        console.log('❌ 手动绑定重复绑定错误码不正确:', error.response?.data);
      }
    }

    console.log('\n🎉 所有邀请码验证逻辑测试完成!');
    
  } catch (error) {
    console.error('❌ 测试失败:', error.response ? error.response.data : error.message);
  } finally {
    await cleanupTestData();
    await prisma.$disconnect();
  }
}

async function cleanupTestData() {
  try {
    // 删除测试数据（按照外键依赖关系的顺序）
    // 注意：只清理特定的测试数据，不影响现有数据
    console.log('⚠️ 跳过数据清理（保留现有测试数据）');
  } catch (error) {
    console.log('⚠️ 清理测试数据时出错:', error.message);
  }
}

testReferralValidation();