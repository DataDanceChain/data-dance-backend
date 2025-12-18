# 商家钱包配置指南

## 概述

为了启用区块链记录功能，需要为商家账户配置钱包地址和私钥。本指南说明如何使用 MetaMask 创建测试账号并配置到系统中。

## ⚠️ 安全提示

1. **只使用测试网络账号** - 不要使用包含真实资金的账号
2. **测试环境专用** - 私钥只用于开发和测试
3. **不要提交私钥** - 确保 `.env` 和代码中不包含私钥
4. **生产环境** - 生产环境应使用更安全的密钥管理方案

## 步骤 1: 在 MetaMask 创建测试账号

### 1.1 打开 MetaMask
- 打开浏览器扩展或移动应用
- 确保连接到测试网络（Sepolia、Goerli 或自定义 RPC）

### 1.2 创建新账号
1. 点击账户图标
2. 选择 "创建账户" 或 "Add Account"
3. 输入账户名称（例如：`DDC Test Merchant 1`）
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

## 步骤 2: 配置商家钱包

### 方式 1: 交互式配置（推荐）

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/configureMerchantWallets.js
```

脚本会提示你输入：
1. 钱包地址
2. 私钥
3. 是否配置所有商家

### 方式 2: 批量配置（所有商家使用同一个钱包）

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/configureMerchantWallets.js \
  --wallet-address 0xYourWalletAddress \
  --private-key 0xYourPrivateKey \
  --all
```

### 方式 3: 为特定商家配置

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/configureMerchantWallets.js \
  --merchant-email merchant-europe-fashion-apparel@datadance.io \
  --wallet-address 0xYourWalletAddress \
  --private-key 0xYourPrivateKey
```

### 方式 4: 检查钱包余额

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/configureMerchantWallets.js \
  --wallet-address 0xYourWalletAddress \
  --check-balance
```

## 步骤 3: 验证配置

### 查看商家钱包配置

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const merchants = await prisma.user.findMany({
    where: { isOrganization: true, email: { contains: 'merchant-' } },
    select: { name: true, email: true, walletAddress: true, chainId: true }
  });
  console.log('商家钱包配置:');
  merchants.forEach(m => {
    console.log(\`\${m.name}: \${m.walletAddress || '未配置'}\`);
  });
  await prisma.\$disconnect();
})();
"
```

## 步骤 4: 测试区块链记录

配置完成后，可以测试区块链记录功能：

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/recordDataNFTToBlockchain.js --all
```

## 注意事项

### 1. 钱包余额

确保测试钱包有足够的余额支付 gas 费用：
- 建议至少 0.01 ETH（或等值的测试币）
- 可以在测试网络水龙头获取测试币

### 2. 私钥格式

- 支持格式：`0x...` 或 不带 `0x` 的 64 位十六进制
- 脚本会自动处理格式转换

### 3. 地址验证

脚本会验证：
- 钱包地址格式（42 字符，0x 开头）
- 私钥格式（64 位十六进制）
- 私钥和地址是否匹配

### 4. 批量配置

如果使用 `--all` 选项：
- 已配置钱包的商家会被跳过
- 如需覆盖，请使用 `--merchant-email` 单独配置

## 示例：完整流程

```bash
# 1. 从 MetaMask 导出测试账号私钥
# 假设得到：
# 钱包地址: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
# 私钥: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef

# 2. 检查余额
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/configureMerchantWallets.js \
  --wallet-address 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb \
  --check-balance

# 3. 批量配置所有商家
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public" \
node scripts/configureMerchantWallets.js \
  --wallet-address 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb \
  --private-key 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef \
  --all

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

### 问题 2: 私钥和地址不匹配

**错误**: `Private key does not match wallet address`

**解决方案**:
- 确保使用的是同一个账号的地址和私钥
- 检查地址和私钥是否复制完整

### 问题 3: 余额不足

**警告**: `Insufficient balance for gas`

**解决方案**:
- 从测试网络水龙头获取测试币
- 或使用其他有余额的测试账号

## 相关脚本

- `scripts/configureMerchantWallets.js` - 钱包配置脚本
- `scripts/recordDataNFTToBlockchain.js` - 区块链记录脚本
- `scripts/checkStats.js` - 统计查看脚本

## 下一步

配置完成后，可以：
1. 测试区块链记录功能
2. 在链上 mint DataNFT
3. 记录交易哈希到数据库
4. 实现完整的链上交易流程









