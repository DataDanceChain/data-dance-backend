# Data Pack Import Script

## 📦 导入 CSV 数据包为 DataNFT

这个脚本允许你直接从 CSV 文件创建可交易的 DataNFT，无需关联活动。

---

## 🚀 快速开始

### 基本用法

```bash
node scripts/importDataPackAsDataNFT.js data-pack-1.csv
```

这将创建一个：
- 名称：自动生成（基于文件名）
- 价格：0（免费）
- 状态：未发布（草稿）

---

## 📚 完整参数

```bash
node scripts/importDataPackAsDataNFT.js <csv-file> [options]
```

### 参数说明

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `--name` | string | DataNFT 名称 | 基于文件名生成 |
| `--description` | string | DataNFT 描述 | 自动生成 |
| `--price` | number | 价格（美元） | 0 |
| `--image` | string | 图片路径 | `/assets/nfts/data-pack-default.jpg` |
| `--publish` | flag | 创建后立即发布 | false |
| `--max-sales` | number | 最大销售数量 | 999999 |

---

## 📖 使用示例

### 示例 1: 基本导入

```bash
node scripts/importDataPackAsDataNFT.js data-pack-1.csv
```

**结果：**
- ✅ 创建 DataNFT（草稿状态）
- ✅ 自动识别邮箱字段
- ✅ 添加 "Data Pack" 标签
- ✅ 数据存储在 DataNFT.dataRecords

---

### 示例 2: 设置名称和价格

```bash
node scripts/importDataPackAsDataNFT.js data-pack-1.csv \
  --name "Q1 2025 Customer Orders" \
  --price 99.99
```

**结果：**
- 名称：Q1 2025 Customer Orders
- 价格：$99.99
- 状态：草稿（需要手动发布）

---

### 示例 3: 完整配置 + 自动发布

```bash
node scripts/importDataPackAsDataNFT.js data-pack-1.csv \
  --name "Premium Customer Database Q1 2025" \
  --description "High-value customer orders with complete contact information and purchase history" \
  --price 299.99 \
  --image "/assets/nfts/premium-data-pack.jpg" \
  --max-sales 10 \
  --publish
```

**结果：**
- ✅ 创建 DataNFT
- ✅ 设置所有元数据
- ✅ **自动发布到市场**
- ✅ 限制最多卖10次

---

### 示例 4: 免费数据包（限量）

```bash
node scripts/importDataPackAsDataNFT.js sample-data.csv \
  --name "Sample Customer Data (Free)" \
  --description "Sample dataset for testing and evaluation" \
  --price 0 \
  --max-sales 100 \
  --publish
```

**适用场景：**
- 🎁 免费样本数据
- 📊 数据预览
- 🧪 测试数据集

---

## 📋 CSV 文件要求

### ✅ 必需条件

**1. 必须包含邮箱字段**

列名包含以下任一关键词（不区分大小写）：
- `email`
- `邮箱`
- `mail`

**2. 支持的格式**
- CSV 格式（逗号分隔）
- UTF-8 编码
- 支持引号内的逗号

### 示例 CSV

```csv
订单编号,邮箱,商品名称,收件地址
105-7462910-4567890,alice.williams@gmx.com,Nike Running Shoes,"101 Elm St, Berlin, Germany"
107-4958372-6789012,david.miller@yandex.com,Lego Star Wars Set,"303 Cedar Blvd, Mumbai, India"
108-7623941-7890123,emma.davis@outlook.com,Dyson Vacuum Cleaner,"404 Spruce Way, Paris, France"
```

### ⚠️ 注意事项

1. **无邮箱的记录会被跳过**
   ```
   警告: 3 records without email will be skipped
   ```

2. **字段灵活性**
   - ✅ 任意列数
   - ✅ 任意字段名
   - ✅ 中英文都支持
   - ✅ 所有字段都会被保存

---

## 📊 输出示例

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 DataDance Data Pack → DataNFT Importer
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Starting to import CSV: data-pack-1.csv...

Using merchant: DataDance Official (official@datadance.io)

📄 Parsed CSV:
   Total records: 40
   Headers: 订单编号, 邮箱, 商品名称, 收件地址

📧 Identified email field: "邮箱"

✅ Valid records with email: 39

🎨 Creating DataNFT...
✅ DataNFT created successfully!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ SUCCESS - DataNFT Created!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📦 DataNFT Details:
   ID: clxxx123456
   Name: Data Pack - data-pack-1
   Description: Data pack imported from...
   Price: $0
   Published: No (Draft) 📝
   Max Sales: 999999

👤 Merchant:
   DataDance Official (official@datadance.io)

📊 Data Statistics:
   Source: data-pack-1.csv
   Email Field: 邮箱
   Total Records: 40
   Valid Records: 39
   Skipped Records: 1
   Fields: 订单编号, 邮箱, 商品名称, 收件地址

🏷️  Tags: Data Pack

🔄 Data Source: upload (standalone data pack)

💡 Next Steps:
   1. Set a price (if not already set)
   2. Publish the DataNFT to make it available in the market
   3. Share with potential buyers

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 🔄 后续操作

### 发布 DataNFT

创建后，DataNFT 默认是草稿状态，需要发布到市场：

```bash
# 通过 API 发布
PATCH /api/merchant/datanfts/{id}/publish

# 或者在创建时使用 --publish 参数
```

### 查看你的 DataNFT

```bash
# 获取所有自己的 DataNFT
GET /api/merchant/datanfts?allMine=true

# 获取单个 DataNFT 详情
GET /api/datanfts/{id}
```

---

## 🎯 使用场景

### 1. 客户数据销售

```bash
node scripts/importDataPackAsDataNFT.js customer-leads-q1.csv \
  --name "B2B Customer Leads Q1 2025" \
  --description "Verified B2B customer contacts with company info" \
  --price 499.99 \
  --max-sales 5 \
  --publish
```

### 2. 市场调研数据

```bash
node scripts/importDataPackAsDataNFT.js survey-results.csv \
  --name "Consumer Behavior Survey 2025" \
  --description "1000+ consumer survey responses" \
  --price 199.99 \
  --publish
```

### 3. 订单数据归档

```bash
node scripts/importDataPackAsDataNFT.js orders-2024.csv \
  --name "Order History 2024" \
  --description "Complete order history for 2024" \
  --price 0 \
  --max-sales 1
```

---

## 🔍 故障排除

### 问题 1: "CSV must contain an email field"

**原因：** CSV 文件没有邮箱列

**解决：** 确保有包含 `email`、`邮箱` 或 `mail` 的列名

### 问题 2: "X records without email will be skipped"

**原因：** 某些记录的邮箱字段为空

**解决：** 这是警告，脚本会跳过这些记录并继续

### 问题 3: "File not found"

**原因：** CSV 文件路径不正确

**解决：** 检查文件路径，使用相对或绝对路径

### 问题 4: 数据库连接失败

**原因：** 数据库未运行

**解决：** 
```bash
# 启动 Docker 数据库
docker-compose up -d ddc-backend-db
```

---

## 📚 相关文档

- [数据包架构文档](../docs/DATA_PACK_ARCHITECTURE.md)
- [DataNFT API 文档](../docs/API_DATANFT.md)
- [Prisma Schema](../prisma/schema.prisma)

---

## ✅ 快速检查清单

创建数据包前，确保：

- [ ] CSV 文件包含邮箱字段
- [ ] 数据符合隐私法规
- [ ] 设置了合理的价格
- [ ] 准备了吸引人的描述
- [ ] （可选）准备了漂亮的封面图
- [ ] 决定了销售数量限制
- [ ] 数据库正在运行

---

## 🎉 完成！

现在你可以：
1. ✅ 从 CSV 文件创建 DataNFT
2. ✅ 在市场中交易数据
3. ✅ 获得数据资产收益

Happy Data Trading! 🚀

