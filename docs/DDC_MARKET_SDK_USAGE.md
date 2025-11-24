# DDC Market SDK 使用指南

## 📋 SDK 概述

DDC Market SDK 是一个 TypeScript 兼容的 NPM 包，用于与 DDC Market 合约集成。

### SDK 架构

```
B2B Business Layer
    ↓
SDK Management APIs
    ├── DDCNFT Management API
    └── Membership Management API
    ↓
Blockchain Layer (DDC Market Contracts)
```

## 🔧 SDK 安装和构建

### 1. 安装 SDK

SDK 已通过 GitHub 安装：
```json
"@ddcmarket/sdk": "github:DataDanceChain/DDC-Market-SDK"
```

### 2. 构建 SDK

SDK 需要先构建才能使用：

```bash
cd node_modules/@ddcmarket/sdk
pnpm install
pnpm build:dev
```

或者从项目根目录：

```bash
cd node_modules/@ddcmarket/sdk && pnpm install && pnpm build:dev
```

### 3. 查看示例代码

SDK 包含 demo 文件夹，可以参考：
- `DDCNFTDemo.vue` - DDCNFT 管理示例
- `WalletConnector.vue` - 钱包连接示例

## 📚 SDK 使用方法

### 基本要求

根据 README，SDK 需要：

1. **钱包集成**: 使用 EIP-1193 标准钱包提供者
2. **私钥准备**: 准备用户私钥用于签名合约
3. **集中式服务**: 默认的集中式服务用于读写配置和存储信息

### SDK API 分类

SDK 提供两个主要的管理 API：

1. **DDCNFT Management API** - 用于部署和管理 DDCNFT
2. **Membership Management API** - 用于部署和管理会员

## 💻 使用示例

### 方式 1: 使用 SDK（推荐）

```javascript
// 需要先构建 SDK
const { DDCMarketSDK } = require('@ddcmarket/sdk');

// 初始化 SDK
const sdk = new DDCMarketSDK({
  provider: provider,  // ethers.js provider
  signer: wallet,      // ethers.js wallet (带私钥)
  // 其他配置...
});

// 使用 DDCNFT Management API
const ddcnftAPI = sdk.getDDCNFTAPI();

// Mint DataNFT
const result = await ddcnftAPI.mint({
  to: wallet.address,
  tokenId: tokenId,
  metadataURI: metadataUri
});
```

### 方式 2: 直接使用 ethers.js（当前实现）

如果 SDK 未构建或不可用，可以直接使用 ethers.js：

```javascript
const ethers = require('ethers');

// 创建 provider 和 wallet
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// 创建合约实例
const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  wallet
);

// 调用合约方法
const tx = await contract.someMethod(...args);
const receipt = await tx.wait();
```

## 🔍 查找 SDK 源码和示例

### GitHub 仓库

- **SDK 仓库**: https://github.com/DataDanceChain/DDC-Market-SDK
- **合约仓库**: https://github.com/DataDanceChain/DDC-Market-Contracts

### 查看示例代码

1. 克隆 SDK 仓库：
```bash
git clone https://github.com/DataDanceChain/DDC-Market-SDK.git
cd DDC-Market-SDK
```

2. 查看 demo 文件夹：
```bash
cd demo
# 查看 DDCNFTDemo.vue 和 WalletConnector.vue
```

3. 查看源码：
```bash
cd src
# 查看 SDK 的实现代码
```

## 🚀 集成步骤

### 步骤 1: 构建 SDK

```bash
cd node_modules/@ddcmarket/sdk
pnpm install
pnpm build:dev
```

### 步骤 2: 导入 SDK

```javascript
// CommonJS
const { DDCMarketSDK } = require('@ddcmarket/sdk');

// ES Modules
import { DDCMarketSDK } from '@ddcmarket/sdk';
```

### 步骤 3: 初始化 SDK

```javascript
const ethers = require('ethers');

// 创建 provider
const provider = new ethers.JsonRpcProvider(
  process.env.DDC_RPC_URL,
  process.env.DDC_CHAIN_ID
);

// 创建 wallet
const wallet = new ethers.Wallet(
  process.env.BACKEND_WALLET_PRIVATE_KEY,
  provider
);

// 初始化 SDK
const sdk = new DDCMarketSDK({
  provider: provider,
  signer: wallet,
  // 其他配置参数
});
```

### 步骤 4: 使用 DDCNFT API

```javascript
// 获取 DDCNFT Management API
const ddcnftAPI = sdk.getDDCNFTAPI();

// Mint DataNFT
try {
  const result = await ddcnftAPI.mint({
    to: wallet.address,
    tokenId: tokenId,
    metadataURI: metadataUri
  });
  
  console.log('Mint successful:', result);
} catch (error) {
  console.error('Mint failed:', error);
}
```

## ⚠️ 当前状态

### SDK 状态

- ✅ SDK 已安装（通过 GitHub）
- ❌ SDK 未构建（缺少 dist 文件夹）
- ❓ SDK 源码和示例代码需要从 GitHub 查看

### 建议

1. **构建 SDK**:
   ```bash
   cd node_modules/@ddcmarket/sdk
   pnpm install
   pnpm build:dev
   ```

2. **查看 GitHub 示例**:
   - 访问 https://github.com/DataDanceChain/DDC-Market-SDK
   - 查看 demo 文件夹中的示例代码
   - 查看 src 文件夹中的实现代码

3. **联系 SDK 开发者**:
   - 获取完整的使用文档
   - 了解正确的 API 调用方式
   - 确认所需的配置参数

## 📝 替代方案

如果 SDK 暂时不可用，可以：

1. **直接使用 ethers.js**（当前实现）
   - 优点: 不依赖 SDK，直接控制
   - 缺点: 需要了解合约 ABI

2. **查看合约源码**
   - 从 DDC Market Contracts 仓库获取合约 ABI
   - 直接调用合约方法

3. **使用后端 API**
   - 如果 DDC Market 提供后端 API
   - 通过 API 注册 DataNFT

## 🔗 相关资源

- [DDC Market SDK GitHub](https://github.com/DataDanceChain/DDC-Market-SDK)
- [DDC Market Contracts](https://github.com/DataDanceChain/DDC-Market-Contracts)
- [后端钱包配置指南](./BACKEND_WALLET_SETUP.md)
- [区块链测试结果](./BLOCKCHAIN_TEST_RESULTS.md)

## 📋 下一步行动

1. ✅ 查看 SDK README
2. ⏳ 构建 SDK
3. ⏳ 查看 demo 示例代码
4. ⏳ 实现 SDK 集成
5. ⏳ 测试链上交易

---

**最后更新**: 2025年1月
**状态**: ⏳ 需要构建 SDK 并查看示例代码

