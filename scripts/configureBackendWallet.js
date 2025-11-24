/**
 * 配置后端钱包（用于上链所有 DataNFT）
 * 
 * 使用方法:
 * node scripts/configureBackendWallet.js
 * 
 * 或直接设置环境变量:
 * BACKEND_WALLET_PRIVATE_KEY=0x... node scripts/configureBackendWallet.js --check
 */

require('dotenv').config();
const readline = require('readline');
const ethers = require('ethers');
const fs = require('fs');
const path = require('path');

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
  console.log('5. 确保 .env 文件在 .gitignore 中');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// 验证私钥格式
function validatePrivateKey(key) {
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

// 检查钱包余额
async function checkWalletBalance(walletAddress) {
  try {
    const rpcUrl = process.env.DDC_RPC_URL || 'https://dev-exp-alpha.datadance.ai/eth/rpc';
    const chainId = process.env.DDC_CHAIN_ID ? parseInt(process.env.DDC_CHAIN_ID, 10) : 44508;
    
    const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, {
      batchMaxCount: 1
    });
    
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

// 更新 .env 文件
function updateEnvFile(privateKey, walletAddress) {
  const envPath = path.join(process.cwd(), '.env');
  
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  
  // 移除旧的配置
  envContent = envContent.replace(/^BACKEND_WALLET_PRIVATE_KEY=.*$/gm, '');
  envContent = envContent.replace(/^BACKEND_WALLET_ADDRESS=.*$/gm, '');
  
  // 添加新配置
  envContent += `\n# Backend Wallet (for blockchain recording)\n`;
  envContent += `BACKEND_WALLET_PRIVATE_KEY=${privateKey}\n`;
  envContent += `BACKEND_WALLET_ADDRESS=${walletAddress}\n`;
  
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log(`\n✅ 已更新 .env 文件`);
}

// 交互式配置
async function interactiveConfigure() {
  showSecurityWarning();
  
  const rl = createReadlineInterface();
  
  return new Promise((resolve) => {
    rl.question('请输入私钥 (0x... 或不带 0x): ', async (privateKey) => {
      rl.close();
      
      const cleanedPrivateKey = privateKey.trim().startsWith('0x') 
        ? privateKey.trim() 
        : '0x' + privateKey.trim();
      
      if (!validatePrivateKey(cleanedPrivateKey)) {
        console.error('❌ 无效的私钥格式');
        console.error('   私钥应该是 64 位十六进制字符（可带 0x 前缀）');
        process.exit(1);
      }
      
      const walletAddress = getAddressFromPrivateKey(cleanedPrivateKey);
      if (!walletAddress) {
        console.error('❌ 无法从私钥获取钱包地址');
        process.exit(1);
      }
      
      console.log(`\n✅ 钱包地址: ${walletAddress}`);
      
      // 检查余额
      await checkWalletBalance(walletAddress);
      
      // 更新 .env
      updateEnvFile(cleanedPrivateKey, walletAddress);
      
      console.log(`\n✅ 配置完成！`);
      console.log(`\n💡 下一步:`);
      console.log(`   运行: node scripts/recordDataNFTToBlockchain.js --all`);
      
      resolve();
    });
  });
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  
  // 如果只是检查余额
  if (args.includes('--check')) {
    const privateKey = process.env.BACKEND_WALLET_PRIVATE_KEY;
    
    if (!privateKey) {
      console.error('❌ BACKEND_WALLET_PRIVATE_KEY 未配置');
      console.log('   运行: node scripts/configureBackendWallet.js');
      process.exit(1);
    }
    
    const walletAddress = getAddressFromPrivateKey(privateKey);
    if (!walletAddress) {
      console.error('❌ 无效的私钥');
      process.exit(1);
    }
    
    await checkWalletBalance(walletAddress);
    return;
  }
  
  // 如果环境变量已存在，询问是否覆盖
  if (process.env.BACKEND_WALLET_PRIVATE_KEY) {
    const rl = createReadlineInterface();
    
    return new Promise((resolve) => {
      const existingAddress = getAddressFromPrivateKey(process.env.BACKEND_WALLET_PRIVATE_KEY);
      console.log(`\n⚠️  检测到已有后端钱包配置:`);
      console.log(`   地址: ${existingAddress || '无效'}`);
      console.log(`   私钥: ${process.env.BACKEND_WALLET_PRIVATE_KEY.substring(0, 10)}...`);
      
      rl.question('\n是否覆盖现有配置？(y/n): ', async (answer) => {
        rl.close();
        
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          await interactiveConfigure();
        } else {
          console.log('\n✅ 保持现有配置');
          await checkWalletBalance(existingAddress);
        }
        
        resolve();
      });
    });
  } else {
    // 交互式配置
    await interactiveConfigure();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  validatePrivateKey,
  getAddressFromPrivateKey,
  checkWalletBalance
};

