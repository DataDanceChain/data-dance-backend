# Airbnb & Booking Data Collection Implementation

## 概述

已成功启用 Airbnb 和 Booking 数据上传任务，完全复用 Amazon 数据上传的数据结构和业务逻辑。

---

## 实现总结

### ✅ 数据结构复用

**完全复用** - Airbnb 和 Booking 使用与 Amazon 相同的数据结构：

- **数据库表**: 使用相同的 `CrawlerData` 表
- **字段结构**: `source`, `type`, `timestamp`, `payload`, `metadata`, `contentHash`, `sourceId`
- **验证逻辑**: 复用通用验证逻辑（特定验证规则可扩展）
- **去重机制**: 使用相同的 `contentHash` 和 `sourceId` 去重

### ✅ 业务规则复用

**完全复用** - Airbnb 和 Booking 使用与 Amazon 相同的业务规则：

- **积分规则**: 每条有效数据 10 积分
- **每日限制**: 1,000 条
- **每月限制**: 10,000 条
- **奖励规则**: "Earn 10 points for each valid data item submitted"

### ✅ 任务系统集成

**完全集成** - Airbnb 和 Booking 已集成到任务系统：

- **Award ID**: 
  - `airbnb-data-collection`
  - `booking-data-collection`
- **Task ID**:
  - `airbnb-trip-submit`
  - `booking-trip-submit`
- **状态**: `enabled: true` - 已启用

---

## 文件更改清单

### 1. 配置文件

#### `config/awards.json`
- ✅ 添加 `airbnb-data-collection` award（enabled: true）
- ✅ 添加 `booking-data-collection` award（enabled: true）

#### `config/business-rules.json`
- ✅ 添加 `airbnb` 数据采集规则（复用 Amazon 规则）
- ✅ 添加 `booking` 数据采集规则（复用 Amazon 规则）

### 2. 服务层

#### `src/services/businessRulesService.js`
- ✅ 添加 `calculateDataPoints(source, validItemCount)` - 通用积分计算函数
- ✅ 添加 `checkDataLimits(userId, source, itemCount)` - 通用限制检查函数
- ✅ 添加 `getDataRules(source)` - 通用规则获取函数
- ✅ 保留原有 Amazon 专用函数（向后兼容）

#### `src/services/crawlerService.js`
- ✅ 更新 `uploadCrawlerData` 使用通用积分计算函数
- ✅ 按数据源分组计算积分（支持混合数据源上传）

#### `src/services/taskService.js`
- ✅ 添加 `airbnb-data-collection` award strategy
- ✅ 添加 `booking-data-collection` award strategy
- ✅ 更新任务状态计算逻辑，支持新的数据采集任务
- ✅ 更新 `doneCount` 计算逻辑

### 3. 控制器层

#### `src/controllers/crawlerController.js`
- ✅ 更新 `uploadData` 支持多数据源限制检查
- ✅ 使用通用 `checkDataLimits` 函数
- ✅ 响应中包含所有数据源的限制信息

---

## API 使用示例

### 1. 获取用户 Awards（包含 Airbnb 和 Booking）

```bash
GET /api/users/awards
Authorization: Bearer <token>
```

**响应示例:**
```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "awardId": "amazon-data-collection",
        "title": "Amazon Data Collection",
        "enabled": true,
        "finalStatus": "IN_PROGRESS",
        "tasks": [...]
      },
      {
        "awardId": "airbnb-data-collection",
        "title": "Airbnb Data Collection",
        "enabled": true,
        "finalStatus": "PARTICIPATE",
        "tasks": [...]
      },
      {
        "awardId": "booking-data-collection",
        "title": "Booking Data Collection",
        "enabled": true,
        "finalStatus": "PARTICIPATE",
        "tasks": [...]
      }
    ]
  }
}
```

### 2. 上传 Airbnb 数据

```bash
POST /api/crawler/upload
Authorization: Bearer <token>
Content-Type: application/json

{
  "data": [
    {
      "source": "airbnb",
      "type": "trip",
      "timestamp": "2025-12-15T10:00:00Z",
      "payload": {
        "tripId": "trip-123",
        "title": "Beautiful Apartment in Paris",
        "price": "150.00",
        "currency": "EUR",
        "checkIn": "2025-12-20",
        "checkOut": "2025-12-25"
      },
      "metadata": {
        "sourceUrl": "https://airbnb.com/trips/trip-123",
        "category": "accommodation"
      }
    }
  ]
}
```

**响应示例:**
```json
{
  "status": "success",
  "data": {
    "uploadedCount": 1,
    "pointsEarned": 10,
    "duplicatesCount": 0,
    "sourceLimits": {
      "airbnb": {
        "remainingDaily": 999,
        "remainingMonthly": 9999
      }
    }
  }
}
```

### 3. 上传 Booking 数据

```bash
POST /api/crawler/upload
Authorization: Bearer <token>
Content-Type: application/json

{
  "data": [
    {
      "source": "booking",
      "type": "trip",
      "timestamp": "2025-12-15T10:00:00Z",
      "payload": {
        "bookingId": "booking-456",
        "title": "Luxury Hotel in Tokyo",
        "price": "200.00",
        "currency": "USD",
        "checkIn": "2025-12-20",
        "checkOut": "2025-12-25"
      },
      "metadata": {
        "sourceUrl": "https://booking.com/bookings/booking-456",
        "category": "accommodation"
      }
    }
  ]
}
```

### 4. 混合数据源上传

```bash
POST /api/crawler/upload
Authorization: Bearer <token>
Content-Type: application/json

{
  "data": [
    {
      "source": "amazon",
      "type": "order",
      "payload": { "orderid": "123-4567890-1234567", ... }
    },
    {
      "source": "airbnb",
      "type": "trip",
      "payload": { "tripId": "trip-123", ... }
    },
    {
      "source": "booking",
      "type": "trip",
      "payload": { "bookingId": "booking-456", ... }
    }
  ]
}
```

**响应示例:**
```json
{
  "status": "success",
  "data": {
    "uploadedCount": 3,
    "pointsEarned": 30,
    "duplicatesCount": 0,
    "sourceLimits": {
      "amazon": {
        "remainingDaily": 999,
        "remainingMonthly": 9999
      },
      "airbnb": {
        "remainingDaily": 999,
        "remainingMonthly": 9999
      },
      "booking": {
        "remainingDaily": 999,
        "remainingMonthly": 9999
      }
    }
  }
}
```

---

## 数据结构说明

### 数据项格式

所有数据源使用相同的数据结构：

```typescript
interface DataItem {
  source: 'amazon' | 'luma' | 'airbnb' | 'booking';
  type: 'order' | 'trip' | 'event' | 'product' | 'custom';
  timestamp: string;  // ISO 8601 格式
  payload: {
    // 数据源特定字段
    // Amazon: orderid, title, price, currency, ...
    // Airbnb: tripId, title, price, currency, checkIn, checkOut, ...
    // Booking: bookingId, title, price, currency, checkIn, checkOut, ...
    [key: string]: any;
  };
  metadata?: {
    sourceUrl?: string;
    category?: string;
    region?: string;
    [key: string]: any;
  };
}
```

### 验证规则

**通用验证**（所有数据源）:
- ✅ `source` 必须是 `'amazon'`, `'luma'`, `'airbnb'`, 或 `'booking'`
- ✅ `type` 必须存在
- ✅ `payload` 必须是对象
- ✅ 建议包含 `metadata.sourceUrl`

**特定验证**（可扩展）:
- Amazon: 需要 `payload.orderid`
- Luma: 建议包含 `payload.eventId` 或 `payload.taskId`
- Airbnb/Booking: 目前使用通用验证（可根据需要添加特定验证）

---

## 积分计算逻辑

### 计算公式

```javascript
// 通用积分计算
points = validItemCount × pointsPerItem

// 当前规则
points = validItemCount × 10
```

### 积分计算流程

1. **按数据源分组**: 上传的数据按 `source` 分组
2. **分别计算**: 每个数据源独立计算积分
3. **汇总积分**: 所有数据源的积分相加
4. **更新用户积分**: 一次性更新用户总积分

**示例:**
- 上传 5 条 Amazon 数据 → 50 积分
- 上传 3 条 Airbnb 数据 → 30 积分
- 上传 2 条 Booking 数据 → 20 积分
- **总计**: 100 积分

---

## 限制检查逻辑

### 限制规则

每个数据源独立计算限制：

- **每日限制**: 1,000 条/数据源
- **每月限制**: 10,000 条/数据源

### 限制检查流程

1. **按数据源分组**: 上传的数据按 `source` 分组
2. **分别检查**: 每个数据源独立检查限制
3. **返回错误**: 如果任一数据源超过限制，返回 429 错误

**示例:**
- 用户今日已上传 999 条 Amazon 数据
- 尝试再上传 2 条 Amazon 数据 → ❌ 错误（超过每日限制）
- 但可以上传 Airbnb 或 Booking 数据 → ✅ 允许

---

## 任务进度跟踪

### 进度计算

每个数据采集任务独立跟踪进度：

- **Amazon Data Collection**: 跟踪 `source: 'amazon'` 的数据条数
- **Airbnb Data Collection**: 跟踪 `source: 'airbnb'` 的数据条数
- **Booking Data Collection**: 跟踪 `source: 'booking'` 的数据条数

### 任务状态

- **PARTICIPATE**: 未开始（progress = 0）
- **IN_PROGRESS**: 已提交数据（progress > 0）
- **COMPLETED**: 不适用（无限制任务）
- **CLAIMED**: 不适用（无限制任务）

---

## 数据库变更

### 无需数据库迁移

✅ **完全复用现有表结构** - 无需创建新表或添加新字段

- 使用现有的 `CrawlerData` 表
- 使用现有的 `CrawlerTask` 表
- 使用现有的 `Award` 和 `Task` 表
- 使用现有的 `UserAward` 和 `UserTask` 表

### 需要运行脚本

运行以下脚本创建新的 awards 和 tasks：

```bash
node scripts/setupChristmasBadge.js
```

或者手动运行：

```bash
node scripts/createAwards.js
```

---

## 前端集成

### 1. 显示新的 Awards

前端需要更新以显示 Airbnb 和 Booking 数据采集任务：

```javascript
// 获取用户 awards
const response = await fetch('/api/users/awards', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { awards } = await response.json();

// 过滤数据采集相关的 awards
const dataCollectionAwards = awards.filter(award => 
  award.awardId.includes('data-collection')
);

// 现在包含:
// - amazon-data-collection
// - airbnb-data-collection
// - booking-data-collection
```

### 2. 上传数据

上传逻辑无需更改，只需在 `source` 字段中指定数据源：

```javascript
// 上传 Airbnb 数据
await uploadData({
  source: 'airbnb',
  type: 'trip',
  payload: { ... },
  metadata: { ... }
});

// 上传 Booking 数据
await uploadData({
  source: 'booking',
  type: 'trip',
  payload: { ... },
  metadata: { ... }
});
```

### 3. 显示限制信息

响应中包含所有数据源的限制信息：

```javascript
const response = await uploadData(data);
const { sourceLimits } = response.data;

// sourceLimits 结构:
// {
//   amazon: { remainingDaily: 999, remainingMonthly: 9999 },
//   airbnb: { remainingDaily: 999, remainingMonthly: 9999 },
//   booking: { remainingDaily: 999, remainingMonthly: 9999 }
// }
```

---

## 测试建议

### 1. 单元测试

- ✅ 测试通用积分计算函数
- ✅ 测试通用限制检查函数
- ✅ 测试任务进度计算

### 2. 集成测试

- ✅ 测试 Airbnb 数据上传
- ✅ 测试 Booking 数据上传
- ✅ 测试混合数据源上传
- ✅ 测试限制检查
- ✅ 测试积分计算

### 3. 端到端测试

- ✅ 测试完整的用户流程（上传 → 积分 → 任务进度）
- ✅ 测试多数据源同时上传
- ✅ 测试限制边界情况

---

## 总结

✅ **完全复用数据结构** - Airbnb 和 Booking 使用与 Amazon 相同的数据结构  
✅ **完全复用业务规则** - 使用相同的积分规则和限制规则  
✅ **完全集成任务系统** - 已集成到现有的任务和奖励系统  
✅ **无需数据库迁移** - 完全使用现有表结构  
✅ **向后兼容** - 保留所有原有 Amazon 专用函数和 API

---

## 相关文件

- `config/awards.json` - Awards 配置
- `config/business-rules.json` - 业务规则配置
- `src/services/businessRulesService.js` - 业务规则服务
- `src/services/crawlerService.js` - 爬虫数据服务
- `src/services/taskService.js` - 任务服务
- `src/controllers/crawlerController.js` - 爬虫控制器
