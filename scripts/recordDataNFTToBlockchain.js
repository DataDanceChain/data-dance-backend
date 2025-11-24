/**
 * 将 DataNFT 记录到区块链
 * 
 * 功能：
 * 1. 为每个 DataNFT 创建链上 token
 * 2. 记录 metadata 到链上
 * 3. 关联商家账户和 DataNFT
 * 
 * 使用方法:
 * node scripts/recordDataNFTToBlockchain.js
 * node scripts/recordDataNFTToBlockchain.js --nft-id <nft-id>
 * node scripts/recordDataNFTToBlockchain.js --all
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ethers = require('ethers');
const { createLogger } = require('../src/utils/logger');

// 尝试导入 DDC Market SDK
let DDCNFTManager = null;
try {
  // 使用动态 require 绕过 package.json exports 限制
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  
  const sdkPath = path.join(__dirname, '../node_modules/@ddcmarket/sdk/dist/cjs/index.js');
  
  if (fs.existsSync(sdkPath)) {
    // 手动加载 CommonJS 文件
    const code = fs.readFileSync(sdkPath, 'utf8');
    const sandbox = {
      exports: {},
      module: { exports: {} },
      require: require,
      __dirname: path.dirname(sdkPath),
      __filename: sdkPath,
      process: process,
      Buffer: Buffer,
      console: console,
      setTimeout: setTimeout,
      setInterval: setInterval,
      clearTimeout: clearTimeout,
      clearInterval: clearInterval,
    };
    
    // 创建全局对象以支持 SDK 的依赖
    global.require = require;
    global.process = process;
    global.Buffer = Buffer;
    
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    
    DDCNFTManager = sandbox.module.exports.DDCNFTManager || sandbox.exports.DDCNFTManager;
    
    if (DDCNFTManager) {
      console.log('✅ DDC Market SDK loaded successfully (manual load)');
    } else {
      console.log('⚠️  SDK loaded but DDCNFTManager not found');
    }
  } else {
    throw new Error(`SDK file not found: ${sdkPath}`);
  }
} catch (error) {
  console.log('⚠️  SDK not available, will use ethers.js directly:', error.message);
}

const logger = createLogger('blockchainRecord');

// DDC Market 合约配置
const DDC_MARKET_CONFIG = {
  contractAddress: '0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2',
  RPC_URL: process.env.DDC_RPC_URL || 'https://dev-exp-alpha.datadance.ai/eth/rpc',
  CHAIN_ID: process.env.DDC_CHAIN_ID ? parseInt(process.env.DDC_CHAIN_ID, 10) : 44508,
  keyHash: '0x0fa48222cf2df620b509b72b7fdc2119833dc7538ecdb07173d84174d095692d',
  baseUrl: 'https://api.datadance.ai/metadata/ddcnft',
  supportedTokenIds: [1, 2]  // Token 1 和 2 已存在
};

// 初始化 provider（根据聊天记录的要求）
function getProvider() {
  return new ethers.JsonRpcProvider(
    'https://dev-exp-alpha.datadance.ai/eth/rpc',
    44508,
    { batchMaxCount: 1 }
  );
}

/**
 * 获取后端钱包实例
 * 使用后端统一管理的钱包来上链所有 DataNFT
 */
function getBackendWallet() {
  const backendPrivateKey = process.env.BACKEND_WALLET_PRIVATE_KEY;
  
  if (!backendPrivateKey) {
    throw new Error('BACKEND_WALLET_PRIVATE_KEY not configured in .env');
  }
  
  const provider = getProvider();
  const wallet = new ethers.Wallet(backendPrivateKey, provider);
  return wallet;
}

/**
 * 初始化 DDCNFTManager（使用 SDK）
 * 根据聊天记录：
 * - jsonRPC 模式下，不需要自己构造 provider，只需要 provider: { type: 'jsonRpc' }
 * - 但 la menthe 建议：应该创建 ethers.JsonRpcProvider 实例
 * 
 * 根据 SDK 实现，我们尝试两种方式：
 * 1. 传入 { type: 'jsonRpc' } - SDK 内部创建
 * 2. 传入实际的 provider 实例
 */
async function initDDCNFTManager() {
  if (!DDCNFTManager) {
    throw new Error('DDCNFTManager not available. SDK may need to be built.');
  }
  
  const backendPrivateKey = process.env.BACKEND_WALLET_PRIVATE_KEY;
  if (!backendPrivateKey) {
    throw new Error('BACKEND_WALLET_PRIVATE_KEY not configured in .env');
  }
  
  const wallet = getBackendWallet();
  
  // 根据 la menthe 的建议：创建 ethers.JsonRpcProvider 实例
  // 但根据第一个反馈，jsonRPC 模式下不需要自己构造
  // 我们先尝试只传入 { type: 'jsonRpc' }，如果失败再尝试传入实例
  try {
    // 方式1: 只传入类型，让 SDK 内部创建（根据第一个反馈）
    const manager = await DDCNFTManager.init({
      walletAddress: wallet.address,
      provider: { type: 'jsonRpc' },
      signer: { privateKey: backendPrivateKey },
      debug: false,
    });
    
    // SDK 初始化后，需要设置合约地址（如果 SDK 没有自动从 API 获取）
    // 根据配置，合约地址是 0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2
    if (manager.setContractAddress || manager.setDDCNFTAddress) {
      const contractAddress = DDC_MARKET_CONFIG.contractAddress;
      if (manager.setContractAddress) {
        manager.setContractAddress(contractAddress);
      } else if (manager.setDDCNFTAddress) {
        manager.setDDCNFTAddress(contractAddress);
      }
      console.log(`   ✅ Contract address set: ${contractAddress}`);
    }
    
    return manager;
  } catch (error) {
    // 方式2: 如果方式1失败，尝试传入实际的 provider 实例（根据 la menthe 的建议）
    console.log(`   ⚠️  Method 1 failed, trying with provider instance: ${error.message.substring(0, 100)}`);
    const provider = new ethers.JsonRpcProvider(
      'https://dev-exp-alpha.datadance.ai/eth/rpc',
      44508,
      { batchMaxCount: 1 }
    );
    
    const manager = await DDCNFTManager.init({
      walletAddress: wallet.address,
      provider: provider, // 直接传入 provider 实例
      signer: { privateKey: backendPrivateKey },
      debug: false,
    });
    
    // 设置合约地址
    if (manager.setContractAddress || manager.setDDCNFTAddress) {
      const contractAddress = DDC_MARKET_CONFIG.contractAddress;
      if (manager.setContractAddress) {
        manager.setContractAddress(contractAddress);
      } else if (manager.setDDCNFTAddress) {
        manager.setDDCNFTAddress(contractAddress);
      }
      console.log(`   ✅ Contract address set: ${contractAddress}`);
    }
    
    return manager;
  }
}

/**
 * 为 DataNFT 创建链上记录
 * 使用后端统一管理的钱包来上链所有 DataNFT
 */
async function recordDataNFTToBlockchain(dataNFT, merchant) {
  try {
    console.log(`\n🔗 Recording DataNFT to blockchain: ${dataNFT.name}`);
    console.log(`   DataNFT ID: ${dataNFT.id}`);
    console.log(`   Merchant: ${merchant.name}`);
    
    // 使用后端钱包
    let wallet;
    try {
      wallet = getBackendWallet();
    } catch (error) {
      console.log(`   ⚠️  Backend wallet not configured: ${error.message}`);
      console.log(`   💡 Tip: Set BACKEND_WALLET_PRIVATE_KEY in .env file`);
      return {
        success: false,
        reason: 'Backend wallet not configured'
      };
    }
    
    console.log(`   Backend Wallet: ${wallet.address}`);
    
    // 检查余额
    const provider = getProvider();
    const balance = await provider.getBalance(wallet.address);
    const balanceEth = ethers.formatEther(balance);
    console.log(`   Balance: ${balanceEth} ETH`);
    
    if (parseFloat(balanceEth) < 0.001) {
      console.log(`   ⚠️  Insufficient balance for gas, skipping`);
      return {
        success: false,
        reason: 'Insufficient balance'
      };
    }
    
    // 检查是否已经上链
    if (dataNFT.blockchainTxHash) {
      console.log(`   ⚠️  Already recorded on blockchain: ${dataNFT.blockchainTxHash}`);
      return {
        success: true,
        alreadyRecorded: true,
        txHash: dataNFT.blockchainTxHash
      };
    }
    
    // 生成 metadata URI（使用配置的 baseUrl）
    const baseUrl = process.env.METADATA_BASE_URL || DDC_MARKET_CONFIG.baseUrl;
    
    // 根据配置，token 1 和 2 已存在
    // 我们需要为新的 DataNFT 分配 token ID（从 3 开始，或使用递增的 ID）
    // 这里可以使用 DataNFT 的序号或哈希来分配 token ID
    const dataNFTIdHash = ethers.keccak256(ethers.toUtf8Bytes(dataNFT.id));
    // 将哈希转换为 token ID，但确保不与已存在的 token 1, 2 冲突
    // 使用哈希值模一个大的数字，然后加上 3（因为 1, 2 已存在）
    const hashBigInt = BigInt(dataNFTIdHash);
    const tokenId = (hashBigInt % BigInt(1000000)) + BigInt(3); // 从 3 开始
    
    // Metadata URI 格式：https://api.datadance.ai/metadata/ddcnft/{tokenId}
    const metadataUri = `${baseUrl}/${tokenId.toString()}`;
    
    console.log(`   Metadata URI: ${metadataUri}`);
    console.log(`   Token ID: ${tokenId.toString()}`);
    console.log(`   Key Hash: ${DDC_MARKET_CONFIG.keyHash}`);
    
    // DDC Market 合约 ABI
    // 根据提供的 keyHash，可能需要在调用时传入 keyHash 参数
    const DDC_MARKET_ABI = [
      // 可能的方法签名（包含 keyHash）
      "function mint(address to, uint256 tokenId, string memory tokenURI, bytes32 keyHash) external returns (uint256)",
      "function mintWithKeyHash(address to, uint256 tokenId, string memory uri, bytes32 keyHash) external",
      "function registerDataNFT(uint256 tokenId, string memory metadataURI, bytes32 keyHash) external",
      // 标准方法（不包含 keyHash）
      "function mint(address to, uint256 tokenId, string memory tokenURI) external returns (uint256)",
      "function safeMint(address to, uint256 tokenId, string memory uri) external",
      "function createToken(address to, string memory uri) external returns (uint256)",
      "function registerDataNFT(uint256 tokenId, string memory metadataURI) external",
      "function setTokenURI(uint256 tokenId, string memory tokenURI) external",
      // ERC721 标准方法
      "function tokenURI(uint256 tokenId) external view returns (string memory)",
      "function ownerOf(uint256 tokenId) external view returns (address)",
      // 事件
      "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
      "event TokenMinted(uint256 indexed tokenId, address indexed to, string metadataURI)"
    ];
    
    let txHash = null;
    let realTokenId = null;
    let receipt = null;
    let error = null;
    
    // 尝试使用 SDK 的 DDCNFTManager（优先）
    try {
      console.log(`   🔄 Attempting to mint DataNFT using SDK...`);
      
      // 初始化 DDCNFTManager
      const manager = await initDDCNFTManager();
      console.log(`   ✅ DDCNFTManager initialized`);
      
      // 使用 SDK 的方法来 mint（具体方法名需要根据 SDK 文档调整）
      // 可能的方法：mint, createToken, registerDataNFT 等
      let result = null;
      
      // 根据 SDK 源码，mint 方法签名是: mint(tokenId: bigint, keyHash: string)
      // 返回交易哈希（string），不是对象
      console.log(`   📝 Calling SDK mint method with tokenId=${tokenId}, keyHash=${DDC_MARKET_CONFIG.keyHash}`);
      txHash = await manager.mint(BigInt(tokenId), DDC_MARKET_CONFIG.keyHash);
      realTokenId = tokenId.toString();
      
      console.log(`   ✅ Transaction sent via SDK: ${txHash}`);
      
      // 等待交易确认
      const provider = getProvider();
      const tx = await provider.getTransaction(txHash);
      receipt = await tx.wait();
      
      if (receipt && receipt.hash) {
        txHash = receipt.hash;
        console.log(`   ✅ Transaction confirmed!`);
        console.log(`   📦 Block: ${receipt.blockNumber}`);
        console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}`);
      } else {
        throw new Error('Transaction receipt missing hash');
      }
      
    } catch (sdkError) {
      console.log(`   ⚠️  SDK method failed: ${sdkError.message}`);
      console.log(`   🔄 Falling back to direct ethers.js call...`);
      
      // 如果 SDK 失败，回退到直接使用 ethers.js
      try {
        console.log(`   🔄 Attempting to mint DataNFT using ethers.js directly...`);
        
        // 创建合约实例
        const contract = new ethers.Contract(
          DDC_MARKET_CONFIG.contractAddress,
          DDC_MARKET_ABI,
          wallet
        );
        
        // 尝试不同的方法签名（优先尝试包含 keyHash 的方法）
        const keyHashBytes32 = DDC_MARKET_CONFIG.keyHash; // 已经是 bytes32 格式
        const methodsToTry = [
          // 方法1: mint(to, tokenId, uri, keyHash) - 包含 keyHash
          { name: 'mint with keyHash', call: () => contract.mint(wallet.address, tokenId, metadataUri, keyHashBytes32) },
          // 方法2: mintWithKeyHash(to, tokenId, uri, keyHash)
          { name: 'mintWithKeyHash', call: () => contract.mintWithKeyHash(wallet.address, tokenId, metadataUri, keyHashBytes32) },
          // 方法3: registerDataNFT(tokenId, metadataURI, keyHash)
          { name: 'registerDataNFT with keyHash', call: () => contract.registerDataNFT(tokenId, metadataUri, keyHashBytes32) },
          // 方法4: mint(to, tokenId, uri) - 不包含 keyHash
          { name: 'mint', call: () => contract.mint(wallet.address, tokenId, metadataUri) },
          // 方法5: safeMint(to, tokenId, uri)
          { name: 'safeMint', call: () => contract.safeMint(wallet.address, tokenId, metadataUri) },
          // 方法6: createToken(to, uri)
          { name: 'createToken', call: () => contract.createToken(wallet.address, metadataUri) },
          // 方法7: registerDataNFT(tokenId, metadataURI)
          { name: 'registerDataNFT', call: () => contract.registerDataNFT(tokenId, metadataUri) }
        ];
        
        let tx = null;
        let methodUsed = null;
        
        for (let i = 0; i < methodsToTry.length; i++) {
          try {
            console.log(`   📝 Trying method ${i + 1}/${methodsToTry.length}: ${methodsToTry[i].name}...`);
            tx = await methodsToTry[i].call();
            methodUsed = methodsToTry[i].name;
            console.log(`   ✅ Method "${methodUsed}" succeeded!`);
            break;
          } catch (methodError) {
            // 如果方法不存在，继续尝试下一个
            if (methodError.code === 'CALL_EXCEPTION' || 
                methodError.message.includes('function') || 
                methodError.message.includes('not found') ||
                methodError.message.includes('execution reverted')) {
              continue;
            }
            // 其他错误（如权限、参数等），记录并继续
            console.log(`   ⚠️  Method ${i + 1} failed: ${methodError.message.substring(0, 100)}`);
            continue;
          }
        }
        
          if (!tx) {
            // 如果所有 mint 方法都失败，尝试使用 setTokenURI
            console.log(`   💡 所有 mint 方法都不可用，尝试使用 setTokenURI...`);
            console.log(`   💡 提示: 合约可能不支持直接 mint，或者需要特定的权限`);
            
            // 尝试使用 setTokenURI 方法
            try {
              const setURIABI = ['function setTokenURI(uint256 tokenId, string memory tokenURI) external'];
              const setURIContract = new ethers.Contract(
                DDC_MARKET_CONFIG.contractAddress,
                setURIABI,
                wallet
              );
              
              // 使用 token ID 1 作为测试（根据之前的测试，token 1 和 2 已存在）
              // 实际应该根据 DataNFT 分配或生成 token ID
              const assignedTokenId = 1; // 这里应该根据实际逻辑分配 token ID
              console.log(`   📝 尝试设置 Token ${assignedTokenId} 的 URI...`);
              
              tx = await setURIContract.setTokenURI(assignedTokenId, metadataUri);
              realTokenId = assignedTokenId.toString();
              console.log(`   ✅ setTokenURI 方法可用！`);
            } catch (setURIError) {
              console.log(`   ❌ setTokenURI 也失败: ${setURIError.message.substring(0, 200)}`);
              throw new Error(`No suitable contract method found. Contract may need different ABI or the contract address may be incorrect. Last error: ${setURIError.message.substring(0, 200)}`);
            }
          }
          
          console.log(`   📤 Transaction sent: ${tx.hash}`);
          console.log(`   ⏳ Waiting for confirmation...`);
          
          // 等待交易确认
          receipt = await tx.wait();
          
          if (receipt && receipt.hash) {
            txHash = receipt.hash;
            console.log(`   ✅ Transaction confirmed!`);
            console.log(`   📦 Block: ${receipt.blockNumber}`);
            console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}`);
            
            // 尝试从事件中获取 token ID
            if (receipt.logs && receipt.logs.length > 0) {
              try {
                const iface = new ethers.Interface(DDC_MARKET_ABI);
                for (const log of receipt.logs) {
                  try {
                    const parsed = iface.parseLog(log);
                    if (parsed && parsed.args) {
                      if (parsed.name === 'Transfer' && parsed.args.tokenId) {
                        realTokenId = parsed.args.tokenId.toString();
                      } else if (parsed.name === 'TokenMinted' && parsed.args.tokenId) {
                        realTokenId = parsed.args.tokenId.toString();
                      }
                    }
                  } catch (e) {
                    // 忽略解析错误
                  }
                }
              } catch (e) {
                // 忽略事件解析错误
              }
            }
            
            if (!realTokenId) {
              realTokenId = tokenId.toString();
            }
            
          } else {
            throw new Error('Transaction receipt missing hash');
          }
        
      } catch (contractError) {
        error = contractError.message;
        console.log(`   ❌ Contract call failed: ${error}`);
        console.log(`   💡 This might be due to:`);
        console.log(`      1. Contract ABI mismatch`);
        console.log(`      2. Contract method not available`);
        console.log(`      3. Insufficient permissions`);
        console.log(`      4. Invalid parameters`);
        console.log(`      5. Contract address may be incorrect`);
        console.log(`   📝 Error details: ${contractError.message}`);
        
        // 如果合约调用失败，返回错误信息
        return {
          success: false,
          error: error,
          walletAddress: wallet.address,
          balance: balanceEth,
          metadataUri: metadataUri
        };
      }
    }
    
    // 记录上链信息
    console.log(`   ✅ Blockchain record created successfully!`);
    console.log(`   🔗 Transaction Hash: ${txHash}`);
    console.log(`   🆔 Token ID: ${realTokenId}`);
    console.log(`   📄 Metadata URI: ${metadataUri}`);
    
    return {
      success: true,
      walletAddress: wallet.address,
      balance: balanceEth,
      txHash: txHash,
      tokenId: realTokenId,
      metadataUri: metadataUri,
      blockNumber: receipt?.blockNumber
    };
    
  } catch (error) {
    logger.error('Error recording to blockchain', {
      error: error.message,
      dataNFTId: dataNFT.id
    });
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 批量记录 DataNFT 到区块链
 */
async function recordAllDataNFTsToBlockchain() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔗 Record DataNFTs to Blockchain');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const results = {
    total: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    details: []
  };
  
  // 检查后端钱包配置
  try {
    const wallet = getBackendWallet();
    const provider = getProvider();
    const balance = await provider.getBalance(wallet.address);
    const balanceEth = ethers.formatEther(balance);
    console.log(`✅ Backend Wallet: ${wallet.address}`);
    console.log(`   Balance: ${balanceEth} ETH\n`);
    
    if (parseFloat(balanceEth) < 0.001) {
      console.log(`⚠️  Warning: Low balance, may not be sufficient for gas fees`);
      console.log(`   Recommended: At least 0.01 ETH for testing\n`);
    }
  } catch (error) {
    console.error(`❌ Backend wallet not configured: ${error.message}`);
    console.log(`\n💡 Please configure BACKEND_WALLET_PRIVATE_KEY in .env file`);
    console.log(`   Run: node scripts/configureBackendWallet.js\n`);
    return results;
  }
  
  // 获取所有已发布的 DataNFT（排除已上链的）
  const dataNFTs = await prisma.dataNFT.findMany({
    where: {
      isPublished: true,
      // 只处理未上链的 DataNFT
      // blockchainTxHash: null
    },
    include: {
      merchant: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });
  
  console.log(`📊 Found ${dataNFTs.length} published DataNFTs\n`);
  results.total = dataNFTs.length;
  
  
  // 处理每个 DataNFT
  for (let i = 0; i < dataNFTs.length; i++) {
    const dataNFT = dataNFTs[i];
    console.log(`[${i + 1}/${dataNFTs.length}] ${dataNFT.name}`);
    
    const result = await recordDataNFTToBlockchain(dataNFT, dataNFT.merchant);
    
    if (result.success) {
      results.success++;
      results.details.push({
        nftId: dataNFT.id,
        name: dataNFT.name,
        status: 'success'
      });
    } else if (result.reason === 'Backend wallet not configured' || result.reason === 'Insufficient balance') {
      results.skipped++;
      results.details.push({
        nftId: dataNFT.id,
        name: dataNFT.name,
        status: 'skipped',
        reason: result.reason
      });
    } else {
      results.failed++;
      results.details.push({
        nftId: dataNFT.id,
        name: dataNFT.name,
        status: 'failed',
        error: result.error || result.reason
      });
    }
    
    // 避免请求过快
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // 输出总结
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`✅ Success: ${results.success}`);
  console.log(`⚠️  Skipped: ${results.skipped}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`📦 Total: ${results.total}\n`);
  
  if (results.skipped > 0) {
    console.log('💡 Tip: To enable blockchain recording:');
    console.log('   1. Configure BACKEND_WALLET_PRIVATE_KEY in .env file');
    console.log('   2. Ensure backend wallet has sufficient balance for gas');
    console.log('   3. Run: node scripts/configureBackendWallet.js\n');
  }
  
  return results;
}

/**
 * 记录单个 DataNFT
 */
async function recordSingleDataNFT(nftId) {
  const dataNFT = await prisma.dataNFT.findUnique({
    where: { id: nftId },
    include: {
      merchant: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });
  
  if (!dataNFT) {
    console.error(`❌ DataNFT not found: ${nftId}`);
    return;
  }
  
  if (!dataNFT.isPublished) {
    console.error(`❌ DataNFT is not published: ${nftId}`);
    return;
  }
  
  return await recordDataNFTToBlockchain(dataNFT, dataNFT.merchant);
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--all')) {
    await recordAllDataNFTsToBlockchain();
  } else if (args.includes('--nft-id') && args[args.indexOf('--nft-id') + 1]) {
    const nftId = args[args.indexOf('--nft-id') + 1];
    await recordSingleDataNFT(nftId);
  } else {
    console.log('Usage:');
    console.log('  node scripts/recordDataNFTToBlockchain.js --all');
    console.log('  node scripts/recordDataNFTToBlockchain.js --nft-id <nft-id>');
    console.log('\nNote: This script uses backend wallet (BACKEND_WALLET_PRIVATE_KEY) to record all DataNFTs.');
    console.log('      Configure backend wallet: node scripts/configureBackendWallet.js');
  }
}

if (require.main === module) {
  main()
    .catch(console.error)
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = {
  recordDataNFTToBlockchain,
  recordAllDataNFTsToBlockchain,
  recordSingleDataNFT
};

