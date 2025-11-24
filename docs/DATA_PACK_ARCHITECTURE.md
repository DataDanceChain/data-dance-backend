# Data Pack Architecture (方案C - Final)

## 概述

数据包（Data Pack）功能允许商家上传和管理不关联特定活动的数据集，直接创建为 DataNFT，可在市场中交易。

## 架构设计 - 方案C（已采用）

### 核心理念：两种独立的数据商品化路径

```
路径1: Activity → Snapshot → DataNFT    (活动数据商品化)
路径2: CSV Upload → DataNFT             (原始数据商品化)

两者最终都是 DataNFT，在同一个市场交易
```

---

## 📊 数据模型

### DataNFT 模型（扩展后）

```prisma
model DataNFT {
  id           String            @id @default(uuid())
  createdAt    DateTime          @default(now())
  updatedAt    DateTime          @updatedAt
  name         String
  description  String?
  price        Float
  isPublished  Boolean           @default(false)
  maxSales     Int               @default(1)
  currentSales Int               @default(0)
  merchantId   String
  image        String?
  
  // 新增字段：区分数据来源
  dataSource   String            @default("activity") // "activity" | "upload"
  dataRecords  Json?             // 存储直接上传的CSV数据
  
  merchant     User              @relation(...)
  purchases    DataNFTPurchase[]
  snapshots    Snapshot[]        @relation(...) // 活动数据用
  tags         Tag[]             @relation(...)
}
```

### Snapshot 模型（保持纯粹）

```prisma
model Snapshot {
  id          String    @id @default(uuid())
  name        String
  description String?
  activityId  String    // 必填！专注于活动快照
  merchantId  String
  claims      Json?
  activity    Activity  @relation(...)
  merchant    User      @relation(...)
  dataNFTs    DataNFT[] @relation(...)
  tags        Tag[]     @relation(...)
}
```

**关键点：**
- ✅ Snapshot 的 `activityId` 恢复为**必填**
- ✅ Snapshot 保持语义纯粹：只用于活动数据快照
- ✅ DataNFT 通过 `dataSource` 字段区分来源

---

## 🔄 两种 DataNFT 类型对比

### 类型1: 活动数据 DataNFT

**创建流程：**
```javascript
Activity (活动)
  ↓ 用户参与
ActivityClaim (参与记录)
  ↓ 商家创建快照
Snapshot (数据快照)
  ↓ 合并打包
DataNFT (dataSource: "activity")
```

**数据结构：**
```javascript
{
  id: "nft-xxx",
  dataSource: "activity",
  name: "Culture Web3 Forum 参与者数据",
  price: 299.99,
  snapshots: [
    {
      activityId: "culture-web3-forum",
      activity: { name: "Culture Web3 Forum" },
      claims: [
        { userId: "user-1", email: "user1@example.com", ... },
        // ... 更多参与记录
      ]
    }
  ],
  dataRecords: null  // 活动数据不使用此字段
}
```

**特点：**
- ✅ 有关联的活动信息
- ✅ 包含用户参与记录
- ✅ 可以从多个 Snapshot 合并
- ✅ Size 从 `snapshots[].claims` 计算

---

### 类型2: 上传数据包 DataNFT

**创建流程：**
```javascript
CSV File
  ↓ 直接导入
DataNFT (dataSource: "upload")
```

**数据结构：**
```javascript
{
  id: "nft-yyy",
  dataSource: "upload",
  name: "订单数据包 Q1 2025",
  price: 199.99,
  snapshots: [],  // 空数组
  dataRecords: {
    source: "data-pack-1.csv",
    fileName: "data-pack-1.csv",
    importDate: "2025-11-24T15:53:00.000Z",
    recordCount: 39,
    totalRecords: 40,
    skippedRecords: 1,
    headers: ["订单编号", "邮箱", "商品名称", "收件地址"],
    emailField: "邮箱",
    records: [
      {
        recordId: 1,
        email: "alice@example.com",
        订单编号: "105-xxx",
        邮箱: "alice@example.com",
        商品名称: "Nike Shoes",
        收件地址: "..."
      },
      // ... 更多记录
    ]
  }
}
```

**特点：**
- ✅ 无活动关联（snapshots = []）
- ✅ 数据直接存储在 `dataRecords`
- ✅ 保留完整的 CSV 结构
- ✅ Size 从 `dataRecords.recordCount` 计算

---

## 🎯 统一的市场交易

### 市场展示

两种 DataNFT 都在同一个市场中展示和交易：

| 特性 | 活动 DataNFT | 上传 DataNFT | 市场支持 |
|------|-------------|-------------|---------|
| **发布到市场** | ✅ | ✅ | ✅ 统一 |
| **定价** | ✅ | ✅ | ✅ 统一 |
| **搜索筛选** | ✅ | ✅ | ✅ 统一 |
| **标签分类** | ✅ | ✅ | ✅ 统一 |
| **购买流程** | ✅ | ✅ | ✅ 统一 |
| **交易记录** | ✅ | ✅ | ✅ 统一 |
| **数据展示** | 显示活动信息 | 显示数据来源 | ⚠️ 前端区分 |

### Size 计算逻辑

```javascript
// 在 dataNFTController.js 中
const dataWithSize = dataNFTs.map(nft => {
  let size = 0;
  
  if (nft.dataSource === 'upload' && nft.dataRecords) {
    // 上传数据包：从 dataRecords 计算
    size = nft.dataRecords.recordCount || 0;
  } else {
    // 活动数据：从 snapshots.claims 计算
    const allClaims = nft.snapshots.flatMap(s => s.claims || []);
    const uniqueUserIds = [...new Set(allClaims.map(c => c.userId).filter(Boolean))];
    size = uniqueUserIds.length;
  }
  
  return { ...nft, size };
});
```

---

## 📝 使用方式

### 1. 创建活动数据 DataNFT（路径1）

```bash
# 1. 创建活动并让用户参与
# 2. 创建快照
POST /api/merchant/snapshots
{
  "name": "Forum Snapshot 1",
  "activityId": "culture-web3-forum",
  "description": "First batch of participants"
}

# 3. 合并快照为 DataNFT
POST /api/merchant/datanfts/merge
{
  "snapshotIds": ["snapshot-1", "snapshot-2"],
  "name": "Culture Web3 Forum Data",
  "price": 299.99
}

# 4. 发布
PATCH /api/merchant/datanfts/{id}/publish
```

---

### 2. 创建上传数据包 DataNFT（路径2）

#### 方法A: 使用脚本导入

```bash
# 基本导入
node scripts/importDataPackAsDataNFT.js data-pack-1.csv

# 完整参数
node scripts/importDataPackAsDataNFT.js data-pack-1.csv \
  --name "Premium Customer Data Q1 2025" \
  --description "High-value customer orders with contact info" \
  --price 299.99 \
  --max-sales 10 \
  --publish

# 参数说明
--name <string>        # DataNFT 名称
--description <string> # 描述
--price <number>       # 价格（默认0）
--image <string>       # 图片路径
--publish              # 创建后自动发布
--max-sales <number>   # 最大销售数量（默认999999）
```

#### 方法B: 使用 API（待实现）

```bash
POST /api/merchant/datanfts/upload
Content-Type: multipart/form-data

{
  file: <CSV文件>,
  name: "Premium Customer Data",
  description: "High-value customers",
  price: 299.99,
  autoPublish: true
}
```

---

## 📋 CSV 文件要求

### 必需字段
- **邮箱字段**：列名包含 `email`、`邮箱` 或 `mail`（不区分大小写）

### 示例 CSV

```csv
订单编号,邮箱,商品名称,收件地址
105-7462910-4567890,alice.williams@gmx.com,Nike Running Shoes,"101 Elm St, Berlin, Germany"
107-4958372-6789012,david.miller@yandex.com,Lego Star Wars Set,"303 Cedar Blvd, Mumbai, India"
```

### 支持的格式
- ✅ 带引号的字段（处理字段内逗号）
- ✅ 任意列数和列名
- ✅ 中英文字段名
- ✅ 灵活的字段结构
- ✅ 自动跳过无效记录

---

## 🔧 数据库迁移

```bash
# 应用迁移
npx prisma migrate deploy

# 迁移内容
# 1. 为 DataNFT 添加 dataSource 字段（默认 "activity"）
# 2. 为 DataNFT 添加 dataRecords 字段（JSON）
```

迁移文件：`prisma/migrations/20251124155349_add_data_source_to_datanft/migration.sql`

---

## 🎨 前端集成示例

### DataNFT 卡片组件

```jsx
function DataNFTCard({ nft }) {
  return (
    <Card>
      <Image src={nft.image} />
      <h3>{nft.name}</h3>
      <p>{nft.description}</p>
      
      {/* 价格和数据量 */}
      <div className="stats">
        <span>${nft.price}</span>
        <span>{nft.size} 条记录</span>
      </div>
      
      {/* 来源标识 */}
      {nft.dataSource === 'upload' ? (
        <SourceBadge type="upload">
          <Icon name="database" />
          数据包
          <small>来源: {nft.dataRecords?.fileName}</small>
        </SourceBadge>
      ) : (
        <SourceBadge type="activity">
          <Icon name="users" />
          活动数据
          {nft.snapshots.map(s => (
            <small key={s.id}>来自: {s.activity.name}</small>
          ))}
        </SourceBadge>
      )}
      
      {/* 标签 */}
      <TagList>
        {nft.tags.map(tag => (
          <Tag key={tag.id}>{tag.name}</Tag>
        ))}
      </TagList>
      
      <Button onClick={() => purchase(nft.id)}>
        购买数据
      </Button>
    </Card>
  );
}
```

### 数据详情页

```jsx
function DataNFTDetail({ nftId }) {
  const { data: nft } = useDataNFT(nftId);
  
  return (
    <div>
      <h1>{nft.name}</h1>
      <p>{nft.description}</p>
      
      {/* 数据预览 */}
      {nft.dataSource === 'upload' ? (
        <DataPreview>
          <h3>数据字段</h3>
          <FieldList>
            {nft.dataRecords.headers.map(header => (
              <Field key={header}>{header}</Field>
            ))}
          </FieldList>
          
          <p>记录数: {nft.dataRecords.recordCount}</p>
          <p>邮箱字段: {nft.dataRecords.emailField}</p>
          <p>数据来源: {nft.dataRecords.fileName}</p>
        </DataPreview>
      ) : (
        <ActivityPreview>
          <h3>关联活动</h3>
          {nft.snapshots.map(snapshot => (
            <ActivityCard key={snapshot.id}>
              <h4>{snapshot.activity.name}</h4>
              <p>参与者: {snapshot.claims?.length || 0}</p>
            </ActivityCard>
          ))}
        </ActivityPreview>
      )}
      
      <PurchaseButton nftId={nft.id} price={nft.price} />
    </div>
  );
}
```

---

## 🔐 数据访问控制

### 购买后的数据访问

```javascript
// 购买 DataNFT 后，根据类型访问数据
const purchase = await prisma.dataNFTPurchase.findFirst({
  where: { buyerId: userId, dataNFTId: nftId },
  include: {
    dataNFT: {
      include: {
        snapshots: { include: { activity: true } },
        dataRecords: true
      }
    }
  }
});

if (purchase) {
  if (purchase.dataNFT.dataSource === 'upload') {
    // 访问上传的数据
    const records = purchase.dataNFT.dataRecords.records;
    const emails = records.map(r => r.email);
  } else {
    // 访问活动数据
    const allClaims = purchase.dataNFT.snapshots.flatMap(s => s.claims);
    const users = allClaims.map(c => c.user);
  }
}
```

---

## 📈 后续功能规划

### Phase 1: API 接口（进行中）
- ✅ 脚本导入完成
- ⬜ RESTful API 接口
- ⬜ 文件上传和验证
- ⬜ 异步处理大文件

### Phase 2: 前端界面
- ⬜ 拖拽上传组件
- ⬜ CSV 预览和字段映射
- ⬜ 数据验证反馈
- ⬜ 批量导入管理

### Phase 3: 数据增强
- ⬜ 数据去重分析
- ⬜ 数据质量评分
- ⬜ 数据分类建议
- ⬜ 相似数据推荐

### Phase 4: 高级功能
- ⬜ 数据加密存储
- ⬜ 分层访问权限
- ⬜ 数据使用追踪
- ⬜ 合规性检查

---

## ✅ 方案优势总结

### 与方案A、B的对比

| 维度 | 方案A (占位Activity) | 方案B (可选activityId) | 方案C (直接DataNFT) |
|------|---------------------|----------------------|-------------------|
| **语义清晰** | ❌ 需要假的占位活动 | ⚠️ Snapshot无活动很奇怪 | ✅ 直接是数据资产 |
| **架构纯粹** | ❌ 污染Activity概念 | ⚠️ Snapshot语义模糊 | ✅ 各司其职 |
| **流程简洁** | ⚠️ 3步（CSV→Snapshot→NFT） | ⚠️ 2步但语义不清 | ✅ 1步（CSV→NFT） |
| **可交易性** | ✅ 需要转换 | ✅ 需要转换 | ✅ 直接可交易 |
| **扩展性** | ⚠️ 受限于Activity | ⚠️ Snapshot职责混乱 | ✅ 灵活扩展 |

### 核心优势

1. **语义正确** ⭐⭐⭐
   - Snapshot 专注于活动快照
   - DataNFT 统一处理所有可交易数据
   - 通过 `dataSource` 清晰区分来源

2. **架构简洁** ⭐⭐⭐
   - 两条独立的数据商品化路径
   - 最终汇聚到统一的交易市场
   - 易于理解和维护

3. **用户体验** ⭐⭐⭐
   - 商家：一步创建可交易的数据资产
   - 买家：统一的购买体验
   - 清晰的来源标识

---

## 📚 相关文件

- **Schema**: `prisma/schema.prisma`
- **迁移**: `prisma/migrations/20251124155349_add_data_source_to_datanft/`
- **导入脚本**: `scripts/importDataPackAsDataNFT.js`
- **控制器**: `src/controllers/dataNFTController.js`
- **示例数据**: `data-pack-1.csv`

---

## 🎉 总结

方案C 通过清晰的职责分离和统一的市场机制，实现了：
- ✅ 活动数据商品化（Activity → Snapshot → DataNFT）
- ✅ 原始数据商品化（CSV → DataNFT）
- ✅ 统一的交易市场
- ✅ 清晰的架构语义

这是最优雅、最可扩展的解决方案！🚀
