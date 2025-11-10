# Data Pack Architecture

## 概述

数据包（Data Pack）功能允许商家上传和管理不关联特定活动的数据集，用于后续的数据交易和其他功能。

## 架构设计 - 方案B（已采用）

### 核心模型：Snapshot

我们使用 `Snapshot` 模型来存储数据包，并将 `activityId` 字段设为**可选**，使数据包可以独立于活动存在。

```prisma
model Snapshot {
  id          String    @id @default(uuid())
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  name        String                    // 数据包名称
  description String?                   // 数据包描述
  activityId  String?                   // 可选：关联的活动ID
  merchantId  String                    // 必填：商家ID
  claims      Json?                     // 灵活的JSON字段存储数据
  activity    Activity? @relation(...)  // 可选关联
  merchant    User      @relation(...)  // 商家关联
  dataNFTs    DataNFT[] @relation(...)  // 可关联多个DataNFT
  tags        Tag[]     @relation(...)  // 标签
}
```

### 数据结构

#### Snapshot.claims JSON 结构

```json
{
  "source": "data-pack-1.csv",
  "fileName": "data-pack-1.csv",
  "importDate": "2025-11-10T15:55:03.000Z",
  "recordCount": 39,
  "totalRecords": 40,
  "skippedRecords": 1,
  "headers": ["订单编号", "邮箱", "商品名称", "收件地址"],
  "emailField": "邮箱",
  "records": [
    {
      "recordId": 1,
      "email": "alice.williams@gmx.com",
      "订单编号": "105-7462910-4567890",
      "邮箱": "alice.williams@gmx.com",
      "商品名称": "Nike Running Shoes",
      "收件地址": "101 Elm St, Berlin, Germany"
    },
    // ... 更多记录
  ]
}
```

## 优势

### ✅ 灵活性
- 数据包可以独立于活动存在
- 支持任意CSV结构（只要包含邮箱字段）
- 所有字段都被保存，无需预定义schema

### ✅ 可扩展性
- 通过 `dataNFTs` 关联，数据包可以打包成NFT进行交易
- 支持标签分类
- 可选关联活动（如需要）

### ✅ 数据完整性
- 每条记录必须包含邮箱字段（验证）
- 自动跳过无效记录
- 保留原始数据结构

## 使用方式

### 1. 脚本导入（当前实现）

```bash
# 基本用法
node scripts/importDataPackFromCSV.js data-pack-1.csv

# 指定名称
node scripts/importDataPackFromCSV.js data-pack-1.csv "Order Data Pack 1"

# 指定名称和描述
node scripts/importDataPackFromCSV.js data-pack-1.csv "Order Data Pack 1" "Customer orders from Q1 2025"
```

### 2. API接口（待实现）

```javascript
// POST /api/merchant/data-packs/upload
// Content-Type: multipart/form-data

{
  file: <CSV文件>,
  name: "Order Data Pack 1",
  description: "Customer orders from Q1 2025"
}
```

## CSV要求

### 必需字段
- **邮箱字段**：列名包含 `email`、`邮箱` 或 `mail`（不区分大小写）

### 示例CSV

```csv
订单编号,邮箱,商品名称,收件地址
105-7462910-4567890,alice.williams@gmx.com,Nike Running Shoes,"101 Elm St, Berlin, Germany"
107-4958372-6789012,david.miller@yandex.com,Lego Star Wars Set,"303 Cedar Blvd, Mumbai, India"
```

### 支持的格式
- ✅ 带引号的字段（处理逗号）
- ✅ 任意列数
- ✅ 中英文字段名
- ✅ 灵活的字段结构

## 数据库迁移

已创建迁移文件使 `Snapshot.activityId` 变为可选：

```sql
-- 20251110235503_make_snapshot_activity_optional
ALTER TABLE "Snapshot" ALTER COLUMN "activityId" DROP NOT NULL;
```

执行迁移：
```bash
npx prisma migrate deploy
```

## 后续功能规划

### 1. 前端上传界面
- 文件上传组件
- CSV预览
- 字段映射界面
- 数据验证反馈

### 2. 数据包管理
- 列表查看
- 搜索和筛选
- 编辑和删除
- 导出功能

### 3. 数据交易
- 将数据包打包成 DataNFT
- 设置价格和销售限制
- 交易历史记录
- 收益管理

### 4. 数据分析
- 记录统计
- 邮箱去重分析
- 数据质量报告
- 使用情况追踪

## 示例代码

### 查询数据包

```javascript
// 查询所有独立数据包（不关联活动）
const standalonePacks = await prisma.snapshot.findMany({
  where: {
    activityId: null
  },
  include: {
    merchant: true,
    tags: true
  }
});

// 查询特定商家的数据包
const merchantPacks = await prisma.snapshot.findMany({
  where: {
    merchantId: "merchant-id"
  }
});
```

### 访问数据

```javascript
const snapshot = await prisma.snapshot.findUnique({
  where: { id: "snapshot-id" }
});

// 访问记录
const records = snapshot.claims.records;
const emailField = snapshot.claims.emailField;

// 获取所有邮箱
const emails = records.map(r => r.email);
```

### 创建 DataNFT

```javascript
// 将数据包打包成NFT
const dataNFT = await prisma.dataNFT.create({
  data: {
    name: "Order Data Pack 1",
    description: "39 customer orders with contact info",
    price: 99.99,
    maxSales: 10,
    merchantId: merchantId,
    snapshots: {
      connect: { id: snapshotId }
    }
  }
});
```

## 技术细节

### 邮箱字段识别
脚本自动识别包含以下关键词的列作为邮箱字段：
- `email`
- `邮箱`
- `mail`

（不区分大小写）

### CSV解析
- 支持引号内的逗号
- 自动trim空格
- 跳过空行

### 数据验证
- 邮箱字段必须存在
- 记录必须有有效的邮箱值
- 无效记录会被跳过并记录数量

## 安全考虑

1. **访问控制**：只有商家可以访问自己的数据包
2. **数据加密**：敏感数据应考虑加密存储
3. **隐私保护**：遵守GDPR等数据保护法规
4. **审计日志**：记录所有数据访问和交易

## 参考

- Prisma Schema: `prisma/schema.prisma`
- 导入脚本: `scripts/importDataPackFromCSV.js`
- 示例数据: `data-pack-1.csv`
- 迁移文件: `prisma/migrations/20251110235503_make_snapshot_activity_optional/`

