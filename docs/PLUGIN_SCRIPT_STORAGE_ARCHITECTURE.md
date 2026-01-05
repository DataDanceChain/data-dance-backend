# Plugin Script Storage Architecture - Object Storage Design

## 概述

插件脚本使用**对象存储**方案：脚本文件存储在对象存储服务中，数据库只存储文件路径/URL 和元数据。

---

## 架构设计

### 数据流

```
┌─────────────┐
│   Developer │
│  (Upload)   │
└──────┬──────┘
       │
       │ 1. POST /api/plugin-scripts/upload
       │    (script file/content)
       │
       ▼
┌─────────────────────────────┐
│      Backend API            │
│  - Validates version        │
│  - Uploads to storage       │
│  - Calculates checksum      │
└──────┬──────────────────────┘
       │
       │ 2. Upload to Object Storage
       │
       ▼
┌─────────────────────────────┐
│   Object Storage            │
│  (S3/OSS/COS/Local)         │
│                             │
│  /plugin-scripts/           │
│    amazon/                   │
│      chrome-extension/      │
│        1.0.0.js             │
│        1.1.0.js             │
│        1.2.0.js             │
└──────┬──────────────────────┘
       │
       │ 3. Get file URL
       │
       ▼
┌─────────────────────────────┐
│      Database               │
│  PluginScript Table         │
│                             │
│  - scriptUrl: "https://..." │
│  - scriptSize: 10240        │
│  - checksum: "sha256:..."   │
│  - metadata: {...}          │
└─────────────────────────────┘
       │
       │ 4. Plugin requests latest
       │
       ▼
┌─────────────────────────────┐
│      Plugin                 │
│  - Gets scriptUrl from API  │
│  - Downloads from storage   │
│  - Validates checksum       │
│  - Executes script          │
└─────────────────────────────┘
```

---

## 数据库 Schema

### PluginScript Model

```prisma
model PluginScript {
  id          String   @id @default(uuid())
  platform    String   // 'amazon', 'airbnb', 'booking', 'luma'
  clientTag   String   // 'chrome-extension', 'firefox-addon', etc.
  version     String   // Semantic version: '1.0.0', '1.1.0', etc.
  scriptUrl   String   // Object storage URL/path to the script file
  scriptSize  Int?     // Script file size in bytes (optional)
  checksum    String?  // SHA256 checksum for integrity verification (optional)
  description String?  // Optional description of changes
  isActive    Boolean  @default(true)
  isLatest    Boolean  @default(false)
  metadata    Json?    @default("{}")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdBy   String?

  @@unique([platform, clientTag, version])
  @@index([platform, clientTag, isLatest])
  @@index([platform, clientTag, isActive])
}
```

**关键字段说明：**
- `scriptUrl`: 对象存储中的文件 URL（完整路径）
- `scriptSize`: 文件大小（字节），用于验证和显示
- `checksum`: SHA256 校验和，用于验证文件完整性

---

## 对象存储配置

### 支持的存储类型

#### 1. 本地文件系统（开发/简单部署）

**配置：**
```bash
STORAGE_TYPE="local"
STORAGE_BASE_PATH="/public/plugin-scripts"
```

**文件路径：**
```
public/plugin-scripts/{platform}/{clientTag}/{version}.js
```

**访问 URL：**
```
http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.0.0.js
```

**优点：**
- ✅ 简单，无需额外服务
- ✅ 适合开发和测试
- ✅ 可以直接通过静态文件服务提供

**缺点：**
- ❌ 不适合大规模部署
- ❌ 不支持 CDN 加速
- ❌ 文件管理复杂

---

#### 2. AWS S3（生产环境推荐）

**配置：**
```bash
STORAGE_TYPE="s3"
AWS_S3_BUCKET="your-bucket-name"
AWS_S3_REGION="us-east-1"
AWS_ACCESS_KEY_ID="your-access-key"
AWS_SECRET_ACCESS_KEY="your-secret-key"
AWS_S3_ENDPOINT="https://s3.amazonaws.com"  # 可选
```

**文件路径：**
```
s3://bucket-name/plugin-scripts/{platform}/{clientTag}/{version}.js
```

**访问 URL：**
```
https://bucket-name.s3.us-east-1.amazonaws.com/plugin-scripts/amazon/chrome-extension/1.0.0.js
```

**优点：**
- ✅ 高可用性和可扩展性
- ✅ 支持 CDN（CloudFront）
- ✅ 支持版本控制
- ✅ 全球部署

---

#### 3. 阿里云 OSS

**配置：**
```bash
STORAGE_TYPE="oss"
OSS_BUCKET="your-bucket-name"
OSS_REGION="cn-hangzhou"
OSS_ACCESS_KEY_ID="your-access-key"
OSS_ACCESS_KEY_SECRET="your-secret-key"
OSS_ENDPOINT="https://oss-cn-hangzhou.aliyuncs.com"
```

**文件路径：**
```
oss://bucket-name/plugin-scripts/{platform}/{clientTag}/{version}.js
```

**访问 URL：**
```
https://bucket-name.oss-cn-hangzhou.aliyuncs.com/plugin-scripts/amazon/chrome-extension/1.0.0.js
```

---

#### 4. 腾讯云 COS

**配置：**
```bash
STORAGE_TYPE="cos"
COS_BUCKET="your-bucket-name"
COS_REGION="ap-shanghai"
COS_SECRET_ID="your-secret-id"
COS_SECRET_KEY="your-secret-key"
COS_ENDPOINT="https://cos.ap-shanghai.myqcloud.com"
```

---

#### 5. MinIO（自建对象存储）

**配置：**
```bash
STORAGE_TYPE="minio"
MINIO_ENDPOINT="http://minio-server:9000"
MINIO_BUCKET="plugin-scripts"
MINIO_ACCESS_KEY="your-access-key"
MINIO_SECRET_KEY="your-secret-key"
MINIO_USE_SSL=false
```

---

## 文件路径规则

### 统一路径格式

```
/plugin-scripts/{platform}/{clientTag}/{version}.js
```

### 示例

```
/plugin-scripts/amazon/chrome-extension/1.0.0.js
/plugin-scripts/amazon/chrome-extension/1.1.0.js
/plugin-scripts/amazon/chrome-extension/1.2.0.js
/plugin-scripts/amazon/firefox-addon/1.0.0.js
/plugin-scripts/airbnb/chrome-extension/1.0.0.js
/plugin-scripts/booking/android-app/1.0.0.js
```

### 路径生成逻辑

```javascript
function generateScriptPath(platform, clientTag, version) {
  return `/plugin-scripts/${platform}/${clientTag}/${version}.js`;
}

// 示例
generateScriptPath('amazon', 'chrome-extension', '1.2.0')
// 返回: "/plugin-scripts/amazon/chrome-extension/1.2.0.js"
```

---

## 上传流程

### 完整上传流程

```
1. 开发者上传脚本
   ↓
2. 后端验证版本格式
   ↓
3. 检查版本是否已存在
   ↓
4. 生成文件路径
   path = /plugin-scripts/{platform}/{clientTag}/{version}.js
   ↓
5. 上传到对象存储
   - 如果是文件：直接上传
   - 如果是文本：先写入临时文件，再上传
   ↓
6. 获取文件 URL
   url = https://storage.example.com/plugin-scripts/...
   ↓
7. 计算文件大小和校验和
   size = file.size
   checksum = sha256(file.content)
   ↓
8. 保存到数据库
   - scriptUrl: url
   - scriptSize: size
   - checksum: checksum
   - 其他元数据
   ↓
9. 如果 setAsLatest: true
   - 取消之前的 latest
   - 设置新版本为 latest
   ↓
10. 返回结果
```

---

## API 更新

### 获取最新脚本

**响应格式：**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.2.0",
    "scriptUrl": "https://storage.example.com/plugin-scripts/amazon/chrome-extension/1.2.0.js",
    "scriptSize": 10240,
    "checksum": "sha256:abc123...",
    "metadata": { ... }
  }
}
```

**插件端使用：**
```javascript
// 1. 获取脚本 URL
const response = await fetch('/api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension');
const { data } = await response.json();

// 2. 从对象存储下载脚本
const scriptResponse = await fetch(data.scriptUrl);
const scriptContent = await scriptResponse.text();

// 3. 验证校验和（可选）
if (data.checksum) {
  const calculatedChecksum = await calculateSHA256(scriptContent);
  if (calculatedChecksum !== data.checksum) {
    throw new Error('Script integrity check failed');
  }
}

// 4. 执行脚本
executeScript(scriptContent);
```

---

## 上传接口

### 方式 1: multipart/form-data（推荐）

```bash
curl -X POST /api/plugin-scripts/upload \
  -F "platform=amazon" \
  -F "clientTag=chrome-extension" \
  -F "version=1.3.0" \
  -F "script=@script.js" \
  -F "description=Added new features" \
  -F "setAsLatest=true"
```

### 方式 2: application/json

```bash
curl -X POST /api/plugin-scripts/upload \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "script": "(function() { ... })();",
    "setAsLatest": true
  }'
```

**后端处理：**
- 如果是 JSON，脚本内容会先写入临时文件
- 然后上传到对象存储
- 最后删除临时文件

---

## 实现考虑

### 1. 存储服务抽象层

```javascript
// storageService.js
class StorageService {
  async uploadFile(filePath, content) {
    // 根据 STORAGE_TYPE 选择实现
    switch (process.env.STORAGE_TYPE) {
      case 's3':
        return await this.uploadToS3(filePath, content);
      case 'oss':
        return await this.uploadToOSS(filePath, content);
      case 'local':
        return await this.uploadToLocal(filePath, content);
      default:
        throw new Error('Unsupported storage type');
    }
  }
  
  getFileUrl(filePath) {
    // 根据存储类型生成 URL
  }
}
```

### 2. 文件大小限制

- **建议限制**: 1MB - 5MB
- **验证**: 上传时检查文件大小
- **错误**: 超过限制返回 400 错误

### 3. 文件类型验证

- **允许**: `.js` 文件
- **验证**: 检查文件扩展名和 MIME 类型
- **错误**: 不支持的类型返回 400 错误

### 4. 校验和计算

```javascript
const crypto = require('crypto');

function calculateChecksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

### 5. 错误处理

- **上传失败**: 回滚数据库操作
- **文件不存在**: 返回 404
- **存储服务错误**: 返回 500，记录日志

---

## 优势

### ✅ 对象存储方案的优势

1. **可扩展性**
   - 支持大量文件
   - 不受数据库大小限制
   - 支持 CDN 加速

2. **性能**
   - 文件直接通过 CDN 分发
   - 减少数据库负载
   - 支持缓存

3. **成本**
   - 对象存储通常比数据库存储便宜
   - 按使用量付费
   - 支持生命周期管理

4. **灵活性**
   - 支持多种存储服务
   - 易于切换存储提供商
   - 支持版本控制（S3）

5. **安全性**
   - 支持访问控制
   - 支持签名 URL（临时访问）
   - 支持加密存储

---

## 静态文件服务（本地存储）

如果使用本地文件系统，需要配置静态文件服务：

```javascript
// src/app.js
app.use('/plugin-scripts', express.static(path.join(__dirname, '../public/plugin-scripts'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.set('Content-Type', 'application/javascript');
      res.set('Cache-Control', 'public, max-age=3600'); // 1小时缓存
    }
  }
}));
```

---

## 环境变量配置示例

```bash
# .env

# 存储类型: local | s3 | oss | cos | minio
STORAGE_TYPE="local"

# 本地存储配置
STORAGE_BASE_PATH="/public/plugin-scripts"
STORAGE_BASE_URL="http://localhost:8080"

# S3 配置（如果使用）
AWS_S3_BUCKET="your-bucket"
AWS_S3_REGION="us-east-1"
AWS_ACCESS_KEY_ID="your-key"
AWS_SECRET_ACCESS_KEY="your-secret"

# OSS 配置（如果使用）
OSS_BUCKET="your-bucket"
OSS_REGION="cn-hangzhou"
OSS_ACCESS_KEY_ID="your-key"
OSS_ACCESS_KEY_SECRET="your-secret"
OSS_ENDPOINT="https://oss-cn-hangzhou.aliyuncs.com"
```

---

## 总结

### 设计要点

1. ✅ **脚本存储在对象存储**，数据库只存储 URL
2. ✅ **支持多种存储服务**（S3、OSS、COS、本地）
3. ✅ **统一的文件路径规则**
4. ✅ **支持校验和验证**
5. ✅ **支持文件大小和类型验证**

### 实现步骤

1. 创建存储服务抽象层
2. 实现不同存储服务的适配器
3. 更新上传接口支持文件上传
4. 更新 API 返回 scriptUrl 而不是 script 内容
5. 配置静态文件服务（如果使用本地存储）
