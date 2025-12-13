# 后端钱包配置指南

## 概述

DataNFT 上链使用**后端统一管理的钱包**，而不是每个商家单独的钱包。这样可以：

1. **统一管理** - 所有 DataNFT 使用同一个钱包上链
2. **简化配置** - 只需配置一个钱包，无需为每个商家配置
3. **降低成本** - 统一管理 gas 费用
4. **提高安全性** - 私钥集中管理，不分散在各个商家账户

## ⚠️ 安全提示

1. **只使用测试网络账号** - 不要使用包含真实资金的账号
2. **测试环境专用** - 私钥只用于开发和测试
3. **不要提交私钥** - 确保 `.env` 文件在 `.gitignore` 中
4. **生产环境** - 生产环境应使用更安全的密钥管理方案（如 AWS Secrets Manager、HashiCorp Vault）

## 步骤 1: 在 MetaMask 创建测试账号

### 1.1 打开 MetaMask
- 打开浏览器扩展或移动应用
- 确保连接到测试网络（DDC Chain 或 Sepolia）

### 1.2 创建新账号
1. 点击账户图标
2. 选择 "创建账户" 或 "Add Account"
3. 输入账户名称（例如：`DDC Backend Wallet`）
4. 点击 "创建"

### 1.3 导出私钥
1. 点击账户名称旁边的三个点（...）
2. 选择 "账户详情" 或 "Account Details"
3. 点击 "导出私钥" 或 "Export Private Key"
4. 输入 MetaMask 密码确认
5. 复制私钥（格式：`0x...` 或 64 位十六进制）

**重要**: 
- 私钥格式：`0x` + 64 位十六进制字符
- 例如：`0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`

## 步骤 2: 配置后端钱包

### 方式 1: 交互式配置（推荐）

```bash
node scripts/configureBackendWallet.js
```

脚本会提示你：
1. 输入私钥
2. 自动验证并获取钱包地址
3. 检查余额
4. 更新 `.env` 文件

### 方式 2: 直接设置环境变量

在 `.env` 文件中添加：

```env
# Backend Wallet (for blockchain recording)
BACKEND_WALLET_PRIVATE_KEY=0xYourPrivateKeyHere
BACKEND_WALLET_ADDRESS=0xYourWalletAddressHere
```

然后检查配置：

```bash
node scripts/configureBackendWallet.js --check
```

## 步骤 3: 验证配置

### 检查钱包余额

```bash
node scripts/configureBackendWallet.js --check
```

### 查看环境变量

```bash
grep BACKEND_WALLET .env
```

## 步骤 4: 测试区块链记录

配置完成后，可以测试区块链记录功能：

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/recordDataNFTToBlockchain.js --all
```

## 商家钱包地址（可选）

商家钱包地址**仅用于显示和标识**，不用于实际的区块链交易。如果需要配置商家钱包地址（不包含私钥），可以使用：

```bash
# 配置单个商家
node scripts/configureMerchantWallets.js \
  --merchant-email merchant-xxx@datadance.io \
  --wallet-address 0x...

# 批量配置所有商家（使用同一个地址）
node scripts/configureMerchantWallets.js \
  --wallet-address 0x... \
  --all
```

## 架构说明

```
┌─────────────────────────────────────────┐
│          DataNFT 上链流程                │
└─────────────────────────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   后端钱包 (统一管理)  │
        │ BACKEND_WALLET_*      │
        └───────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   所有 DataNFT         │
        │   使用同一个钱包上链    │
        └───────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   区块链 (DDC Chain)   │
        └───────────────────────┘

商家钱包地址（可选）：
- 仅用于显示和标识
- 不参与实际的区块链交易
- 不存储私钥
```

## 注意事项

### 1. 钱包余额

确保后端钱包有足够的余额支付 gas 费用：
- 建议至少 0.01 ETH（或等值的测试币）
- 可以在测试网络水龙头获取测试币
- 使用 `--check` 选项检查余额

### 2. 私钥格式

- 支持格式：`0x...` 或 不带 `0x` 的 64 位十六进制
- 脚本会自动处理格式转换

### 3. 环境变量

- `BACKEND_WALLET_PRIVATE_KEY` - 后端钱包私钥（必需）
- `BACKEND_WALLET_ADDRESS` - 后端钱包地址（自动生成）
- `DDC_RPC_URL` - DDC Chain RPC 地址（可选，有默认值）
- `DDC_CHAIN_ID` - DDC Chain ID（可选，默认 44508）

### 4. .env 文件安全

确保 `.env` 文件在 `.gitignore` 中：

```gitignore
# Environment variables
.env
.env.local
.env.*.local
```

## 示例：完整流程

```bash
# 1. 从 MetaMask 导出测试账号私钥
# 假设得到：
# 私钥: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef

# 2. 配置后端钱包
node scripts/configureBackendWallet.js
# 输入私钥，脚本会自动：
# - 验证私钥格式
# - 获取钱包地址
# - 检查余额
# - 更新 .env 文件

# 3. 验证配置
node scripts/configureBackendWallet.js --check

# 4. 测试区块链记录
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/recordDataNFTToBlockchain.js --all
```

## 故障排查

### 问题 1: 私钥格式错误

**错误**: `Invalid private key format`

**解决方案**:
- 确保私钥是 64 位十六进制字符
- 可以带 `0x` 前缀，也可以不带
- 从 MetaMask 导出的私钥应该可以直接使用

### 问题 2: 余额不足

**警告**: `Insufficient balance for gas`

**解决方案**:
- 从测试网络水龙头获取测试币
- 或使用其他有余额的测试账号
- 建议至少 0.01 ETH 用于测试

### 问题 3: 环境变量未加载

**错误**: `BACKEND_WALLET_PRIVATE_KEY not configured`

**解决方案**:
- 确保 `.env` 文件存在
- 确保 `BACKEND_WALLET_PRIVATE_KEY` 已设置
- 运行 `node scripts/configureBackendWallet.js` 重新配置

### 问题 4: RPC 连接失败

**错误**: `Cannot connect to blockchain`

**解决方案**:
- 检查 `DDC_RPC_URL` 是否正确
- 检查网络连接
- 确认 RPC 节点是否可用

## 相关脚本

- `scripts/configureBackendWallet.js` - 后端钱包配置脚本
- `scripts/recordDataNFTToBlockchain.js` - 区块链记录脚本（使用后端钱包）
- `scripts/configureMerchantWallets.js` - 商家钱包地址配置（仅显示用）

## 下一步

配置完成后，可以：
1. 测试区块链记录功能
2. 在链上 mint DataNFT
3. 记录交易哈希到数据库
4. 实现完整的链上交易流程








