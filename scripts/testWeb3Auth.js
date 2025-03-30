const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const API_URL = 'http://localhost:3000/api';

async function testWeb3Auth() {
  try {
    console.log('开始测试 Web3Auth 集成...');

    // 测试 Web3Auth 登录 - 新用户
    console.log('\n1. 测试 Web3Auth 登录 - 新用户');
    const web3authLoginResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
      userInfo: {
        email: 'web3auth-test@example.com',
        name: 'Web3Auth Test User',
        profileImage: 'https://example.com/profile.jpg',
        verifier: 'datadance-email-verifier',
        verifierId: 'web3auth-test@example.com',
        typeOfLogin: 'jwt'
      },
      walletAddress: '0x' + '1'.repeat(40)
    });

    console.log('Web3Auth 登录响应:', web3authLoginResponse.data);
    const token = web3authLoginResponse.data.data.token;

    // 测试获取用户信息
    console.log('\n2. 测试获取用户信息');
    const userInfoResponse = await axios.get(`${API_URL}/users/me`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    console.log('用户信息响应:', userInfoResponse.data);

    // 测试更新钱包地址
    console.log('\n3. 测试更新钱包地址');
    try {
      const updateWalletResponse = await axios.post(`${API_URL}/auth/update-wallet`, {
        walletAddress: '0x' + '2'.repeat(40)
      }, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      console.log('更新钱包地址响应:', updateWalletResponse.data);
    } catch (error) {
      console.log('更新钱包地址错误:', error.response.data);
    }

    // 在第一次更新钱包地址后，尝试再次更新（应该失败）
    console.log('\n4. 测试再次更新钱包地址（应该失败）');
    try {
      await axios.post(`${API_URL}/auth/update-wallet`, {
        walletAddress: '0x' + '3'.repeat(40)
      }, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      console.log('错误：应该拒绝第二次更新钱包地址');
    } catch (error) {
      console.log('预期的错误:', error.response.data);
    }

    // 测试组织用户使用 Web3Auth 登录（应失败）
    console.log('\n5. 测试组织用户使用 Web3Auth 登录（应失败）');
    
    // 先创建一个组织用户
    const orgUser = await prisma.user.findFirst({
      where: {
        email: 'org-test@example.com'
      }
    });

    if (!orgUser) {
      await prisma.user.create({
        data: {
          email: 'org-test@example.com',
          password: 'password123',
          name: 'Test Organization',
          isOrganization: true,
          userType: 'organization',
          authType: 'traditional'
        }
      });
    }

    try {
      await axios.post(`${API_URL}/auth/web3auth-login`, {
        userInfo: {
          email: 'org-test@example.com',
          name: 'Test Organization',
          profileImage: 'https://example.com/org.jpg',
          verifier: 'datadance-email-verifier',
          verifierId: 'org-test@example.com',
          typeOfLogin: 'jwt'
        },
        walletAddress: '0x' + '3'.repeat(40)
      });
      console.log('错误：应该拒绝组织用户使用 Web3Auth 登录');
    } catch (error) {
      console.log('预期的错误:', error.response.data);
    }

    // 测试场景：只提供钱包地址登录（已存在的钱包）
    console.log('\n6. 测试只提供钱包地址登录（已存在的钱包）');
    try {
      const walletOnlyResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
        walletAddress: '0x' + '1'.repeat(40)
      });
      console.log('钱包地址登录响应:', walletOnlyResponse.data);
    } catch (error) {
      console.log('钱包地址登录错误:', error.response.data);
    }

    // 测试场景：只提供钱包地址登录（新钱包）
    console.log('\n7. 测试只提供钱包地址登录（新钱包）');
    try {
      const newWalletResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
        walletAddress: '0x' + '4'.repeat(40)
      });
      console.log('新钱包登录响应:', newWalletResponse.data);
    } catch (error) {
      console.log('新钱包登录错误:', error.response.data);
    }

    // 测试场景：只提供邮箱登录（已存在的邮箱）
    console.log('\n8. 测试只提供邮箱登录（已存在的邮箱）');
    try {
      const emailOnlyResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
        userInfo: {
          email: 'web3auth-test@example.com',
          name: 'Web3Auth Test User',
          profileImage: 'https://example.com/profile.jpg'
        }
      });
      console.log('邮箱登录响应:', emailOnlyResponse.data);
    } catch (error) {
      console.log('邮箱登录错误:', error.response.data);
    }

    // 测试场景：只提供邮箱登录（新邮箱）
    console.log('\n9. 测试只提供邮箱登录（新邮箱）');
    try {
      const newEmailResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
        userInfo: {
          email: 'new-email@example.com',
          name: 'New Email User',
          profileImage: 'https://example.com/new-profile.jpg'
        }
      });
      console.log('新邮箱登录响应:', newEmailResponse.data);
    } catch (error) {
      console.log('新邮箱登录错误:', error.response.data);
    }

    // 测试场景：新邮箱 + 新钱包地址
    console.log('\n10. 测试新邮箱 + 新钱包地址');
    try {
      const newUserResponse = await axios.post(`${API_URL}/auth/web3auth-login`, {
        userInfo: {
          email: 'another-new@example.com',
          name: 'Another New User',
          profileImage: 'https://example.com/another-profile.jpg'
        },
        walletAddress: '0x' + '5'.repeat(40)
      });
      console.log('新用户登录响应:', newUserResponse.data);
    } catch (error) {
      console.log('新用户登录错误:', error.response.data);
    }

    console.log('\n测试完成!');
  } catch (error) {
    console.error('测试失败:', error.response ? error.response.data : error);
  } finally {
    await prisma.$disconnect();
  }
}

testWeb3Auth(); 