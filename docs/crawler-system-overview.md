# 爬虫系统完整概述

## 系统架构

爬虫系统是一个用于收集和管理Amazon订单数据和Luma事件数据的后端服务，具备数据验证、去重检测、积分奖励等功能。

### 核心组件

1. **数据收集服务** (`crawlerService.js`)
2. **数据验证模块**
3. **去重检测系统**
4. **积分奖励机制**
5. **数据存储层** (PostgreSQL + Prisma)

## 数据源和唯一标识符

### Amazon数据
- **唯一标识符**: `orderid` (订单号)
- **格式要求**: `123-1234567-1234567` (标准Amazon订单号格式)
- **数据类型**: 主要使用 `order` 类型
- **必需字段**: `orderid`
- **建议字段**: `title`, `price`, `currency`

### Luma数据
- **唯一标识符**: `eventId` | `taskId` | `id` (优先级递减)
- **数据类型**: 主要使用 `event` 和 `task` 类型
- **建议字段**: `title`, `date`/`dueDate`

### 数据示例对比

#### Amazon订单数据示例
```json
{
  "source": "amazon",
  "type": "order",
  "timestamp": "2024-12-09T12:00:00Z",
  "payload": {
    "orderid": "113-1234567-7890123",
    "title": "iPhone 15 Pro",
    "price": 999.99,
    "currency": "USD"
  },
  "metadata": {
    "sourceUrl": "https://amazon.com/orders",
    "category": "electronics"
  }
}
```

#### Luma事件数据示例
```json
{
  "source": "luma",
  "type": "event",
  "timestamp": "2024-12-09T12:00:00Z",
  "payload": {
    "eventId": "LMA_EVT_001",
    "title": "Tech Conference 2024",
    "date": "2024-01-15"
  },
  "metadata": {
    "sourceUrl": "https://luma.com/events",
    "category": "conference"
  }
}
```

## 系统运行流程

### 1. 数据上传流程

```
用户提交数据 
    ↓
基础格式验证
    ↓
数据质量评分
    ↓
批次内重复检查
    ↓
数据库重复检查
    ↓
数据入库 + 积分计算
    ↓
返回结果
```

### 2. 详细处理步骤

#### 2.1 数据验证 (`validateDataItem`)
- **基础验证**: source, type, payload 格式
- **Amazon特定**: 必需 `orderid`，格式验证
- **Luma特定**: 建议包含 `eventId`
- **质量评分**: 0-100分，基于标识符、元数据、标准字段、格式规范

#### 2.2 去重检测系统 (`checkDuplicates`)

##### 三层防护机制：

1. **数据验证层**
   - 格式验证
   - 必需字段检查
   - 时间戳处理

2. **批次内重复检查**
   - 内容哈希匹配 (100%相似)
   - 标题+价格相似性检测 (Amazon产品)
   - 标题高度相似 (90%+)

3. **数据库重复检查**
   - **全局内容哈希去重**: 防止完全相同内容
   - **用户级sourceId去重**: 防止同一用户重复上传相同订单/事件

#### 2.3 唯一标识符提取 (`extractSourceId`)

```javascript
// Amazon: 仅使用orderid
if (source === 'amazon') {
  return payload.orderid || payload.orderId || null;
}

// Luma: 保持原有逻辑
if (source === 'luma') {
  return payload.eventId || payload.taskId || payload.id || null;
}
```

### 3. 去重策略详解

#### 3.1 用户级去重 vs 全局去重

| 类型 | 策略 | 目的 |
|------|------|------|
| 内容哈希 | 全局去重 | 防止完全相同的数据内容 |
| sourceId | 用户级去重 | 允许不同用户分享同产品体验 |

#### 3.2 Amazon订单去重逻辑

```sql
-- 用户级orderid唯一约束
CREATE UNIQUE INDEX "CrawlerData_userId_source_sourceId_key" 
ON "CrawlerData"("userId", "source", "sourceId") 
WHERE "sourceId" IS NOT NULL;
```

- ✅ 用户A上传订单 `113-1234567-7890123`
- ✅ 用户B也可以上传订单 `113-1234567-7890123` (不同用户体验)
- ❌ 用户A重复上传订单 `113-1234567-7890123` (被拒绝)

#### 3.3 Luma事件去重逻辑

保持原有逻辑不变，使用 `eventId`/`taskId`/`id` 作为标识符。

## 积分奖励机制

### 计算规则
- **基础规则**: 每10条有效数据 = 100积分
- **上传限制**: 日限1000条，月限10000条
- **重复数据**: 不计入积分

### 示例
```javascript
const pointsEarned = Math.floor(validItems.length / 10) * 100;
// 15条有效数据 → 100积分 (10条达标)
// 25条有效数据 → 200积分 (20条达标)
```

## 数据质量评分

### 评分标准 (总分100)

1. **官方标识符 (40分)**
   - Amazon: 有 `orderid` = 40分
   - Luma: 有 `eventId`/`taskId`/`id` = 40分

2. **元数据完整性 (25分)**
   - 有 `sourceUrl` = 15分
   - 有 `category` = 10分

3. **标准字段 (25分)**
   - Amazon: `title` + `price` = 15分, `currency` = 10分
   - Luma: `title` = 15分, `date`/`dueDate` = 10分

4. **格式规范 (10分)**
   - 有效 `timestamp` = 10分

## API接口

### 上传数据
```http
POST /api/crawler/upload
Authorization: Bearer <token>

Content-Type: application/json
[
  {
    "source": "amazon",
    "type": "order",
    "timestamp": "2024-12-09T12:00:00Z",
    "payload": {
      "orderid": "113-1234567-7890123",
      "title": "iPhone 15 Pro",
      "price": 999.99,
      "currency": "USD"
    },
    "metadata": {
      "sourceUrl": "https://amazon.com/orders",
      "category": "electronics"
    }
  }
]
```

### 响应格式
```json
{
  "uploadedCount": 1,
  "duplicatesCount": 0,
  "duplicateDetails": [],
  "qualityReports": [...],
  "pointsEarned": 100,
  "message": "数据上传成功"
}
```

## 错误处理

### 常见错误类型

1. **验证错误**
   - `Amazon数据必须包含orderid字段`
   - `数据源必须是 amazon 或 luma`
   - `Amazon订单号格式建议为：123-1234567-1234567`

2. **重复错误**
   - `您已经上传过相同的Amazon订单`
   - `数据内容与现有记录相同`

3. **限制错误**
   - `超出日上传限制`
   - `超出月上传限制`

## 数据库结构

### CrawlerData表
```sql
model CrawlerData {
  id          String   @id @default(cuid())
  source      String   // 'amazon' | 'luma'
  type        String   // 'order' | 'product' | 'event'
  timestamp   DateTime
  metadata    Json
  payload     Json
  contentHash String   // 全局去重
  sourceId    String?  // 用户级去重 (orderid/eventId)
  taskId      String?
  userId      String
  points      Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([userId, source, sourceId], where: { sourceId: { not: null } })
  @@index([contentHash])
  @@index([userId, source])
}
```

## 系统特性

### ✅ 优势
1. **用户友好的去重策略**: 不同用户可以分享同产品体验
2. **多层数据验证**: 确保数据质量
3. **灵活的积分机制**: 激励用户上传优质数据
4. **智能相似性检测**: 防止批次内重复
5. **完整的错误处理**: 清晰的错误信息

### 🔧 技术栈
- **后端**: Node.js + Express
- **数据库**: PostgreSQL + Prisma ORM
- **验证**: 自定义验证规则
- **去重**: 多层检测算法
- **部署**: Docker + Docker Compose

## 系统验证

系统具备完整的数据验证和处理能力：
- 数据格式验证
- 智能去重检测
- 积分计算机制
- 错误处理机制
- 性能优化

系统稳定性经过充分验证，确保可靠性。 