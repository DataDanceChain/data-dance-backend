# 爬虫扩展完整规范

## 概述

爬虫扩展后端系统支持 Amazon 和 Luma 数据收集，包含数据验证、积分奖励、限制管理等功能。用户通过浏览器扩展上传数据，系统自动验证、计算积分并管理上传限制。

### 核心特性

- **统一数据格式**: 所有数据源都转换为标准 DataItem 格式
- **自动任务管理**: 用户首次访问时自动创建 Amazon 和 Luma 任务
- **积分奖励系统**: 每10条有效数据获得100积分
- **上传限制**: 日限1000条，月限10000条数据
- **多格式支持**: API支持单条、批量、包装等多种上传格式
- **实时验证**: 严格的数据格式和业务规则验证

## 数据格式规范

### 统一数据结构 (DataItem)

```typescript
interface DataItem {
  source: 'amazon' | 'luma';
  type: 'product' | 'price' | 'review' | 'event' | 'task' | 'custom';
  timestamp: string;  // ISO8601格式
  metadata?: {
    sourceUrl?: string;
    category?: string;
    language?: string;
    region?: string;
    tags?: string[];
  };
  payload: Record<string, any>;
}
```

### 数据示例

#### Amazon 商品数据
```json
{  
  "source": "amazon",  
  "type": "product",  
  "timestamp": "2025-06-02T11:58:00Z",  
  "metadata": {  
    "sourceUrl": "https://www.amazon.com/dp/B09X123456",  
    "category": "Electronics",  
    "language": "en-US",  
    "region": "US",  
    "tags": ["bestseller"]
  },  
  "payload": {  
    "asin": "B09X123456",  
    "title": "Wireless Bluetooth Headphones",  
    "brand": "Sony",  
    "price": 129.99,  
    "currency": "USD",  
    "rating": 4.6,  
    "reviewCount": 2034,  
    "availability": "In Stock"  
  }  
}
```

#### Luma 任务数据
```json
{  
  "source": "luma",  
  "type": "task",  
  "timestamp": "2025-06-02T11:59:00Z",  
  "metadata": {  
    "sourceUrl": "https://luma.ai/workspace/xyz123/task/abc",  
    "language": "en-US",  
    "region": "Global",  
    "tags": ["user-generated"]
  },  
  "payload": {  
    "taskId": "task-abc",  
    "title": "Fix onboarding flow bug",  
    "status": "in_progress",
    "assignee": "jane@example.com",  
    "dueDate": "2025-06-05"  
  }  
}
```

## API 接口

### 获取爬虫任务列表

```http
GET /api/crawler-tasks
Authorization: Bearer <JWT>

Query Parameters:
- source: 'amazon' | 'luma' (可选)
- status: 'pending' | 'running' | 'done' | 'error' (可选)
- search: string (可选)
- page: number (默认: 1)
- limit: number (默认: 10, 最大: 100)
```

**响应示例:**
```json
{  
  "status": "success",  
  "data": {  
    "tasks": [
      {  
        "id": "task-amz-20250601-xyz",  
        "title": "Amazon Order History",
        "description": "Crawl your Amazon order history to earn rewards",
        "source": "amazon",  
        "status": "running",
        "createdAt": "2025-06-01T09:00:00.000Z",  
        "updatedAt": "2025-06-01T09:30:00.000Z",  
        "recordCount": 100,
        "dataUrl": null,
        "log": null,
        "tags": [
          { "id": "amazon", "name": "Amazon" },
          { "id": "orders", "name": "Orders" }
        ]
      }  
    ],
    "pagination": {  
      "page": 1,  
      "limit": 10,  
      "total": 2,
      "pages": 1
    }  
  }  
}
```

### 获取单个任务详情

```http
GET /api/crawler-tasks/{taskId}
Authorization: Bearer <JWT>
```

**响应示例:**
```json
{
  "success": true,
  "data": {
    "id": "task-amz-20250601-xyz",
    "title": "Amazon Order History",
    "description": "Crawl your Amazon order history to earn rewards",
    "source": "amazon",
    "status": "running",
    "createdAt": "2025-06-01T09:00:00.000Z",
    "updatedAt": "2025-06-01T09:30:00.000Z",
    "recordCount": 100,
    "dataUrl": null,
    "log": "Fetched 100 records. No errors.",
    "payloadPreview": [
      {
        "asin": "B09X123456",
        "title": "Wireless Bluetooth Headphones",
        "price": 129.99,
        "rating": 4.6
      }
    ],
    "tags": [
      { "id": "amazon", "name": "Amazon" },
      { "id": "orders", "name": "Orders" }
    ],
    "triggeredBy": {
      "id": "user-uuid",
      "name": "John Smith",
      "email": "john@example.com"
    }
  }
}
```

### 上传爬虫数据

```http
POST /api/upload
Authorization: Bearer <JWT>
Content-Type: application/json
```

**请求格式（支持三种）:**
```javascript
// 1. 直接数组
[DataItem, DataItem, ...]

// 2. 单个对象
DataItem

// 3. 包装格式（兼容）
{
  "data": DataItem | DataItem[]
}
```

**响应示例:**
```json
{
  "status": "success",
  "data": {  
    "uploadedCount": 10,     // 本次上传成功条数
    "pointsEarned": 100      // 本次获得积分
  }
}
```

## 业务规则

### 任务管理
- **任务模板**: 系统预定义 Amazon 和 Luma 两个任务模板
- **任务实例**: 每个用户独立拥有基于模板的任务实例
- **自动创建**: 首次访问时自动为用户创建默认任务
- **多源支持**: 用户可同时进行多个不同源的任务

### 数据验证
- **必填字段**: source, type, timestamp, payload
- **格式验证**: 时间戳必须符合 ISO8601 格式
- **类型验证**: source 和 type 必须在允许的枚举值内
- **负载验证**: 根据 type 验证 payload 必需字段

### 奖励机制
- **积分计算**: 每 10 条有效数据 = 100 积分
- **自动发放**: 数据上传成功后立即计算并发放积分
- **限制控制**: 
  - 日限制: 1000 条数据 (最多 10,000 积分/天)
  - 月限制: 10,000 条数据 (最多 100,000 积分/月)

### 错误处理
- **400 Bad Request**: 数据格式错误、必填字段缺失
- **401 Unauthorized**: JWT token 无效或过期
- **429 Too Many Requests**: 超出日/月上传限制
- **500 Internal Server Error**: 系统内部错误

## 数据库模型

### CrawlerTask (爬虫任务)
```prisma
model CrawlerTask {
  id          String   @id @default(uuid())
  title       String   // 任务标题
  description String?  // 任务描述
  source      String   // 数据源: 'amazon' | 'luma'
  status      String   // 状态: 'pending' | 'running' | 'done' | 'error'
  recordCount Int      @default(0)  // 已收集数据条数
  dataUrl     String?  // 数据文件URL（预留）
  log         String?  // 任务日志（预留）
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  crawlerData CrawlerData[]
}
```

### CrawlerData (爬虫数据)
```prisma
model CrawlerData {
  id        String      @id @default(uuid())
  source    String      // 数据源
  type      String      // 数据类型
  timestamp DateTime    // 数据时间戳
  metadata  Json        // 元数据 (JSON)
  payload   Json        // 负载数据 (JSON)
  taskId    String
  task      CrawlerTask @relation(fields: [taskId], references: [id])
  userId    String
  user      User        @relation(fields: [userId], references: [id])
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
}
```

## 技术实现

### 核心服务 (crawlerService.js)
- **任务管理**: 自动初始化、查询、状态更新
- **数据验证**: 严格的格式和业务规则验证
- **限制检查**: 实时的日/月限制检查
- **积分计算**: 自动计算并集成奖励系统
- **批量处理**: 支持单条和批量数据上传

### API控制器 (crawlerController.js)
- **GET /api/crawler-tasks**: 任务列表查询（支持过滤、分页）
- **POST /api/upload**: 数据上传（支持多种格式）
- 统一错误处理和日志记录

### 数据类型支持
| Type | Required Fields | Description |
|------|----------------|-------------|
| product | title, price | 商品信息 |
| price | price, currency | 价格信息 |
| review | rating, content | 评论信息 |
| event | title, date | 事件信息 |
| task | title, status | 任务信息 |
| custom | - | 自定义数据 |

## 使用示例

### 前端集成

#### JavaScript/浏览器扩展
```javascript
// 通用上传函数 - 支持单条或批量数据
async function uploadData(data) {
  const response = await fetch("https://your-api.com/api/upload", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(Array.isArray(data) ? data : [data])
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.statusText}`);
  }
  
  return response.json();
}

// 使用示例
const amazonProduct = {
  source: "amazon",
  type: "product", 
  timestamp: new Date().toISOString(),
  metadata: { sourceUrl: "https://www.amazon.com/dp/B123" },
  payload: { title: "Wireless Headphones", price: 99.99 }
};

uploadData(amazonProduct).then(result => {
  console.log(`上传成功: ${result.data.uploadedCount} 条数据, 获得 ${result.data.pointsEarned} 积分`);
});
```

#### Node.js 后端示例
```javascript
app.post('/api/upload', async (req, res) => {
  const data = req.body;
  
  for (const item of Array.isArray(data) ? data : [data]) {
    console.log(`[${item.source}:${item.type}] from ${item.metadata?.sourceUrl}`);
    // 存储到数据库 / 消息队列 / 云存储
  }
  
  res.json({ status: 'success', data: { uploadedCount: data.length } });
});
```

### cURL 测试
```bash
# 登录获取token
curl -X POST http://localhost:10000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "password123"}'

# 查看任务
curl -X GET "http://localhost:10000/api/crawler-tasks" \
  -H "Authorization: Bearer $TOKEN"

# 上传数据
curl -X POST http://localhost:10000/api/upload \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '[{"source":"amazon","type":"product","timestamp":"2025-06-09T12:00:00Z","payload":{"title":"Test Product","price":99.99}}]'
```

## 扩展性设计

### 多源统一
- **设计理念**: DataItem schema 统一所有数据源格式
- **新增源**: 只需添加新的 `source` 值和对应任务模板
- **示例**: 支持 `alibaba`、`ebay`、`shopify` 等电商平台

| 场景 | 实现方式 |
|------|----------|
| 支持新数据源 | 添加 `source` 枚举值，更新任务模板 |
| 同商品多版本对比 | 使用 `payload.version`、`payload.variation` |
| 上报失败重试 | 插件内加 IndexedDB 缓存，断网后重发 |
| 数据加密 | 添加 `encryption: { algorithm, keyId }` 字段 |
| 地域化支持 | 通过 `metadata.region`、`metadata.language` |

### 性能优化建议
- **批量上传**: 建议每次上传10-50条数据以获得最佳性能
- **错误重试**: 使用指数退避算法处理网络错误
- **缓存机制**: 前端可缓存任务信息减少API调用
- **分页查询**: 大量数据时使用分页避免超时

### 安全考虑
- **数据脱敏**: 敏感信息在存储前进行脱敏处理
- **访问控制**: 用户只能访问自己的任务和数据
- **速率限制**: API 自带速率限制防止滥用
- **数据验证**: 严格的输入验证防止注入攻击

## 实施状态

### ✅ 已完成功能
- 数据库模型设计和迁移
- 核心服务层实现（crawlerService.js）
- API控制器和路由配置
- 数据验证和积分计算
- 自动任务初始化
- 完整的错误处理
- 单元测试和集成测试

### 📋 测试验证
- ✅ 用户认证和任务创建
- ✅ 单条和批量数据上传
- ✅ 多种数据格式支持
- ✅ 积分计算和奖励发放
- ✅ 上传限制检查
- ✅ API过滤和分页功能
- ✅ 错误处理和异常恢复

### 🚀 生产就绪
- **性能**: 支持高并发数据上传
- **可扩展**: 模块化设计便于功能扩展
- **监控**: 完整的日志记录和错误追踪
- **文档**: 完整的API文档和使用示例

---

**系统状态**: ✅ 已完全实现并通过全面测试，可立即投入生产环境使用 