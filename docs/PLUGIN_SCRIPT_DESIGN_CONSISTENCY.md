# Plugin Script Design - Consistency with Existing System

## 设计一致性分析

### ✅ 与现有系统模式一致

当前插件脚本版本管理系统的设计完全符合现有系统的架构模式。

---

## 现有系统的数据存储模式

### 1. CrawlerData 模型（爬虫数据）

```prisma
model CrawlerData {
  payload     Json    // 存储实际数据内容（JSON 格式）
  metadata    Json    // 存储元数据（JSON 格式）
  // ...
}
```

**特点：**
- ✅ 使用 `Json` 类型存储结构化数据
- ✅ 使用 `metadata` 存储额外信息
- ✅ 数据存储在数据库中

### 2. Task 模型（任务）

```prisma
model Task {
  description String?
  metadata    Json?   @default("{}")
  // ...
}
```

**特点：**
- ✅ 使用 `String` 存储描述文本
- ✅ 使用 `Json` 存储元数据
- ✅ 数据存储在数据库中

### 3. Award 模型（奖励）

```prisma
model Award {
  description String
  metadata    Json?   @default("{}")
  // ...
}
```

**特点：**
- ✅ 使用 `String` 存储描述
- ✅ 使用 `Json` 存储元数据
- ✅ 数据存储在数据库中

---

## 插件脚本设计（新系统）

### PluginScript 模型

```prisma
model PluginScript {
  script      String   // JavaScript 代码（纯文本）
  description String?  // 版本描述
  metadata    Json?    @default("{}") // 元数据（changelog, author等）
  // ...
}
```

**特点：**
- ✅ 使用 `String` 存储脚本内容（纯文本，类似 description）
- ✅ 使用 `Json` 存储元数据（与现有系统一致）
- ✅ 使用 `String?` 存储描述（与现有系统一致）
- ✅ 数据存储在数据库中（与现有系统一致）

---

## 一致性对比

| 特性 | 现有系统 | 插件脚本系统 | 一致性 |
|------|---------|-------------|--------|
| **数据存储** | 数据库 | 数据库 | ✅ 一致 |
| **内容字段** | `payload Json` (CrawlerData) | `script String` | ✅ 合理（脚本是文本） |
| **元数据** | `metadata Json` | `metadata Json` | ✅ 完全一致 |
| **描述字段** | `description String?` | `description String?` | ✅ 完全一致 |
| **时间戳** | `createdAt`, `updatedAt` | `createdAt`, `updatedAt` | ✅ 完全一致 |
| **状态管理** | `status` 字段 | `isActive`, `isLatest` | ✅ 类似模式 |
| **唯一约束** | 各种唯一约束 | `@@unique([platform, clientTag, version])` | ✅ 一致模式 |

---

## 为什么脚本用 String 而不是 Json？

### 现有系统使用 Json 的原因

```prisma
// CrawlerData - 存储结构化数据
payload Json  // 例如: { "orderid": "123", "title": "...", "price": "..." }
```

**原因：**
- 数据是结构化的（对象、数组）
- 需要查询和过滤特定字段
- 需要 JSON 操作

### 插件脚本使用 String 的原因

```prisma
// PluginScript - 存储代码文本
script String  // 例如: "(function() { console.log('...'); })();"
```

**原因：**
- 脚本是纯文本（JavaScript 代码）
- 不需要结构化查询
- 直接存储和执行更简单
- 类似 `description` 字段的用法

---

## 与现有 API 模式一致

### 现有 API 模式

```javascript
// CrawlerData 上传
POST /api/crawler/upload
{
  "data": [
    {
      "source": "amazon",
      "payload": { ... },  // JSON 对象
      "metadata": { ... }  // JSON 对象
    }
  ]
}
```

### 插件脚本 API 模式

```javascript
// PluginScript 上传
POST /api/plugin-scripts/upload
{
  "platform": "amazon",
  "script": "(function() { ... })();",  // 字符串（代码）
  "metadata": { ... }  // JSON 对象（与现有系统一致）
}
```

**一致性：**
- ✅ 都使用 JSON 请求体
- ✅ 都使用 `metadata` 字段存储元数据
- ✅ 都返回统一的响应格式 `{ status, data }`

---

## 与现有服务层模式一致

### 现有服务模式

```javascript
// crawlerService.js
async function uploadCrawlerData(data, userId) {
  // 验证数据
  // 存储到数据库
  // 返回结果
}
```

### 插件脚本服务模式（设计）

```javascript
// pluginScriptService.js
async function uploadScript(scriptData) {
  // 验证版本格式
  // 存储到数据库
  // 管理 latest 版本
  // 返回结果
}
```

**一致性：**
- ✅ 都使用 Service 层处理业务逻辑
- ✅ 都进行数据验证
- ✅ 都使用 Prisma 操作数据库
- ✅ 都返回统一格式的结果

---

## 与现有控制器模式一致

### 现有控制器模式

```javascript
// crawlerController.js
async function uploadData(req, res) {
  try {
    const result = await crawlerService.uploadCrawlerData(...);
    res.json({ status: 'success', data: result });
  } catch (error) {
    res.status(500).json({ status: 'error', message: ... });
  }
}
```

### 插件脚本控制器模式（设计）

```javascript
// pluginScriptController.js
async function uploadScript(req, res) {
  try {
    const result = await pluginScriptService.uploadScript(...);
    res.json({ status: 'success', data: result });
  } catch (error) {
    res.status(400).json({ status: 'error', message: ... });
  }
}
```

**一致性：**
- ✅ 都使用 try-catch 错误处理
- ✅ 都返回统一的响应格式
- ✅ 都进行参数验证

---

## 数据格式一致性

### 现有系统：CrawlerData

```json
{
  "source": "amazon",
  "type": "order",
  "payload": {
    "orderid": "123-4567890-1234567",
    "title": "Product Name",
    "price": "99.99"
  },
  "metadata": {
    "sourceUrl": "https://amazon.com/...",
    "category": "Electronics"
  }
}
```

### 插件脚本系统：PluginScript

```json
{
  "platform": "amazon",
  "clientTag": "chrome-extension",
  "version": "1.2.0",
  "script": "(function() { ... })();",
  "metadata": {
    "changelog": "Fixed order parsing",
    "author": "dev-team"
  }
}
```

**一致性：**
- ✅ 都使用 `metadata` 存储额外信息
- ✅ 都使用 JSON 格式
- ✅ 都存储在数据库中

---

## 版本管理模式的参考

### 现有系统：Task 版本管理

虽然没有显式的版本号，但 Task 系统有类似的概念：
- `status` 字段管理状态
- `metadata` 存储版本相关信息
- 通过 `updatedAt` 追踪更新时间

### 插件脚本系统：显式版本管理

```prisma
version     String   // 显式版本号
isLatest    Boolean  // 最新版本标记
isActive    Boolean  // 活跃状态
```

**改进：**
- ✅ 更明确的版本管理
- ✅ 支持语义化版本
- ✅ 支持版本回滚

---

## 总结

### ✅ 完全符合现有系统模式

1. **数据存储方式**
   - ✅ 都存储在数据库中
   - ✅ 都使用 Prisma ORM

2. **字段类型选择**
   - ✅ 文本内容用 `String`（script, description）
   - ✅ 结构化数据用 `Json`（metadata）
   - ✅ 与现有系统一致

3. **API 设计模式**
   - ✅ 统一的请求/响应格式
   - ✅ 统一的错误处理
   - ✅ 统一的验证逻辑

4. **服务层架构**
   - ✅ Service 层处理业务逻辑
   - ✅ Controller 层处理 HTTP
   - ✅ 统一的代码组织

5. **元数据管理**
   - ✅ 都使用 `metadata Json` 字段
   - ✅ 都支持灵活的扩展

### 🎯 设计优势

- **一致性**: 与现有代码库完全一致
- **可维护性**: 遵循现有模式，易于理解和维护
- **可扩展性**: 使用相同的架构模式，易于扩展
- **团队熟悉度**: 开发团队已经熟悉这些模式

---

## 结论

**当前设计完全符合现有系统的架构和模式！** ✅

- 数据存储方式一致
- 字段类型选择合理
- API 设计模式一致
- 服务层架构一致
- 元数据管理方式一致

可以直接按照现有系统的模式实现，无需特殊处理。
