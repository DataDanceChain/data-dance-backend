# 后端使用 ethers.js 最佳实践

## ✅ 为什么后端推荐使用 ethers.js

### 1. 直接控制
- **无需浏览器环境**: 后端不需要处理浏览器钱包集成
- **直接使用私钥**: 可以使用私钥直接签名交易
- **完全控制**: 不依赖 SDK 的封装，更灵活

### 2. 安全性
- **私钥管理**: 私钥存储在服务器端，更安全
- **环境变量**: 可以通过环境变量管理私钥
- **权限控制**: 可以精确控制哪些操作需要权限

### 3. 性能
- **轻量级**: ethers.js 比 SDK 更轻量
- **无依赖**: 不需要额外的 SDK 依赖
- **快速**: 直接调用合约，减少中间层

### 4. 灵活性
- **自定义 ABI**: 可以使用任何合约的 ABI
- **错误处理**: 可以自定义错误处理逻辑
- **交易控制**: 可以控制 gas 价格、gas limit 等

## 📋 后端 ethers.js 实现模式

### 基本结构

```javascript
const ethers = require('ethers');

// 1. 创建 Provider
const provider = new ethers.JsonRpcProvider(
  RPC_URL,
  CHAIN_ID,
  { batchMaxCount: 1 }  // 避免批量请求问题
);

// 2. 创建 Wallet（使用私钥）
const wallet = new ethers.Wallet(
  process.env.BACKEND_WALLET_PRIVATE_KEY,
  provider
);

// 3. 创建合约实例
const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  wallet  // 使用 wallet 作为 signer
);

// 4. 调用合约方法
const tx = await contract.someMethod(...args);

// 5. 等待交易确认
const receipt = await tx.wait();

// 6. 获取交易哈希
const txHash = receipt.hash;
```

## 🔧 当前实现优化

### 1. Provider 配置

```javascript
function getProvider() {
  return new ethers.JsonRpcProvider(
    DDC_MARKET_CONFIG.RPC_URL,
    DDC_MARKET_CONFIG.CHAIN_ID,
    {
      batchMaxCount: 1,  // 重要：避免批量请求问题
    }
  );
}
```

### 2. Wallet 创建

```javascript
function getBackendWallet() {
  const backendPrivateKey = process.env.BACKEND_WALLET_PRIVATE_KEY;
  
  if (!backendPrivateKey) {
    throw new Error('BACKEND_WALLET_PRIVATE_KEY not configured');
  }
  
  const provider = getProvider();
  return new ethers.Wallet(backendPrivateKey, provider);
}
```

### 3. 合约调用

```javascript
// 创建合约实例
const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  wallet
);

// 调用方法（会自动签名）
const tx = await contract.methodName(...args);

// 等待确认
const receipt = await tx.wait();
```

## 🎯 常见用例

### 用例 1: Mint NFT

```javascript
async function mintNFT(to, tokenId, tokenURI) {
  const wallet = getBackendWallet();
  const contract = new ethers.Contract(
    CONTRACT_ADDRESS,
    ['function mint(address to, uint256 tokenId, string memory uri)'],
    wallet
  );
  
  const tx = await contract.mint(to, tokenId, tokenURI);
  const receipt = await tx.wait();
  
  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString()
  };
}
```

### 用例 2: 设置 Token URI

```javascript
async function setTokenURI(tokenId, tokenURI) {
  const wallet = getBackendWallet();
  const contract = new ethers.Contract(
    CONTRACT_ADDRESS,
    ['function setTokenURI(uint256 tokenId, string memory tokenURI)'],
    wallet
  );
  
  const tx = await contract.setTokenURI(tokenId, tokenURI);
  const receipt = await tx.wait();
  
  return receipt.hash;
}
```

### 用例 3: 读取合约数据

```javascript
async function getTokenURI(tokenId) {
  const provider = getProvider();
  const contract = new ethers.Contract(
    CONTRACT_ADDRESS,
    ['function tokenURI(uint256 tokenId) view returns (string)'],
    provider  // 只读操作不需要 wallet
  );
  
  return await contract.tokenURI(tokenId);
}
```

## ⚠️ 注意事项

### 1. 私钥安全

```javascript
// ✅ 正确：使用环境变量
const privateKey = process.env.BACKEND_WALLET_PRIVATE_KEY;

// ❌ 错误：硬编码私钥
const privateKey = "0x1234...";
```

### 2. Gas 管理

```javascript
// 设置 gas limit
const tx = await contract.mint(...args, {
  gasLimit: 100000
});

// 设置 gas price
const tx = await contract.mint(...args, {
  gasPrice: ethers.parseUnits("20", "gwei")
});
```

### 3. 错误处理

```javascript
try {
  const tx = await contract.mint(...args);
  const receipt = await tx.wait();
  return receipt.hash;
} catch (error) {
  if (error.code === 'CALL_EXCEPTION') {
    // 合约调用失败
  } else if (error.code === 'INSUFFICIENT_FUNDS') {
    // 余额不足
  } else {
    // 其他错误
  }
  throw error;
}
```

### 4. 交易确认

```javascript
// 等待 1 个确认
const receipt = await tx.wait(1);

// 等待多个确认
const receipt = await tx.wait(3);
```

## 🔍 调试技巧

### 1. 检查余额

```javascript
const balance = await provider.getBalance(wallet.address);
console.log('Balance:', ethers.formatEther(balance), 'ETH');
```

### 2. 估算 Gas

```javascript
try {
  const gasEstimate = await contract.mint.estimateGas(...args);
  console.log('Gas estimate:', gasEstimate.toString());
} catch (error) {
  console.error('Gas estimation failed:', error.message);
}
```

### 3. 检查合约方法

```javascript
// 检查方法是否存在
try {
  await contract.mint.staticCall(...args);
  console.log('Method exists');
} catch (error) {
  console.log('Method does not exist or failed');
}
```

## 📊 与 SDK 对比

| 特性 | ethers.js | SDK |
|------|-----------|-----|
| **后端使用** | ✅ 推荐 | ⚠️ 需要构建 |
| **浏览器使用** | ✅ 支持 | ✅ 支持 |
| **私钥管理** | ✅ 直接支持 | ⚠️ 需要配置 |
| **灵活性** | ✅ 高 | ⚠️ 受限于 SDK |
| **学习曲线** | ⚠️ 需要了解 ABI | ✅ 更简单 |
| **依赖** | ✅ 轻量 | ⚠️ 可能有依赖 |

## 🚀 最佳实践总结

1. **使用环境变量管理私钥**
2. **配置合适的 Provider 选项**
3. **添加完善的错误处理**
4. **记录所有交易哈希**
5. **监控钱包余额**
6. **使用 TypeScript 类型定义（可选）**

## 📚 相关资源

- [ethers.js 官方文档](https://docs.ethers.org/)
- [后端钱包配置指南](./BACKEND_WALLET_SETUP.md)
- [区块链测试结果](./BLOCKCHAIN_TEST_RESULTS.md)

---

**最后更新**: 2025年1月
**状态**: ✅ 后端推荐使用 ethers.js










