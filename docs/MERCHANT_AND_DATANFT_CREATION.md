# 商家账户和 DataNFT 批量创建指南

## 概述

本指南说明如何使用清洗后的数据批量创建商家账户和 DataNFT，并上架到数据市场。

## 前置条件

### 1. 数据清洗已完成

确保已经运行数据清洗脚本：

```bash
# 清洗数据
node scripts/cleanAndCategorizeDataPack.js data-pack-1.csv
node scripts/cleanAndCategorizeDataPack.js data-pack-2.csv
```

### 2. 数据库服务运行中

确保 PostgreSQL 数据库服务正在运行：

```bash
# 检查数据库容器（如果使用 Docker）
docker ps | grep postgres

# 或者检查本地数据库
psql -h localhost -U postgres -d datadance -c "SELECT 1"
```

### 3. 环境变量配置

确保 `.env` 文件中的 `DATABASE_URL` 配置正确：

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public"
```

## 使用方法

### 基本用法

```bash
# 创建商家和 DataNFT（不发布）
node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json

# 创建并发布到市场
node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json --publish

# 设置价格并发布
node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json --price 100 --publish

# 设置最大销售次数
node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json --price 100 --publish --max-sales 5
```

### 命令行参数

- `--price <number>` - DataNFT 价格（默认: 0）
- `--publish` - 立即发布到市场
- `--max-sales <number>` - 最大销售次数（默认: 10）
- `--image <path>` - 图片路径（默认: /assets/nfts/data-pack-default.jpg）

## 工作流程

### 步骤 1: 读取分组数据

脚本会读取 `cleaned-data/{filename}_groups.json` 文件，获取所有分组信息。

### 步骤 2: 为每个分组创建商家

- 商家名称格式：`{Region} {Category} Merchant`
- 邮箱格式：`merchant-{group-key}@datadance.io`
- 密码：`Merchant@123`（统一密码，可在脚本中修改）

### 步骤 3: 为每个商家创建 DataNFT

- 从对应的分组 CSV 文件读取数据
- 创建 DataNFT，包含所有记录
- 设置价格、描述等元数据

### 步骤 4: 发布到市场（可选）

如果使用 `--publish` 参数，DataNFT 会自动发布到市场。

## 输出示例

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏪 Create Merchants & DataNFTs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Found 19 groups to process

⚙️  Options:
   Price: 50
   Publish: Yes
   Max Sales: 10
   Image: /assets/nfts/data-pack-default.jpg

[1/19] Processing: Europe-Fashion & Apparel
   Records: 2
   📝 Creating merchant: Europe Fashion & Apparel Merchant
   ✅ Created merchant: Europe Fashion & Apparel Merchant (merchant-europe-fashion___apparel@datadance.io)
   📦 Creating DataNFT...
   ✅ Created DataNFT: Europe Fashion & Apparel Data Pack
      ID: abc123...
      Records: 2
      Price: 50
      Published: Yes

...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Merchants created: 19
✓  Merchants existing: 0
📦 DataNFTs created: 19
❌ Errors: 0

🎉 Process completed!
```

## 商家账户信息

创建的商家账户信息：

- **邮箱格式**: `merchant-{group-key}@datadance.io`
- **密码**: `Merchant@123`
- **类型**: 组织账户（isOrganization: true）
- **角色**: USER

### 登录信息示例

```
Merchant: Europe Fashion & Apparel Merchant
Email: merchant-europe-fashion___apparel@datadance.io
Password: Merchant@123
```

## DataNFT 信息

每个 DataNFT 包含：

- **名称**: `{Region} {Category} Data Pack`
- **描述**: 自动生成，包含区域、类别、记录数等信息
- **数据源**: `upload`（直接上传）
- **数据记录**: 完整的 CSV 数据（JSON 格式）
- **价格**: 通过 `--price` 参数设置
- **发布状态**: 通过 `--publish` 参数控制

## 批量处理

### 处理 data-pack-1

```bash
node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json --price 50 --publish
```

### 处理 data-pack-2（数据量大）

```bash
# 建议先测试几个分组
node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-2_groups.json --price 100 --publish --max-sales 20
```

## 注意事项

1. **数据库连接**: 确保数据库服务正在运行
2. **重复执行**: 脚本会检查商家和 DataNFT 是否已存在，避免重复创建
3. **数据量**: data-pack-2 有 54 个分组，处理可能需要一些时间
4. **价格设置**: 建议根据数据质量和数量设置合理价格
5. **最大销售**: 设置 `maxSales` 可以限制每个 DataNFT 的销售次数

## 故障排查

### 问题 1: 数据库连接失败

**错误**: `Can't reach database server`

**解决方案**:
1. 检查数据库服务是否运行
2. 检查 `.env` 文件中的 `DATABASE_URL`
3. 确认数据库端口和认证信息

### 问题 2: CSV 文件未找到

**错误**: `CSV file not found`

**解决方案**:
1. 确保数据清洗脚本已运行
2. 检查 `cleaned-data/{filename}_groups/` 目录是否存在
3. 确认分组 CSV 文件已生成

### 问题 3: 邮箱字段未找到

**错误**: `No email field found`

**解决方案**:
1. 检查 CSV 文件是否包含邮箱字段
2. 确认字段名包含 `email`、`邮箱` 或 `mail`

## 下一步：区块链记录

创建 DataNFT 后，可以使用 DDC Market SDK 将数据记录到区块链：

1. 为每个 DataNFT 创建链上 token
2. 记录 metadata 到链上
3. 实现链上交易功能

## 相关文件

- `scripts/cleanAndCategorizeDataPack.js` - 数据清洗脚本
- `scripts/createMerchantsAndDataNFTs.js` - 商家和 DataNFT 创建脚本
- `scripts/importDataPackAsDataNFT.js` - 单个数据包导入脚本
- `docs/DATA_CLEANING_GUIDE.md` - 数据清洗指南

## 完整工作流程

```
1. 数据清洗
   ↓
   node scripts/cleanAndCategorizeDataPack.js data-pack-1.csv
   
2. 创建商家和 DataNFT
   ↓
   node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json --price 100 --publish
   
3. 区块链记录（待实现）
   ↓
   使用 DDC Market SDK 记录到链上
```








