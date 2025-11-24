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
    getKeyHash = sandbox.module.exports.getKeyHash || sandbox.exports.getKeyHash;
    
    if (DDCNFTManager) {
      console.log('✅ DDC Market SDK loaded successfully (manual load)');
      if (getKeyHash) {
        console.log('✅ getKeyHash function loaded');
      }
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
    // 方式1: 只传入类型，让 SDK 内部创建（根据 demo，walletAddress 可以是空字符串，SDK 会自动提取）
    const manager = await DDCNFTManager.init({
      walletAddress: '', // 空字符串，SDK 会自动从 privateKey 提取地址（与 demo 一致）
      provider: { type: 'jsonRpc' },
      signer: { privateKey: backendPrivateKey },
      debug: false,
    });
    
    // SDK 初始化后，先获取已部署的合约列表（根据 demo）
    const deployedContracts = manager.getAllDeployedAddresses ? manager.getAllDeployedAddresses() : [];
    console.log(`   📋 Found ${deployedContracts.length} deployed contracts`);
    
    // 设置合约地址（使用已部署的合约地址，地址比较需要转换为小写）
    const contractAddressLower = DDC_MARKET_CONFIG.contractAddress.toLowerCase();
    const deployedLower = deployedContracts.map(addr => addr.toLowerCase());
    
    // 如果合约在已部署列表中，使用列表中的地址（保持原始大小写）
    let contractAddressToUse = DDC_MARKET_CONFIG.contractAddress;
    if (deployedLower.includes(contractAddressLower)) {
      const foundAddress = deployedContracts.find(addr => addr.toLowerCase() === contractAddressLower);
      contractAddressToUse = foundAddress;
      console.log(`   ✅ Contract ${foundAddress} found in deployed contracts`);
    } else {
      console.log(`   ⚠️  Contract ${DDC_MARKET_CONFIG.contractAddress} not in deployed list, setting manually`);
    }
    
    if (manager.setContractAddress || manager.setDDCNFTAddress) {
      if (manager.setContractAddress) {
        manager.setContractAddress(contractAddressToUse);
      } else if (manager.setDDCNFTAddress) {
        manager.setDDCNFTAddress(contractAddressToUse);
      }
      console.log(`   ✅ Contract address set: ${contractAddressToUse}`);
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
    
    // SDK 初始化后，先获取已部署的合约列表（根据 demo）
    const deployedContracts = manager.getAllDeployedAddresses ? manager.getAllDeployedAddresses() : [];
    console.log(`   📋 Found ${deployedContracts.length} deployed contracts`);
    
    // 设置合约地址（使用已部署的合约地址，地址比较需要转换为小写）
    const contractAddressLower = DDC_MARKET_CONFIG.contractAddress.toLowerCase();
    const deployedLower = deployedContracts.map(addr => addr.toLowerCase());
    
    // 如果合约在已部署列表中，使用列表中的地址（保持原始大小写）
    let contractAddressToUse = DDC_MARKET_CONFIG.contractAddress;
    if (deployedLower.includes(contractAddressLower)) {
      const foundAddress = deployedContracts.find(addr => addr.toLowerCase() === contractAddressLower);
      contractAddressToUse = foundAddress;
      console.log(`   ✅ Contract ${foundAddress} found in deployed contracts`);
    } else {
      console.log(`   ⚠️  Contract ${DDC_MARKET_CONFIG.contractAddress} not in deployed list, setting manually`);
    }
    
    if (manager.setContractAddress || manager.setDDCNFTAddress) {
      if (manager.setContractAddress) {
        manager.setContractAddress(contractAddressToUse);
      } else if (manager.setDDCNFTAddress) {
        manager.setDDCNFTAddress(contractAddressToUse);
      }
      console.log(`   ✅ Contract address set: ${contractAddressToUse}`);
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
    if (dataNFT.blockchainTxHash && dataNFT.blockchainTokenId) {
      console.log(`   ⚠️  Already recorded on blockchain:`);
      console.log(`      Transaction Hash: ${dataNFT.blockchainTxHash}`);
      console.log(`      Token ID: ${dataNFT.blockchainTokenId}`);
      return {
        success: true,
        alreadyRecorded: true,
        txHash: dataNFT.blockchainTxHash,
        tokenId: dataNFT.blockchainTokenId
      };
    }
    
    // 生成 metadata URI（使用配置的 baseUrl）
    const baseUrl = process.env.METADATA_BASE_URL || DDC_MARKET_CONFIG.baseUrl;
    
    // 生成 token ID：使用自增序号，确保不重复
    // 1. 查询链上已存在的最大 tokenId（从 1 开始检查）
    // 注意：合约的 ownerOf 返回 bytes32，不是 address
    const checkProvider = getProvider();
    const checkABI = ['function ownerOf(uint256) view returns (bytes32)'];
    const checkContract = new ethers.Contract(DDC_MARKET_CONFIG.contractAddress, checkABI, checkProvider);
    
    let maxTokenIdOnChain = BigInt(0);
    let checkTokenId = BigInt(1);
    let maxChainChecks = 10000; // 最多检查 10000 个 token
    
    console.log(`   🔍 Checking on-chain token IDs to find max...`);
    while (checkTokenId <= BigInt(maxChainChecks)) {
      try {
        await checkContract.ownerOf(checkTokenId);
        // Token 存在，更新最大值
        maxTokenIdOnChain = checkTokenId;
        checkTokenId = checkTokenId + 1n;
      } catch (error) {
        // Token 不存在，停止检查
        break;
      }
    }
    
    // 2. 查询数据库中已上链的最大 tokenId（作为备用检查）
    const maxTokenIdInDb = await prisma.dataNFT.findFirst({
      where: {
        blockchainTokenId: { not: null }
      },
      orderBy: {
        blockchainTokenId: 'desc'
      },
      select: {
        blockchainTokenId: true
      }
    });
    
    const maxTokenIdInDbBigInt = maxTokenIdInDb?.blockchainTokenId 
      ? BigInt(maxTokenIdInDb.blockchainTokenId) 
      : BigInt(0);
    
    // 3. 使用链上和数据库中的最大值，取较大者 + 1 作为新的 tokenId
    const nextTokenId = (maxTokenIdInDbBigInt > maxTokenIdOnChain 
      ? maxTokenIdInDbBigInt 
      : maxTokenIdOnChain) + 1n;
    
    // 4. 确保 tokenId 至少从 1 开始（如果链上没有任何 token）
    const tokenId = nextTokenId < BigInt(1) ? BigInt(1) : nextTokenId;
    
    // 5. 再次检查这个 tokenId 是否已存在（双重保险）
    let finalTokenId = tokenId;
    let attempts = 0;
    const maxAttempts = 100;
    
    while (attempts < maxAttempts) {
      try {
        const owner = await checkContract.ownerOf(finalTokenId);
        // Token 已存在（ownerOf 返回 bytes32），递增
        console.log(`   ⚠️  Token ID ${finalTokenId} already exists (owner: ${owner}), trying ${finalTokenId + 1n}...`);
        finalTokenId = finalTokenId + 1n;
        attempts++;
      } catch (error) {
        // Token 不存在，可以使用
        break;
      }
    }
    
    if (attempts >= maxAttempts) {
      throw new Error(`Failed to find available token ID after ${maxAttempts} attempts`);
    }
    
    console.log(`   📊 Token ID generation:`);
    console.log(`      Max in DB: ${maxTokenIdInDbBigInt.toString()}`);
    console.log(`      Max on-chain: ${maxTokenIdOnChain.toString()}`);
    console.log(`      Calculated: ${tokenId.toString()}`);
    console.log(`      Final Token ID (after duplicate check): ${finalTokenId.toString()}`);
    
    // Metadata URI 格式：https://api.datadance.ai/metadata/ddcnft/{tokenId}
    const metadataUri = `${baseUrl}/${finalTokenId.toString()}`;
    
    console.log(`   📝 Metadata URI: ${metadataUri}`);
    console.log(`   🆔 Token ID (Serial): ${finalTokenId.toString()}`);
    console.log(`   🔑 Key Hash: ${DDC_MARKET_CONFIG.keyHash}`);
    
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
    
    // 使用 SDK 的 DDCNFTManager（仅使用 SDK，不使用 ethers.js）
    try {
      console.log(`   🔄 Attempting to mint DataNFT using SDK...`);
      
      // 初始化 DDCNFTManager
      const manager = await initDDCNFTManager();
      console.log(`   ✅ DDCNFTManager initialized`);
      
      // 尝试不同的 SDK mint 方法调用方式
      // 方式1: mint(tokenId, keyHash) - 根据之前的实现
      // 方式2: mint(tokenId, keyHash, metadataUri) - 可能需要 metadata URI
      // 方式3: mint({ tokenId, keyHash, metadataUri }) - 对象参数
      
      let mintResult = null;
      
      // 根据 demo，需要使用 getKeyHash 从 privateKey 生成 keyHash
      let keyHash = null;
      if (getKeyHash) {
        try {
          const backendPrivateKey = process.env.BACKEND_WALLET_PRIVATE_KEY;
          if (backendPrivateKey) {
            // getKeyHash 是同步函数，接受 privateKey 字符串
            keyHash = getKeyHash(backendPrivateKey);
            console.log(`   ✅ Generated keyHash from privateKey using getKeyHash`);
          } else {
            throw new Error('BACKEND_WALLET_PRIVATE_KEY not found');
          }
        } catch (keyHashError) {
          console.log(`   ⚠️  Failed to generate keyHash: ${keyHashError.message}`);
          console.log(`   💡 Falling back to configured keyHash`);
          keyHash = DDC_MARKET_CONFIG.keyHash;
        }
      } else {
        console.log(`   ⚠️  getKeyHash function not available, using configured keyHash`);
        keyHash = DDC_MARKET_CONFIG.keyHash;
      }
      
      // 根据 demo，mint 方法签名是: mint(tokenId: bigint, keyHash: string)
      console.log(`   📝 Calling SDK mint(tokenId=${finalTokenId}, keyHash=${keyHash.substring(0, 10)}...)...`);
      mintResult = await manager.mint(BigInt(finalTokenId), keyHash);
      console.log(`   ✅ SDK mint method succeeded`);
      
      // mintResult 可能是交易哈希（string）或交易对象
      if (typeof mintResult === 'string') {
        txHash = mintResult;
      } else if (mintResult && mintResult.hash) {
        txHash = mintResult.hash;
      } else if (mintResult && typeof mintResult === 'object' && mintResult.txHash) {
        txHash = mintResult.txHash;
      } else {
        throw new Error('SDK mint returned unexpected result format');
      }
      
      realTokenId = finalTokenId.toString();
      
      console.log(`   ✅ Transaction sent via SDK: ${txHash}`);
      
      // 等待交易确认
      const provider = getProvider();
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        throw new Error('Transaction not found');
      }
      
      receipt = await tx.wait();
      
      if (receipt && receipt.hash) {
        txHash = receipt.hash;
        console.log(`   ✅ Transaction confirmed!`);
        console.log(`   📦 Block: ${receipt.blockNumber}`);
        console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}`);
        
        // 尝试从事件中获取 token ID
        if (receipt.logs && receipt.logs.length > 0) {
          try {
            const TransferABI = ['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'];
            const TokenMintedABI = ['event TokenMinted(uint256 indexed tokenId, address indexed to, string metadataURI)'];
            const iface = new ethers.Interface([...TransferABI, ...TokenMintedABI]);
            
            for (const log of receipt.logs) {
              try {
                const parsed = iface.parseLog(log);
                if (parsed && parsed.args) {
                  if (parsed.name === 'Transfer' && parsed.args.tokenId) {
                    realTokenId = parsed.args.tokenId.toString();
                    break;
                  } else if (parsed.name === 'TokenMinted' && parsed.args.tokenId) {
                    realTokenId = parsed.args.tokenId.toString();
                    break;
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
          realTokenId = finalTokenId.toString();
        }
      } else {
        throw new Error('Transaction receipt missing hash');
      }
      
    } catch (sdkError) {
      error = sdkError.message;
      console.log(`   ❌ SDK method failed: ${error}`);
      console.log(`   💡 This might be due to:`);
      console.log(`      1. SDK mint method signature incorrect`);
      console.log(`      2. Contract method not available`);
      console.log(`      3. Insufficient permissions (wallet may not be contract owner)`);
      console.log(`      4. Invalid parameters`);
      console.log(`      5. Contract address may be incorrect`);
      console.log(`   📝 Error details: ${sdkError.message}`);
      
      // SDK 失败，返回错误信息（不再回退到 ethers.js）
      return {
        success: false,
        error: error,
        walletAddress: wallet.address,
        balance: balanceEth,
        metadataUri: metadataUri,
        tokenId: tokenId.toString()
      };
    }
    
    // 记录上链信息
    console.log(`   ✅ Blockchain record created successfully!`);
    console.log(`   🔗 Transaction Hash: ${txHash}`);
    console.log(`   🆔 Token ID: ${realTokenId}`);
    console.log(`   📄 Metadata URI: ${metadataUri}`);
    
    // 更新数据库，保存 tokenId 和 txHash
    try {
      await prisma.dataNFT.update({
        where: { id: dataNFT.id },
        data: {
          blockchainTokenId: realTokenId,
          blockchainTxHash: txHash,
          blockchainRecordedAt: new Date()
        }
      });
      console.log(`   💾 Database updated with blockchain info`);
    } catch (dbError) {
      console.log(`   ⚠️  Failed to update database: ${dbError.message}`);
      // 即使数据库更新失败，也返回成功（因为链上已经成功）
    }
    
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
      blockchainTxHash: null
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

