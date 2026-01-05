# Plugin Script Versioning System - Architecture & API Design

## Overview

A version management system for plugin scripts that allows:
- Dynamic script updates without plugin redeployment
- Multi-platform support (Amazon, Airbnb, Booking, Luma, etc.)
- Multi-client support (different client tags/endpoints)
- Version tracking and rollback capabilities
- External script upload (for development/testing)

---

## Core Concepts

### 1. Platform
The data source platform (e.g., `amazon`, `airbnb`, `booking`, `luma`)

### 2. Client Tag
The client/endpoint identifier (e.g., `chrome-extension`, `firefox-addon`, `desktop-app`, `mobile-app`)

### 3. Version
Script version number (semantic versioning: `major.minor.patch`, e.g., `1.0.0`)

### 4. Script Content
The actual JavaScript code that the plugin executes

---

## Database Schema Design

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
  isActive    Boolean  @default(true) // Whether this version is active
  isLatest    Boolean  @default(false) // Whether this is the latest version
  metadata    Json?    @default("{}") // Additional metadata (author, changelog, etc.)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdBy   String?  // Optional: who created this version

  @@unique([platform, clientTag, version])
  @@index([platform, clientTag, isLatest])
  @@index([platform, clientTag, isActive])
}
```

### Storage Architecture

**对象存储方案：**
- ✅ 脚本文件存储在对象存储（S3/OSS/本地文件系统）
- ✅ 数据库只存储文件路径/URL
- ✅ 支持 CDN 加速（可选）
- ✅ 支持版本管理和回滚

**文件路径规则：**
```
/plugin-scripts/{platform}/{clientTag}/{version}.js

示例：
/plugin-scripts/amazon/chrome-extension/1.0.0.js
/plugin-scripts/amazon/chrome-extension/1.1.0.js
/plugin-scripts/airbnb/chrome-extension/1.0.0.js
```

### Indexes
- `(platform, clientTag, version)` - Unique constraint
- `(platform, clientTag, isLatest)` - Fast lookup for latest version
- `(platform, clientTag, isActive)` - Fast lookup for active versions

---

## API Endpoints

### 1. Get Latest Script

**Endpoint:** `GET /api/plugin-scripts/latest`

**Query Parameters:**
- `platform` (required): Platform ID (`amazon`, `airbnb`, `booking`, `luma`)
- `clientTag` (required): Client tag (`chrome-extension`, `firefox-addon`, etc.)

**Response (200 OK):**
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
    "description": "Updated Amazon order extraction logic",
    "metadata": {
      "changelog": "Fixed order ID parsing issue",
      "author": "dev-team"
    },
    "updatedAt": "2025-12-15T10:00:00Z"
  }
}
```

**说明：**
- `scriptUrl`: 对象存储中的脚本文件 URL，插件可以直接下载
- `scriptSize`: 文件大小（字节），用于显示和验证
- `checksum`: SHA256 校验和，用于验证文件完整性

**Response (404 Not Found):**
```json
{
  "status": "error",
  "message": "No script found for platform 'amazon' and clientTag 'chrome-extension'"
}
```

---

### 2. Check Script Version

**Endpoint:** `GET /api/plugin-scripts/check-version`

**Query Parameters:**
- `platform` (required): Platform ID
- `clientTag` (required): Client tag
- `currentVersion` (required): Current version the plugin has

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "currentVersion": "1.1.0",
    "latestVersion": "1.2.0",
    "isUpToDate": false,
    "updateAvailable": true,
    "updateUrl": "/api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension"
  }
}
```

**If up to date:**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "currentVersion": "1.2.0",
    "latestVersion": "1.2.0",
    "isUpToDate": true,
    "updateAvailable": false
  }
}
```

---

### 3. Get Script by Version

**Endpoint:** `GET /api/plugin-scripts/version`

**Query Parameters:**
- `platform` (required): Platform ID
- `clientTag` (required): Client tag
- `version` (required): Specific version to retrieve

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.1.0",
    "scriptUrl": "https://storage.example.com/plugin-scripts/amazon/chrome-extension/1.1.0.js",
    "scriptSize": 8192,
    "checksum": "sha256:xyz789...",
    "description": "Initial Amazon script",
    "metadata": {
      "changelog": "First release"
    },
    "isActive": true,
    "isLatest": false,
    "createdAt": "2025-12-10T10:00:00Z",
    "updatedAt": "2025-12-10T10:00:00Z"
  }
}
```

---

### 4. List All Versions

**Endpoint:** `GET /api/plugin-scripts/versions`

**Query Parameters:**
- `platform` (required): Platform ID
- `clientTag` (required): Client tag
- `includeInactive` (optional, default: false): Include inactive versions

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "versions": [
      {
        "version": "1.2.0",
        "isLatest": true,
        "isActive": true,
        "description": "Updated Amazon order extraction logic",
        "createdAt": "2025-12-15T10:00:00Z"
      },
      {
        "version": "1.1.0",
        "isLatest": false,
        "isActive": true,
        "description": "Fixed order parsing",
        "createdAt": "2025-12-12T10:00:00Z"
      },
      {
        "version": "1.0.0",
        "isLatest": false,
        "isActive": true,
        "description": "Initial release",
        "createdAt": "2025-12-10T10:00:00Z"
      }
    ]
  }
}
```

---

### 5. Upload Script (External)

**Endpoint:** `POST /api/plugin-scripts/upload`

**Content-Type:** `multipart/form-data` 或 `application/json`

**Note:** Currently no authentication required (for development/testing)

**Request Format (multipart/form-data):**
```
platform: "amazon"
clientTag: "chrome-extension"
version: "1.3.0"
script: [File] // JavaScript file (.js)
description: "Optional description of changes"
metadata: { "changelog": "...", "author": "..." } (JSON string)
setAsLatest: true
setAsActive: true
```

**Request Format (application/json - 直接传脚本内容):**
```json
{
  "platform": "amazon",
  "clientTag": "chrome-extension",
  "version": "1.3.0",
  "script": "// Plugin script content\n(function() { ... })();",
  "description": "Optional description of changes",
  "metadata": {
    "changelog": "Added support for new Amazon order format",
    "author": "dev-team",
    "tested": true
  },
  "setAsLatest": true,
  "setAsActive": true
}
```

**处理流程：**
1. 接收脚本内容（文件或文本）
2. 上传到对象存储
3. 获取文件 URL
4. 计算文件大小和校验和
5. 保存元数据到数据库（包括 scriptUrl）

**Response (201 Created):**
```json
{
  "status": "success",
  "data": {
    "id": "script-uuid",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "scriptUrl": "https://storage.example.com/plugin-scripts/amazon/chrome-extension/1.3.0.js",
    "scriptSize": 15360,
    "checksum": "sha256:def456...",
    "isLatest": true,
    "isActive": true,
    "createdAt": "2025-12-16T10:00:00Z"
  }
}
```

**Response (400 Bad Request):**
```json
{
  "status": "error",
  "message": "Version already exists for this platform and clientTag"
}
```

---

### 6. Update Script Status

**Endpoint:** `PUT /api/plugin-scripts/:id/status`

**Path Parameters:**
- `id`: Script ID

**Request Body:**
```json
{
  "isActive": false,  // Optional: activate/deactivate
  "setAsLatest": true // Optional: set as latest version
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "script-uuid",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.2.0",
    "isLatest": true,
    "isActive": false,
    "updatedAt": "2025-12-16T10:00:00Z"
  }
}
```

---

### 7. List All Platforms and Client Tags

**Endpoint:** `GET /api/plugin-scripts/platforms`

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "platforms": [
      {
        "id": "amazon",
        "name": "Amazon",
        "clientTags": ["chrome-extension", "firefox-addon"],
        "latestVersions": {
          "chrome-extension": "1.2.0",
          "firefox-addon": "1.1.0"
        }
      },
      {
        "id": "airbnb",
        "name": "Airbnb",
        "clientTags": ["chrome-extension"],
        "latestVersions": {
          "chrome-extension": "1.0.0"
        }
      }
    ]
  }
}
```

---

## Business Logic Flow

### Plugin Activation Flow

```
1. Plugin starts/activates
   ↓
2. Plugin checks current version (stored locally)
   ↓
3. Plugin calls: GET /api/plugin-scripts/check-version
   Parameters: platform, clientTag, currentVersion
   ↓
4. Backend responds:
   - If isUpToDate: true → Plugin uses local script
   - If updateAvailable: true → Plugin downloads new script
   ↓
5. Plugin calls: GET /api/plugin-scripts/latest
   Parameters: platform, clientTag
   ↓
6. Backend returns scriptUrl (object storage URL)
   ↓
7. Plugin:
   - Downloads script from scriptUrl
   - Validates script (optional: checksum verification)
   - Saves script locally
   - Updates local version number
   - Executes script
```

### Script Update Flow

```
1. Developer uploads new script via POST /api/plugin-scripts/upload
   ↓
2. Backend:
   - Validates version format (semantic versioning)
   - Checks for duplicate version
   - Uploads script file to object storage
   - Gets file URL from object storage
   - Calculates file size and checksum
   - Stores metadata (scriptUrl, scriptSize, checksum) in database
   - If setAsLatest: true
     → Marks previous latest as isLatest: false
     → Marks new version as isLatest: true
   - If setAsActive: true
     → Sets isActive: true
   ↓
3. Next time plugin checks version:
   - Detects new version available
   - Gets scriptUrl from API
   - Downloads script from object storage
   - Updates automatically
```

### Version Management

**Latest Version Logic:**
- Only ONE version per (platform, clientTag) can be `isLatest: true`
- When setting a new version as latest:
  1. Find current latest version
  2. Set `isLatest: false` on current latest
  3. Set `isLatest: true` on new version

**Active Version Logic:**
- Multiple versions can be `isActive: true` (for rollback capability)
- When deactivating a version:
  - Set `isActive: false`
  - If it was the latest, find the most recent active version and set as latest

**Version Rollback:**
- Admin can set any active version as latest
- Plugin will automatically download the new "latest" version

---

## Data Flow Diagram

```
┌─────────────┐
│   Plugin    │
│  (Client)   │
└──────┬──────┘
       │
       │ 1. Check Version
       ├─────────────────┐
       │                 │
       │ 2. Get Latest   │
       │    (if needed)  │
       │                 │
       ▼                 ▼
┌─────────────────────────────┐
│      Backend API            │
│  /api/plugin-scripts/*      │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│    PluginScript Service     │
│  - Version checking         │
│  - Script retrieval         │
│  - Version management       │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│      Database               │
│  PluginScript Table         │
└─────────────────────────────┘
```

---

## Implementation Considerations

### 1. Version Format
- Use semantic versioning: `major.minor.patch`
- Examples: `1.0.0`, `1.1.0`, `2.0.0`
- Validation: Regex pattern `^\d+\.\d+\.\d+$`

### 2. Script Validation
- Optional: JavaScript syntax validation
- Optional: Size limits (e.g., max 1MB)
- Optional: Checksum generation (SHA256) for integrity

### 3. Performance
- Cache latest versions in memory (Redis optional)
- Index on (platform, clientTag, isLatest) for fast queries
- Consider CDN for script delivery (future enhancement)

### 4. Security (Future)
- Add authentication for upload endpoint
- Rate limiting on upload endpoint
- Script sanitization/validation
- Content Security Policy headers

### 5. Monitoring
- Track script download counts
- Track version adoption rates
- Log script errors (if plugin reports back)

---

## Example Use Cases

### Use Case 1: Plugin First Activation

```
1. Plugin installed, no local version
2. Plugin calls: GET /api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension
3. Backend returns: version 1.2.0, script content
4. Plugin saves locally and executes
```

### Use Case 2: Plugin Update Check

```
1. Plugin has version 1.1.0 locally
2. Plugin calls: GET /api/plugin-scripts/check-version?platform=amazon&clientTag=chrome-extension&currentVersion=1.1.0
3. Backend responds: updateAvailable=true, latestVersion=1.2.0
4. Plugin downloads new script
5. Plugin updates local version to 1.2.0
```

### Use Case 3: Developer Uploads New Script

```
1. Developer calls: POST /api/plugin-scripts/upload
   Body: { platform: "amazon", clientTag: "chrome-extension", version: "1.3.0", script: "...", setAsLatest: true }
2. Backend:
   - Validates version format
   - Checks for duplicates
   - Stores script
   - Sets previous latest (1.2.0) to isLatest: false
   - Sets new version (1.3.0) to isLatest: true
3. Next plugin check will detect 1.3.0 as latest
```

### Use Case 4: Rollback to Previous Version

```
1. Admin calls: PUT /api/plugin-scripts/:id/status
   Body: { setAsLatest: true }
   Where id is version 1.1.0
2. Backend:
   - Sets current latest (1.3.0) to isLatest: false
   - Sets 1.1.0 to isLatest: true
3. Next plugin check will download 1.1.0
```

---

## Database Migration

```sql
CREATE TABLE "PluginScript" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "platform" TEXT NOT NULL,
  "clientTag" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "scriptUrl" TEXT NOT NULL,
  "scriptSize" INTEGER,
  "checksum" TEXT,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isLatest" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT,
  
  CONSTRAINT "PluginScript_platform_clientTag_version_key" UNIQUE ("platform", "clientTag", "version")
);

CREATE INDEX "PluginScript_platform_clientTag_isLatest_idx" ON "PluginScript"("platform", "clientTag", "isLatest");
CREATE INDEX "PluginScript_platform_clientTag_isActive_idx" ON "PluginScript"("platform", "clientTag", "isActive");
```

## Object Storage Configuration

### Storage Options

**方案 1: 本地文件系统（开发/简单部署）**
```
存储路径: public/plugin-scripts/{platform}/{clientTag}/{version}.js
访问 URL: http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.0.0.js
```

**方案 2: 对象存储服务（生产环境推荐）**
- **AWS S3**: `s3://bucket-name/plugin-scripts/{platform}/{clientTag}/{version}.js`
- **阿里云 OSS**: `https://bucket.oss-cn-hangzhou.aliyuncs.com/plugin-scripts/...`
- **腾讯云 COS**: `https://bucket.cos.ap-shanghai.myqcloud.com/plugin-scripts/...`
- **MinIO**: `http://minio-server/bucket/plugin-scripts/...`

### 文件路径规则

```
/plugin-scripts/{platform}/{clientTag}/{version}.js

示例：
/plugin-scripts/amazon/chrome-extension/1.0.0.js
/plugin-scripts/amazon/chrome-extension/1.1.0.js
/plugin-scripts/airbnb/chrome-extension/1.0.0.js
/plugin-scripts/booking/android-app/1.0.0.js
```

### 环境变量配置

```bash
# 对象存储配置
STORAGE_TYPE="local"  # 'local' | 's3' | 'oss' | 'cos' | 'minio'

# 本地存储（如果使用）
STORAGE_BASE_PATH="/public/plugin-scripts"

# S3 配置（如果使用）
AWS_S3_BUCKET="your-bucket-name"
AWS_S3_REGION="us-east-1"
AWS_ACCESS_KEY_ID="your-access-key"
AWS_SECRET_ACCESS_KEY="your-secret-key"
AWS_S3_ENDPOINT="https://s3.amazonaws.com"  # 可选，用于兼容 S3 的服务

# OSS 配置（如果使用）
OSS_BUCKET="your-bucket-name"
OSS_REGION="cn-hangzhou"
OSS_ACCESS_KEY_ID="your-access-key"
OSS_ACCESS_KEY_SECRET="your-secret-key"
OSS_ENDPOINT="https://oss-cn-hangzhou.aliyuncs.com"
```

---

## API Summary Table

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/plugin-scripts/latest` | Get latest script | No |
| GET | `/api/plugin-scripts/check-version` | Check if update available | No |
| GET | `/api/plugin-scripts/version` | Get specific version | No |
| GET | `/api/plugin-scripts/versions` | List all versions | No |
| GET | `/api/plugin-scripts/platforms` | List platforms and client tags | No |
| POST | `/api/plugin-scripts/upload` | Upload new script | No (for now) |
| PUT | `/api/plugin-scripts/:id/status` | Update script status | No (for now) |

---

## Next Steps

1. ✅ Create database migration
2. ✅ Implement Prisma schema
3. ✅ Create service layer (`pluginScriptService.js`)
4. ✅ Create controller (`pluginScriptController.js`)
5. ✅ Create routes (`pluginScriptRoutes.js`)
6. ✅ Add validation middleware
7. ✅ Add error handling
8. ✅ Add logging
9. ✅ Write tests
10. ⚠️ Add authentication (future)
11. ⚠️ Add rate limiting (future)
12. ⚠️ Add script validation (future)

---

## Notes

- **No authentication for now**: As requested, upload endpoint is open (for development/testing)
- **Version format**: Strict semantic versioning (major.minor.patch)
- **Latest version**: Only one latest per (platform, clientTag) combination
- **Active versions**: Multiple active versions allowed (for rollback)
- **Script size**: Consider adding size limits in future
- **CDN**: Consider CDN for script delivery if traffic is high
