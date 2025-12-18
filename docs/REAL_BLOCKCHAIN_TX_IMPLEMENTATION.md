# 真实链上交易实现说明

## ✅ 实现完成

已实现真实的链上交易调用，替换了之前的模拟交易哈希生成逻辑。

## 🔧 实现细节

### 1. 合约调用方式

使用 `ethers.js` 直接调用 DDC Market 合约，而不是生成模拟的交易哈希。

### 2. 合约方法尝试策略

脚本会自动尝试多种可能的合约方法：

1. **mint(to, tokenId, uri)** - 标准 mint 方法
2. **safeMint(to, tokenId, uri)** - 安全的 mint 方法
3. **createToken(to, uri)** - 创建 token 方法
4. **registerDataNFT(tokenId, metadataURI)** - 注册 DataNFT 方法

如果某个方法不存在或失败，会自动尝试下一个方法。

### 3. 交易流程

```
1. 生成 metadata URI
   ↓
2. 计算 token ID（基于 DataNFT ID 的哈希）
   ↓
3. 创建合约实例
   ↓
4. 尝试调用合约方法
   ↓
5. 发送交易到区块链
   ↓
6. 等待交易确认
   ↓
7. 获取真实的交易哈希
   ↓
8. 从事件中提取 token ID
   ↓
9. 返回交易结果
```

### 4. 关键代码

```javascript
// 创建合约实例
const contract = new ethers.Contract(
  DDC_MARKET_CONFIG.contractAddress,
  DDC_MARKET_ABI,
  wallet
);

// 尝试调用合约方法
const tx = await contract.mint(wallet.address, tokenId, metadataUri);

// 等待交易确认
const receipt = await tx.wait();

// 获取真实的交易哈希
const txHash = receipt.hash;
```

## 📋 合约配置

### DDC Market 合约地址

```
0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2
```

### 合约 ABI

包含以下方法：

- `mint(address to, uint256 tokenId, string memory tokenURI)`
- `safeMint(address to, uint256 tokenId, string memory uri)`
- `createToken(address to, string memory uri)`
- `registerDataNFT(uint256 tokenId, string memory metadataURI)`
- `setTokenURI(uint256 tokenId, string memory tokenURI)`
- `tokenURI(uint256 tokenId)` (view)
- `ownerOf(uint256 tokenId)` (view)

### 事件

- `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`
- `TokenMinted(uint256 indexed tokenId, address indexed to, string metadataURI)`

## 🧪 测试方法

### 测试单个 DataNFT

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/recordDataNFTToBlockchain.js --nft-id <nft-id>
```

### 批量上链所有 DataNFT

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/recordDataNFTToBlockchain.js --all
```

## 📊 返回结果

成功时返回：

```javascript
{
  success: true,
  walletAddress: "0x...",
  balance: "0.0999979 ETH",
  txHash: "0x...",           // 真实的交易哈希
  tokenId: "1234567890...",  // Token ID
  metadataUri: "https://...",
  blockNumber: 12345         // 区块号
}
```

失败时返回：

```javascript
{
  success: false,
  error: "错误信息",
  walletAddress: "0x...",
  balance: "0.0999979 ETH",
  metadataUri: "https://..."
}
```

## ⚠️ 注意事项

### 1. Gas 费用

- 确保后端钱包有足够的余额支付 gas 费用
- 建议至少 0.01 ETH 用于测试
- 实际 gas 费用取决于网络拥堵情况

### 2. 合约方法

- 如果所有方法都失败，可能是：
  - 合约 ABI 不匹配
  - 合约地址不正确
  - 合约方法名称不同
  - 权限不足

### 3. 交易确认

- 交易需要等待区块链确认
- 确认时间取决于网络速度
- 脚本会等待交易确认后再返回

### 4. 错误处理

- 如果合约调用失败，会返回详细的错误信息
- 可以查看错误信息来调整合约 ABI 或方法

## 🔍 验证交易

### 方法 1: 在区块链浏览器查询

访问 DDC Chain 区块链浏览器：
```
https://explorer.datadance.ai/tx/{txHash}
```

### 方法 2: 使用 RPC 查询

```javascript
const tx = await provider.getTransaction(txHash);
console.log('Transaction:', tx);
```

### 方法 3: 检查交易回执

```javascript
const receipt = await provider.getTransactionReceipt(txHash);
console.log('Receipt:', receipt);
```

## 🚀 后续优化

1. **添加重试机制**: 如果交易失败，自动重试
2. **Gas 价格优化**: 根据网络情况动态调整 gas 价格
3. **批量处理**: 优化批量上链的性能
4. **数据库存储**: 将交易哈希保存到数据库
5. **事件监听**: 监听链上事件，实时更新状态

## 📚 相关文档

- [后端钱包配置指南](./BACKEND_WALLET_SETUP.md)
- [区块链交易哈希说明](./BLOCKCHAIN_TX_EXPLANATION.md)
- [区块链记录总结](./BLOCKCHAIN_RECORDING_SUMMARY.md)

---

**最后更新**: 2025年1月
**状态**: ✅ 真实链上交易调用已实现









