/**
 * 配置商家钱包地址（仅用于显示，不用于区块链交易）
 * 
 * 注意：DataNFT 上链使用后端统一管理的钱包（BACKEND_WALLET_PRIVATE_KEY）
 * 商家钱包地址仅用于标识和显示，不用于实际的区块链交易
 * 
 * 使用方法:
 * 1. 从 MetaMask 导出测试账号的地址（不需要私钥）
 * 2. 运行脚本配置商家钱包地址
 * 
 * 方式1: 交互式配置（推荐）
 * node scripts/configureMerchantWallets.js
 * 
 * 方式2: 批量配置（使用同一个地址）
 * node scripts/configureMerchantWallets.js --wallet-address 0x... --all
 * 
 * 方式3: 为特定商家配置
 * node scripts/configureMerchantWallets.js --merchant-email merchant-xxx@datadance.io --wallet-address 0x...
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const readline = require('readline');
const ethers = require('ethers');

// 创建 readline 接口
function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

// 安全提示
function showSecurityWarning() {
  console.log('\n⚠️  安全提示:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1. 只使用测试网络的账号');
  console.log('2. 不要使用包含真实资金的账号');
  console.log('3. 私钥只用于测试环境');
  console.log('4. 不要将私钥提交到代码仓库');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// 验证钱包地址格式
function validateWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// 验证私钥格式
function validatePrivateKey(key) {
  // 私钥可以是 0x 开头的 64 位十六进制，或者不带 0x 的 66 位
  const cleaned = key.startsWith('0x') ? key : '0x' + key;
  return /^0x[a-fA-F0-9]{64}$/.test(cleaned);
}

// 从私钥获取地址
function getAddressFromPrivateKey(privateKey) {
  try {
    const wallet = new ethers.Wallet(privateKey);
    return wallet.address;
  } catch (error) {
    return null;
  }
}

// 配置单个商家钱包地址（仅用于显示）
async function configureMerchantWallet(merchantEmail, walletAddress) {
  try {
    // 验证格式
    if (!validateWalletAddress(walletAddress)) {
      throw new Error('Invalid wallet address format');
    }
    
    // 查找商家
    const merchant = await prisma.user.findFirst({
      where: {
        email: merchantEmail,
        isOrganization: true
      }
    });
    
    if (!merchant) {
      throw new Error(`Merchant not found: ${merchantEmail}`);
    }
    
    // 更新商家钱包地址（仅地址，不存储私钥）
    const updated = await prisma.user.update({
      where: { id: merchant.id },
      data: {
        walletAddress: walletAddress.toLowerCase(),
        chainId: 44508 // DDC Chain ID
        // 注意：不存储 privateKey，区块链交易使用后端钱包
      }
    });
    
    console.log(`✅ 配置成功: ${merchant.name}`);
    console.log(`   钱包地址: ${updated.walletAddress}`);
    console.log(`   链 ID: ${updated.chainId}`);
    console.log(`   ⚠️  注意：此地址仅用于显示，区块链交易使用后端钱包`);
    
    return updated;
  } catch (error) {
    console.error(`❌ 配置失败: ${error.message}`);
    return null;
  }
}

// 批量配置所有商家（使用同一个地址）
async function configureAllMerchants(walletAddress) {
  console.log('\n📋 获取所有商家账户...');
  
  const merchants = await prisma.user.findMany({
    where: {
      isOrganization: true,
      email: { contains: 'merchant-' }
    },
    orderBy: { createdAt: 'asc' }
  });
  
  console.log(`找到 ${merchants.length} 个商家账户\n`);
  
  const results = {
    total: merchants.length,
    success: 0,
    failed: 0,
    skipped: 0
  };
  
  for (let i = 0; i < merchants.length; i++) {
    const merchant = merchants[i];
    console.log(`[${i + 1}/${merchants.length}] ${merchant.name}`);
    
    // 如果已经有钱包，询问是否覆盖
    if (merchant.walletAddress) {
      console.log(`   ⚠️  已有钱包地址: ${merchant.walletAddress}`);
      console.log(`   ⚠️  跳过（如需覆盖请单独配置）`);
      results.skipped++;
      continue;
    }
    
    const result = await configureMerchantWallet(merchant.email, walletAddress);
    
    if (result) {
      results.success++;
    } else {
      results.failed++;
    }
    
    // 避免请求过快
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 配置结果');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`✅ 成功: ${results.success}`);
  console.log(`⚠️  跳过: ${results.skipped}`);
  console.log(`❌ 失败: ${results.failed}`);
  console.log(`📦 总计: ${results.total}\n`);
  
  return results;
}

// 交互式配置
async function interactiveConfigure() {
  showSecurityWarning();
  
  const rl = createReadlineInterface();
  
  return new Promise((resolve) => {
    rl.question('请输入钱包地址 (0x...): ', (walletAddress) => {
      rl.question('配置所有商家？(y/n): ', async (answer) => {
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          rl.close();
          await configureAllMerchants(walletAddress.trim());
        } else {
          rl.question('请输入商家邮箱: ', async (email) => {
            rl.close();
            await configureMerchantWallet(email.trim(), walletAddress.trim());
            resolve();
          });
        }
      });
    });
  });
}

// 检查钱包余额
async function checkWalletBalance(walletAddress) {
  try {
    const provider = new ethers.JsonRpcProvider(
      process.env.DDC_RPC_URL || 'https://dev-exp-alpha.datadance.ai/eth/rpc',
      44508,
      { batchMaxCount: 1 }
    );
    
    const balance = await provider.getBalance(walletAddress);
    const balanceEth = ethers.formatEther(balance);
    
    console.log(`\n💰 钱包余额检查:`);
    console.log(`   地址: ${walletAddress}`);
    console.log(`   余额: ${balanceEth} ETH`);
    
    if (parseFloat(balanceEth) < 0.001) {
      console.log(`   ⚠️  余额较低，可能不足以支付 gas 费用`);
      console.log(`   💡 建议充值至少 0.01 ETH 用于测试`);
    } else {
      console.log(`   ✅ 余额充足`);
    }
    
    return parseFloat(balanceEth);
  } catch (error) {
    console.error(`   ❌ 无法检查余额: ${error.message}`);
    return 0;
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  
  // 解析命令行参数
  const walletAddressIndex = args.indexOf('--wallet-address');
  const merchantEmailIndex = args.indexOf('--merchant-email');
  const checkBalanceIndex = args.indexOf('--check-balance');
  
  if (walletAddressIndex !== -1) {
    const walletAddress = args[walletAddressIndex + 1];
    
    if (!walletAddress) {
      console.error('❌ 请提供钱包地址');
      process.exit(1);
    }
    
    // 检查余额（如果指定）
    if (checkBalanceIndex !== -1) {
      await checkWalletBalance(walletAddress);
    }
    
    if (args.includes('--all')) {
      // 批量配置所有商家
      await configureAllMerchants(walletAddress);
    } else if (merchantEmailIndex !== -1) {
      // 配置特定商家
      const merchantEmail = args[merchantEmailIndex + 1];
      await configureMerchantWallet(merchantEmail, walletAddress);
    } else {
      console.error('❌ 请指定 --all 或 --merchant-email');
      process.exit(1);
    }
  } else {
    // 交互式配置
    await interactiveConfigure();
  }
  
  console.log('\n✅ 配置完成\n');
}

if (require.main === module) {
  main()
    .catch(console.error)
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = {
  configureMerchantWallet,
  configureAllMerchants,
  validateWalletAddress,
  checkWalletBalance
};

