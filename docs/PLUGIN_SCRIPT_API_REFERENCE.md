# Plugin Script Versioning - Complete API Reference

## 概述

本文档提供插件脚本版本管理系统的完整 API 参考，包括请求格式、响应格式、错误处理和示例。

---

## 基础信息

### Base URL

```
开发环境: http://localhost:8080
生产环境: https://api.datadance.ai
```

### 响应格式

所有 API 响应遵循统一格式：

**成功响应:**
```json
{
  "status": "success",
  "data": { ... }
}
```

**错误响应:**
```json
{
  "status": "error",
  "message": "Error description"
}
```

---

## API 端点详细说明

### 1. 检查版本更新（插件端使用）

**Endpoint:** `GET /api/plugin-scripts/check-version`

**用途:** 插件激活时检查是否有新版本可用

**Query Parameters:**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `platform` | string | ✅ | 平台 ID | `amazon`, `airbnb`, `booking`, `luma` |
| `clientTag` | string | ✅ | 客户端标识 | `chrome-extension`, `firefox-addon`, `ios-app`, `android-app`, `web-app` |
| `currentVersion` | string | ✅ | 插件当前版本号 | `1.0.0`, `1.1.0` |

**请求示例:**

```bash
GET /api/plugin-scripts/check-version?platform=amazon&clientTag=chrome-extension&currentVersion=1.1.0
```

**响应 - 有更新可用 (200 OK):**

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
    "updateUrl": "/api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension",
    "versionDiff": {
      "major": 0,
      "minor": 1,
      "patch": 0
    }
  }
}
```

**响应 - 已是最新版本 (200 OK):**

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

**响应 - 版本不存在 (404 Not Found):**

```json
{
  "status": "error",
  "message": "No script found for platform 'amazon' and clientTag 'chrome-extension'"
}
```

**响应 - 参数错误 (400 Bad Request):**

```json
{
  "status": "error",
  "message": "Missing required parameter: platform"
}
```

**插件端使用示例:**

```javascript
async function checkForUpdates() {
  const platform = 'amazon';
  const clientTag = 'chrome-extension';
  const currentVersion = localStorage.getItem('pluginVersion') || '0.0.0';
  
  try {
    const response = await fetch(
      `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=${currentVersion}`
    );
    const result = await response.json();
    
    if (result.status === 'success' && result.data.updateAvailable) {
      console.log(`Update available: ${result.data.latestVersion}`);
      // 下载新版本
      await downloadLatestScript(platform, clientTag);
    } else {
      console.log('Plugin is up to date');
    }
  } catch (error) {
    console.error('Failed to check version:', error);
    // 使用本地缓存的脚本
  }
}
```

---

### 2. 获取最新脚本（插件端使用）

**Endpoint:** `GET /api/plugin-scripts/latest`

**用途:** 获取指定平台和客户端的最新脚本内容

**Query Parameters:**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `platform` | string | ✅ | 平台 ID | `amazon`, `airbnb`, `booking`, `luma` |
| `clientTag` | string | ✅ | 客户端标识 | `chrome-extension`, `firefox-addon`, `ios-app`, `android-app`, `web-app` |

**请求示例:**

```bash
GET /api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension
```

**响应 - 成功 (200 OK):**

```json
{
  "status": "success",
  "data": {
    "id": "script-uuid-123",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.2.0",
    "script": "(function() {\n  // Amazon order extraction script\n  console.log('Amazon plugin v1.2.0');\n  // ... script content ...\n})();",
    "description": "Updated Amazon order extraction logic",
    "metadata": {
      "changelog": "Fixed order ID parsing issue, added support for new order format",
      "author": "dev-team",
      "tested": true,
      "minBrowserVersion": "100"
    },
    "isActive": true,
    "isLatest": true,
    "checksum": "sha256:abc123def456...",
    "createdAt": "2025-12-15T10:00:00.000Z",
    "updatedAt": "2025-12-15T10:00:00.000Z"
  }
}
```

**响应 - 未找到 (404 Not Found):**

```json
{
  "status": "error",
  "message": "No latest script found for platform 'amazon' and clientTag 'chrome-extension'"
}
```

**插件端使用示例:**

```javascript
async function downloadLatestScript(platform, clientTag) {
  try {
    const response = await fetch(
      `/api/plugin-scripts/latest?platform=${platform}&clientTag=${clientTag}`
    );
    const result = await response.json();
    
    if (result.status === 'success') {
      const { script, version, checksum } = result.data;
      
      // 可选: 验证脚本完整性
      if (checksum) {
        const calculatedChecksum = await calculateSHA256(script);
        if (calculatedChecksum !== checksum) {
          throw new Error('Script integrity check failed');
        }
      }
      
      // 保存脚本和版本
      localStorage.setItem('pluginScript', script);
      localStorage.setItem('pluginVersion', version);
      
      // 执行脚本
      executeScript(script);
      
      console.log(`Plugin updated to version ${version}`);
    }
  } catch (error) {
    console.error('Failed to download script:', error);
    // 使用本地缓存的脚本
    const cachedScript = localStorage.getItem('pluginScript');
    if (cachedScript) {
      executeScript(cachedScript);
    }
  }
}

function executeScript(scriptContent) {
  try {
    // 方式1: 创建 script 标签
    const script = document.createElement('script');
    script.textContent = scriptContent;
    document.head.appendChild(script);
    
    // 方式2: 使用 Function 构造函数
    // const scriptFunction = new Function(scriptContent);
    // scriptFunction();
  } catch (error) {
    console.error('Script execution error:', error);
  }
}
```

---

### 3. 上传新脚本（开发者使用）

**Endpoint:** `POST /api/plugin-scripts/upload`

**用途:** 上传新版本的插件脚本

**认证:** 当前无需认证（开发阶段）

**Content-Type:** `application/json`

**Request Body:**

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `platform` | string | ✅ | 平台 ID | `amazon`, `airbnb`, `booking`, `luma` |
| `clientTag` | string | ✅ | 客户端标识 | `chrome-extension`, `firefox-addon`, `ios-app`, `android-app`, `web-app` |
| `version` | string | ✅ | 版本号（语义化版本） | `1.0.0`, `1.1.0`, `2.0.0` |
| `script` | string | ✅ | JavaScript 脚本内容 | `"(function() { ... })();"` |
| `description` | string | ❌ | 版本描述 | `"Fixed order parsing bug"` |
| `metadata` | object | ❌ | 元数据 | `{ "changelog": "...", "author": "..." }` |
| `setAsLatest` | boolean | ❌ | 是否设置为最新版本（默认: false） | `true`, `false` |
| `setAsActive` | boolean | ❌ | 是否激活此版本（默认: true） | `true`, `false` |
| `createdBy` | string | ❌ | 创建者标识 | `"dev-team"`, `"admin"` |

**请求示例:**

```bash
curl -X POST http://localhost:8080/api/plugin-scripts/upload \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "script": "(function() {\n  console.log(\"Amazon plugin v1.3.0\");\n  // Order extraction logic\n  function extractOrders() {\n    // ... implementation ...\n  }\n  extractOrders();\n})();",
    "description": "Added support for new Amazon order format",
    "metadata": {
      "changelog": "1. Fixed order ID parsing\n2. Added support for multi-item orders\n3. Improved error handling",
      "author": "dev-team",
      "tested": true,
      "minBrowserVersion": "100",
      "breakingChanges": false
    },
    "setAsLatest": true,
    "setAsActive": true,
    "createdBy": "dev-team"
  }'
```

**响应 - 成功创建 (201 Created):**

```json
{
  "status": "success",
  "data": {
    "id": "script-uuid-456",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "isLatest": true,
    "isActive": true,
    "description": "Added support for new Amazon order format",
    "createdAt": "2025-12-16T10:00:00.000Z",
    "updatedAt": "2025-12-16T10:00:00.000Z",
    "previousLatestVersion": "1.2.0"
  }
}
```

**响应 - 版本已存在 (400 Bad Request):**

```json
{
  "status": "error",
  "message": "Version '1.3.0' already exists for platform 'amazon' and clientTag 'chrome-extension'"
}
```

**响应 - 版本格式错误 (400 Bad Request):**

```json
{
  "status": "error",
  "message": "Invalid version format. Must follow semantic versioning (major.minor.patch, e.g., 1.0.0)"
}
```

**响应 - 缺少必填字段 (400 Bad Request):**

```json
{
  "status": "error",
  "message": "Missing required field: script"
}
```

**响应 - 脚本过大 (400 Bad Request):**

```json
{
  "status": "error",
  "message": "Script size exceeds maximum limit of 1MB"
}
```

**开发者使用示例:**

```javascript
async function uploadScript(scriptData) {
  const response = await fetch('/api/plugin-scripts/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      platform: 'amazon',
      clientTag: 'chrome-extension',
      version: '1.3.0',
      script: scriptData.content,
      description: 'Added new features',
      metadata: {
        changelog: '1. Feature A\n2. Feature B',
        author: 'dev-team'
      },
      setAsLatest: true,
      setAsActive: true
    })
  });
  
  const result = await response.json();
  
  if (result.status === 'success') {
    console.log(`Script uploaded successfully: ${result.data.version}`);
    console.log(`Previous latest: ${result.data.previousLatestVersion}`);
  } else {
    console.error('Upload failed:', result.message);
  }
}
```

---

### 4. 获取指定版本

**Endpoint:** `GET /api/plugin-scripts/version`

**用途:** 获取指定版本的脚本（用于回滚或查看历史版本）

**Query Parameters:**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `platform` | string | ✅ | 平台 ID | `amazon` |
| `clientTag` | string | ✅ | 客户端标识 | `chrome-extension` |
| `version` | string | ✅ | 版本号 | `1.1.0` |

**请求示例:**

```bash
GET /api/plugin-scripts/version?platform=amazon&clientTag=chrome-extension&version=1.1.0
```

**响应 - 成功 (200 OK):**

```json
{
  "status": "success",
  "data": {
    "id": "script-uuid-789",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.1.0",
    "script": "(function() { ... })();",
    "description": "Fixed order parsing",
    "metadata": {
      "changelog": "Fixed bug in order ID extraction",
      "author": "dev-team"
    },
    "isActive": true,
    "isLatest": false,
    "createdAt": "2025-12-12T10:00:00.000Z",
    "updatedAt": "2025-12-12T10:00:00.000Z"
  }
}
```

---

### 5. 列出所有版本

**Endpoint:** `GET /api/plugin-scripts/versions`

**用途:** 获取指定平台和客户端的所有版本列表

**Query Parameters:**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `platform` | string | ✅ | 平台 ID | `amazon` |
| `clientTag` | string | ✅ | 客户端标识 | `chrome-extension` |
| `includeInactive` | boolean | ❌ | 是否包含非活跃版本（默认: false） | `true`, `false` |

**请求示例:**

```bash
GET /api/plugin-scripts/versions?platform=amazon&clientTag=chrome-extension&includeInactive=false
```

**响应 - 成功 (200 OK):**

```json
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "totalVersions": 3,
    "latestVersion": "1.2.0",
    "versions": [
      {
        "id": "script-uuid-1",
        "version": "1.2.0",
        "isLatest": true,
        "isActive": true,
        "description": "Updated Amazon order extraction logic",
        "createdAt": "2025-12-15T10:00:00.000Z",
        "updatedAt": "2025-12-15T10:00:00.000Z"
      },
      {
        "id": "script-uuid-2",
        "version": "1.1.0",
        "isLatest": false,
        "isActive": true,
        "description": "Fixed order parsing",
        "createdAt": "2025-12-12T10:00:00.000Z",
        "updatedAt": "2025-12-12T10:00:00.000Z"
      },
      {
        "id": "script-uuid-3",
        "version": "1.0.0",
        "isLatest": false,
        "isActive": true,
        "description": "Initial release",
        "createdAt": "2025-12-10T10:00:00.000Z",
        "updatedAt": "2025-12-10T10:00:00.000Z"
      }
    ]
  }
}
```

---

### 6. 更新版本状态

**Endpoint:** `PUT /api/plugin-scripts/:id/status`

**用途:** 更新脚本版本的状态（激活/停用、设置最新版本）

**Path Parameters:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 脚本 ID |

**Request Body:**

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `isActive` | boolean | ❌ | 是否激活此版本 | `true`, `false` |
| `setAsLatest` | boolean | ❌ | 是否设置为最新版本 | `true`, `false` |

**请求示例:**

```bash
curl -X PUT http://localhost:8080/api/plugin-scripts/script-uuid-2/status \
  -H "Content-Type: application/json" \
  -d '{
    "setAsLatest": true,
    "isActive": true
  }'
```

**响应 - 成功 (200 OK):**

```json
{
  "status": "success",
  "data": {
    "id": "script-uuid-2",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.1.0",
    "isLatest": true,
    "isActive": true,
    "previousLatestVersion": "1.2.0",
    "updatedAt": "2025-12-16T10:00:00.000Z"
  }
}
```

---

### 7. 列出所有平台和客户端

**Endpoint:** `GET /api/plugin-scripts/platforms`

**用途:** 获取所有可用的平台和客户端组合及其最新版本

**请求示例:**

```bash
GET /api/plugin-scripts/platforms
```

**响应 - 成功 (200 OK):**

```json
{
  "status": "success",
  "data": {
    "platforms": [
      {
        "id": "amazon",
        "name": "Amazon",
        "clientTags": [
          {
            "tag": "chrome-extension",
            "name": "Chrome Extension",
            "latestVersion": "1.2.0",
            "totalVersions": 3,
            "activeVersions": 3
          },
          {
            "tag": "firefox-addon",
            "name": "Firefox Addon",
            "latestVersion": "1.1.0",
            "totalVersions": 2,
            "activeVersions": 2
          },
          {
            "tag": "ios-app",
            "name": "iOS App",
            "latestVersion": "1.0.0",
            "totalVersions": 1,
            "activeVersions": 1
          }
        ]
      },
      {
        "id": "airbnb",
        "name": "Airbnb",
        "clientTags": [
          {
            "tag": "chrome-extension",
            "name": "Chrome Extension",
            "latestVersion": "1.0.0",
            "totalVersions": 1,
            "activeVersions": 1
          }
        ]
      },
      {
        "id": "booking",
        "name": "Booking.com",
        "clientTags": [
          {
            "tag": "chrome-extension",
            "name": "Chrome Extension",
            "latestVersion": "1.1.0",
            "totalVersions": 2,
            "activeVersions": 2
          },
          {
            "tag": "android-app",
            "name": "Android App",
            "latestVersion": "1.0.0",
            "totalVersions": 1,
            "activeVersions": 1
          }
        ]
      }
    ]
  }
}
```

---

## 数据验证规则

### 版本号格式

- **格式**: 语义化版本 (Semantic Versioning)
- **规则**: `major.minor.patch`
- **示例**: `1.0.0`, `1.1.0`, `2.0.0`
- **正则表达式**: `^\d+\.\d+\.\d+$`
- **验证**: 
  - major, minor, patch 必须是非负整数
  - 不能有前导零（如 `01.0.0` 无效）

### 平台 ID

- **允许值**: `amazon`, `airbnb`, `booking`, `luma`
- **验证**: 必须是指定的平台之一

### 客户端标识 (clientTag)

- **常见值**: 
  - `chrome-extension`
  - `firefox-addon`
  - `ios-app`
  - `android-app`
  - `web-app`
  - `desktop-app`
- **验证**: 字符串，建议使用小写字母和连字符

### 脚本内容

- **类型**: 字符串（JavaScript 代码）
- **大小限制**: 建议最大 1MB（可在实现时配置）
- **验证**: 
  - 不能为空
  - 必须是有效的字符串

---

## 错误码说明

| HTTP 状态码 | 错误类型 | 说明 | 示例 |
|------------|---------|------|------|
| 200 | Success | 请求成功 | 正常响应 |
| 201 | Created | 资源创建成功 | 上传脚本成功 |
| 400 | Bad Request | 请求参数错误 | 版本格式错误、缺少必填字段 |
| 404 | Not Found | 资源不存在 | 版本不存在、平台/客户端不存在 |
| 409 | Conflict | 资源冲突 | 版本已存在 |
| 500 | Internal Server Error | 服务器错误 | 数据库错误、系统错误 |

---

## 完整使用流程示例

### 场景：插件首次安装和更新

```javascript
// 1. 插件首次安装
async function initializePlugin() {
  const platform = 'amazon';
  const clientTag = 'chrome-extension';
  
  // 检查版本（首次安装，currentVersion 为 null 或 '0.0.0'）
  const checkResponse = await fetch(
    `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=0.0.0`
  );
  const checkResult = await checkResponse.json();
  
  if (checkResult.data.updateAvailable) {
    // 下载最新脚本
    const scriptResponse = await fetch(
      `/api/plugin-scripts/latest?platform=${platform}&clientTag=${clientTag}`
    );
    const scriptResult = await scriptResponse.json();
    
    // 保存并执行
    localStorage.setItem('pluginScript', scriptResult.data.script);
    localStorage.setItem('pluginVersion', scriptResult.data.version);
    executeScript(scriptResult.data.script);
  }
}

// 2. 插件定期检查更新
async function checkAndUpdate() {
  const platform = 'amazon';
  const clientTag = 'chrome-extension';
  const currentVersion = localStorage.getItem('pluginVersion') || '0.0.0';
  
  try {
    const response = await fetch(
      `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=${currentVersion}`
    );
    const result = await response.json();
    
    if (result.data.updateAvailable) {
      console.log(`Update available: ${result.data.latestVersion}`);
      
      // 下载新版本
      const scriptResponse = await fetch(result.data.updateUrl);
      const scriptResult = await scriptResponse.json();
      
      // 保存新版本
      localStorage.setItem('pluginScript', scriptResult.data.script);
      localStorage.setItem('pluginVersion', scriptResult.data.version);
      
      // 重新加载插件或执行新脚本
      location.reload(); // 或动态加载
    }
  } catch (error) {
    console.error('Update check failed:', error);
    // 使用本地缓存的脚本
    const cachedScript = localStorage.getItem('pluginScript');
    if (cachedScript) {
      executeScript(cachedScript);
    }
  }
}

// 3. 开发者上传新版本
async function uploadNewVersion() {
  const scriptContent = `
    (function() {
      console.log('Amazon plugin v1.3.0');
      // New implementation
    })();
  `;
  
  const response = await fetch('/api/plugin-scripts/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'amazon',
      clientTag: 'chrome-extension',
      version: '1.3.0',
      script: scriptContent,
      description: 'Added new features',
      metadata: {
        changelog: '1. Feature A\n2. Feature B',
        author: 'dev-team'
      },
      setAsLatest: true,
      setAsActive: true
    })
  });
  
  const result = await response.json();
  console.log('Upload result:', result);
}
```

---

## 注意事项

### 1. 版本号管理

- ✅ 使用语义化版本 (semantic versioning)
- ✅ 每次更新应该递增版本号
- ❌ 不要使用重复的版本号
- ❌ 不要回退版本号（除非是回滚操作）

### 2. 脚本内容

- ✅ 确保脚本是有效的 JavaScript
- ✅ 建议使用 IIFE (Immediately Invoked Function Expression)
- ✅ 避免全局变量污染
- ❌ 不要包含敏感信息（API keys, tokens）

### 3. 错误处理

- ✅ 插件端应该处理网络错误
- ✅ 插件端应该处理脚本执行错误
- ✅ 应该有回退机制（使用本地缓存）

### 4. 性能考虑

- ✅ 脚本大小应该合理（建议 < 1MB）
- ✅ 使用缓存减少请求
- ✅ 考虑使用 CDN 加速脚本分发（未来）

---

## 测试示例

### 测试检查版本接口

```bash
# 检查版本（有更新）
curl "http://localhost:8080/api/plugin-scripts/check-version?platform=amazon&clientTag=chrome-extension&currentVersion=1.1.0"

# 检查版本（已是最新）
curl "http://localhost:8080/api/plugin-scripts/check-version?platform=amazon&clientTag=chrome-extension&currentVersion=1.2.0"
```

### 测试上传接口

```bash
# 上传新版本
curl -X POST http://localhost:8080/api/plugin-scripts/upload \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "script": "(function() { console.log(\"v1.3.0\"); })();",
    "setAsLatest": true
  }'
```

### 测试获取最新脚本

```bash
# 获取最新脚本
curl "http://localhost:8080/api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension"
```

---

## 相关文档

- **架构设计**: `docs/PLUGIN_SCRIPT_VERSIONING_ARCHITECTURE.md`
- **业务逻辑**: `docs/PLUGIN_SCRIPT_BUSINESS_LOGIC.md`
- **版本独立性示例**: `docs/PLUGIN_SCRIPT_VERSIONING_EXAMPLES.md`
- **快速总结**: `docs/PLUGIN_SCRIPT_VERSIONING_SUMMARY.md`
