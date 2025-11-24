# SDK 集成更新说明

## 📋 根据聊天记录的更新

根据聊天记录和截图，已更新实现以使用 SDK 的 `DDCNFTManager`，而不是直接使用 ethers.js。

## 🔧 主要变更

### 1. 使用 SDK 的 DDCNFTManager

根据聊天记录，应该使用：

```javascript
await DDCNFTManager.init({
  walletAddress: 'wallet address',
  provider: { type: 'jsonRpc' },
  signer: { privateKey: private_key },
  debug: false,
});
```

### 2. Provider 配置

根据聊天记录，Provider 应该这样创建：

```javascript
const provider = new ethers.JsonRpcProvider(
  'https://dev-exp-alpha.datadance.ai/eth/rpc',
  44508,
  { batchMaxCount: 1 }
);
```

### 3. 实现策略

当前实现采用**优先使用 SDK，失败时回退到 ethers.js**的策略：

1. **优先尝试 SDK**：
   - 使用 `DDCNFTManager.init()` 初始化
   - 调用 SDK 的方法来 mint DataNFT

2. **回退到 ethers.js**：
   - 如果 SDK 不可用或失败
   - 直接使用 ethers.js 调用合约方法

## 📝 代码实现

### SDK 初始化

```javascript
async function initDDCNFTManager() {
  const backendPrivateKey = process.env.BACKEND_WALLET_PRIVATE_KEY;
  const wallet = getBackendWallet();
  
  await DDCNFTManager.init({
    walletAddress: wallet.address,
    provider: { type: 'jsonRpc' },
    signer: { privateKey: backendPrivateKey },
    debug: false,
  });
  
  return DDCNFTManager;
}
```

### 使用 SDK Mint

```javascript
// 初始化 DDCNFTManager
const manager = await initDDCNFTManager();

// 使用 SDK 方法 mint
const result = await manager.mint({
  to: wallet.address,
  tokenId: tokenId.toString(),
  metadataURI: metadataUri
});
```

## ⚠️ 注意事项

### SDK 构建

如果 SDK 未构建，会回退到 ethers.js：

```bash
cd node_modules/@ddcmarket/sdk
npm install
npm run build:dev
```

### 环境变量

确保 `.env` 文件中配置了：

```env
BACKEND_WALLET_PRIVATE_KEY=0x...
DDC_RPC_URL=https://dev-exp-alpha.datadance.ai/eth/rpc
DDC_CHAIN_ID=44508
```

## 🔄 工作流程

```
1. 尝试导入 SDK
   ↓
2. 如果 SDK 可用，使用 DDCNFTManager.init()
   ↓
3. 调用 SDK 方法 mint DataNFT
   ↓
4. 如果 SDK 失败，回退到 ethers.js
   ↓
5. 直接调用合约方法
   ↓
6. 返回交易结果
```

## 📊 优势

1. **灵活性**: SDK 优先，失败时自动回退
2. **兼容性**: 即使 SDK 未构建也能工作
3. **正确性**: 使用 SDK 推荐的方式
4. **可维护性**: 代码结构清晰，易于调试

## 🧪 测试

测试脚本：

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/recordDataNFTToBlockchain.js --nft-id <nft-id>
```

## 📚 相关文档

- [SDK 使用指南](./DDC_MARKET_SDK_USAGE.md)
- [后端钱包配置](./BACKEND_WALLET_SETUP.md)
- [区块链测试结果](./BLOCKCHAIN_TEST_RESULTS.md)

---

**最后更新**: 2025年1月
**状态**: ✅ 已根据聊天记录更新实现

