# Plugin Script Delivery API - Complete Documentation

## 概述

本文档提供插件脚本下发系统的完整 API 文档，包括接口说明、请求/响应格式、使用示例和集成指南。

**核心功能：**
- ✅ 动态脚本更新（无需重新发布插件）
- ✅ 多平台支持（Amazon, Airbnb, Booking, Luma 等）
- ✅ 多客户端支持（Chrome Extension, Firefox Addon, iOS App, Android App 等）
- ✅ 版本管理和回滚
- ✅ 脚本文件存储在本地文件系统

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

## 核心概念

### 1. Platform（平台）
数据源平台标识，例如：
- `amazon` - Amazon 订单数据
- `airbnb` - Airbnb 预订数据
- `booking` - Booking.com 预订数据
- `luma` - Luma 数据

### 2. Client Tag（客户端标识）
客户端/端点标识，例如：
- `chrome-extension` - Chrome 浏览器扩展
- `firefox-addon` - Firefox 浏览器扩展
- `ios-app` - iOS 应用
- `android-app` - Android 应用
- `web-app` - Web 应用

### 3. Version（版本）
语义化版本号，格式：`major.minor.patch`
- 示例：`1.0.0`, `1.1.0`, `2.0.0`
- 验证规则：`^\d+\.\d+\.\d+$`

### 4. Script Storage（脚本存储）
- **存储位置**: 本地文件系统 `public/plugin-scripts/`
- **文件路径**: `/plugin-scripts/{platform}/{clientTag}/{version}.js`
- **访问 URL**: `http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.0.0.js`

---

## API 端点

### 1. 检查版本更新

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

---

### 2. 获取最新脚本

**Endpoint:** `GET /api/plugin-scripts/latest`

**用途:** 获取指定平台和客户端的最新脚本信息（包括下载 URL）

**Query Parameters:**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `platform` | string | ✅ | 平台 ID | `amazon` |
| `clientTag` | string | ✅ | 客户端标识 | `chrome-extension` |

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
    "scriptUrl": "http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.2.0.js",
    "scriptSize": 10240,
    "checksum": "sha256:abc123def456...",
    "description": "Updated Amazon order extraction logic",
    "metadata": {
      "changelog": "Fixed order ID parsing issue, added support for new order format",
      "author": "dev-team",
      "tested": true,
      "minBrowserVersion": "100"
    },
    "isActive": true,
    "isLatest": true,
    "createdAt": "2025-12-15T10:00:00.000Z",
    "updatedAt": "2025-12-15T10:00:00.000Z"
  }
}
```

**字段说明：**
- `scriptUrl`: 脚本文件的直接访问 URL，插件需要从此 URL 下载脚本
- `scriptSize`: 文件大小（字节），用于验证和显示
- `checksum`: SHA256 校验和，用于验证文件完整性（可选）

**响应 - 未找到 (404 Not Found):**

```json
{
  "status": "error",
  "message": "No latest script found for platform 'amazon' and clientTag 'chrome-extension'"
}
```

---

### 3. 获取指定版本脚本

**Endpoint:** `GET /api/plugin-scripts/version`

**用途:** 获取指定版本的脚本信息（用于回滚或历史版本查看）

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
    "id": "script-uuid-456",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.1.0",
    "scriptUrl": "http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.1.0.js",
    "scriptSize": 8192,
    "checksum": "sha256:xyz789...",
    "description": "Fixed order parsing",
    "metadata": {
      "changelog": "Fixed order ID parsing issue"
    },
    "isActive": true,
    "isLatest": false,
    "createdAt": "2025-12-12T10:00:00.000Z",
    "updatedAt": "2025-12-12T10:00:00.000Z"
  }
}
```

---

### 4. 列出所有版本

**Endpoint:** `GET /api/plugin-scripts/versions`

**用途:** 列出指定平台和客户端的所有版本（用于版本管理界面）

**Query Parameters:**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `platform` | string | ✅ | 平台 ID | `amazon` |
| `clientTag` | string | ✅ | 客户端标识 | `chrome-extension` |
| `includeInactive` | boolean | ❌ | 是否包含非激活版本（默认: false） | `true`, `false` |

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
    "versions": [
      {
        "id": "script-uuid-1",
        "version": "1.2.0",
        "isLatest": true,
        "isActive": true,
        "description": "Updated Amazon order extraction logic",
        "scriptUrl": "http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.2.0.js",
        "scriptSize": 10240,
        "createdAt": "2025-12-15T10:00:00.000Z"
      },
      {
        "id": "script-uuid-2",
        "version": "1.1.0",
        "isLatest": false,
        "isActive": true,
        "description": "Fixed order parsing",
        "scriptUrl": "http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.1.0.js",
        "scriptSize": 8192,
        "createdAt": "2025-12-12T10:00:00.000Z"
      },
      {
        "id": "script-uuid-3",
        "version": "1.0.0",
        "isLatest": false,
        "isActive": true,
        "description": "Initial release",
        "scriptUrl": "http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.0.0.js",
        "scriptSize": 5120,
        "createdAt": "2025-12-10T10:00:00.000Z"
      }
    ]
  }
}
```

---

### 5. 列出所有平台和客户端

**Endpoint:** `GET /api/plugin-scripts/platforms`

**用途:** 获取所有可用的平台和客户端组合（用于管理界面）

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
      },
      {
        "id": "booking",
        "name": "Booking.com",
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

### 6. 上传新脚本（开发者使用）

**Endpoint:** `POST /api/plugin-scripts/upload`

**用途:** 上传新版本的插件脚本

**认证:** 当前无需认证（开发阶段）

**Content-Type:** `multipart/form-data` 或 `application/json`

**Request Body (方式 1: multipart/form-data - 推荐):**

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `platform` | string | ✅ | 平台 ID | `amazon` |
| `clientTag` | string | ✅ | 客户端标识 | `chrome-extension` |
| `version` | string | ✅ | 版本号（语义化版本） | `1.0.0` |
| `script` | File | ✅ | JavaScript 脚本文件 (.js) | `script.js` |
| `description` | string | ❌ | 版本描述 | `"Fixed order parsing bug"` |
| `metadata` | string | ❌ | 元数据（JSON 字符串） | `'{"changelog": "...", "author": "..."}'` |
| `setAsLatest` | boolean | ❌ | 是否设置为最新版本（默认: false） | `true` |
| `setAsActive` | boolean | ❌ | 是否激活此版本（默认: true） | `true` |
| `createdBy` | string | ❌ | 创建者标识 | `"dev-team"` |

**Request Body (方式 2: application/json):**

```json
{
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
}
```

**请求示例 (multipart/form-data):**

```bash
curl -X POST http://localhost:8080/api/plugin-scripts/upload \
  -F "platform=amazon" \
  -F "clientTag=chrome-extension" \
  -F "version=1.3.0" \
  -F "script=@script.js" \
  -F "description=Added support for new Amazon order format" \
  -F "setAsLatest=true"
```

**请求示例 (application/json):**

```bash
curl -X POST http://localhost:8080/api/plugin-scripts/upload \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "script": "(function() { console.log(\"Amazon plugin v1.3.0\"); })();",
    "setAsLatest": true
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
    "scriptUrl": "http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.3.0.js",
    "scriptSize": 15360,
    "checksum": "sha256:def456...",
    "isLatest": true,
    "isActive": true,
    "description": "Added support for new Amazon order format",
    "createdAt": "2025-12-16T10:00:00.000Z",
    "updatedAt": "2025-12-16T10:00:00.000Z",
    "previousLatestVersion": "1.2.0"
  }
}
```

**错误响应:**

| 状态码 | 错误信息 | 说明 |
|--------|----------|------|
| 400 | `Version already exists for this platform and clientTag` | 版本已存在 |
| 400 | `Invalid version format. Must follow semantic versioning (major.minor.patch, e.g., 1.0.0)` | 版本格式错误 |
| 400 | `Missing required field: script` | 缺少必填字段 |
| 400 | `Script size exceeds maximum limit of 1MB` | 脚本文件过大 |

---

### 7. 更新脚本状态

**Endpoint:** `PUT /api/plugin-scripts/:id/status`

**用途:** 更新脚本的激活状态或设置最新版本（用于版本回滚）

**Path Parameters:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 脚本 ID |

**Request Body:**

```json
{
  "isActive": false,  // Optional: 激活/停用此版本
  "setAsLatest": true // Optional: 设置此版本为最新版本
}
```

**请求示例:**

```bash
curl -X PUT http://localhost:8080/api/plugin-scripts/script-uuid-123/status \
  -H "Content-Type: application/json" \
  -d '{
    "setAsLatest": true
  }'
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
    "isLatest": true,
    "isActive": false,
    "updatedAt": "2025-12-16T10:00:00.000Z"
  }
}
```

---

## 插件端集成指南

### 1. 插件激活流程

```javascript
// 插件启动时检查版本并更新
async function initializePlugin() {
  const platform = 'amazon';
  const clientTag = 'chrome-extension';
  const currentVersion = localStorage.getItem('pluginVersion') || '0.0.0';
  
  try {
    // 1. 检查版本更新
    const checkResponse = await fetch(
      `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=${currentVersion}`
    );
    const checkResult = await checkResponse.json();
    
    if (checkResult.status === 'success' && checkResult.data.updateAvailable) {
      console.log(`Update available: ${checkResult.data.latestVersion}`);
      
      // 2. 获取最新脚本信息
      await downloadAndUpdateScript(platform, clientTag);
    } else {
      console.log('Plugin is up to date');
      // 使用本地缓存的脚本
      const cachedScript = localStorage.getItem('pluginScript');
      if (cachedScript) {
        executeScript(cachedScript);
      }
    }
  } catch (error) {
    console.error('Failed to check version:', error);
    // 使用本地缓存的脚本
    const cachedScript = localStorage.getItem('pluginScript');
    if (cachedScript) {
      executeScript(cachedScript);
    }
  }
}
```

### 2. 下载并更新脚本

```javascript
async function downloadAndUpdateScript(platform, clientTag) {
  try {
    // 1. 获取最新脚本元数据（包括 scriptUrl）
    const response = await fetch(
      `/api/plugin-scripts/latest?platform=${platform}&clientTag=${clientTag}`
    );
    const result = await response.json();
    
    if (result.status === 'success') {
      const { scriptUrl, version, checksum, scriptSize } = result.data;
      
      // 2. 从文件系统下载脚本文件
      const scriptResponse = await fetch(scriptUrl);
      if (!scriptResponse.ok) {
        throw new Error(`Failed to download script: ${scriptResponse.statusText}`);
      }
      
      const scriptContent = await scriptResponse.text();
      
      // 3. 可选: 验证脚本完整性
      if (checksum) {
        const calculatedChecksum = await calculateSHA256(scriptContent);
        if (calculatedChecksum !== checksum) {
          throw new Error('Script integrity check failed');
        }
      }
      
      // 4. 可选: 验证文件大小
      if (scriptSize && scriptContent.length !== scriptSize) {
        throw new Error('Script size mismatch');
      }
      
      // 5. 保存脚本和版本
      localStorage.setItem('pluginScript', scriptContent);
      localStorage.setItem('pluginVersion', version);
      localStorage.setItem('pluginScriptUrl', scriptUrl);
      
      // 6. 执行脚本
      executeScript(scriptContent);
      
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

// SHA256 校验和计算（示例）
async function calculateSHA256(content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hashHex}`;
}
```

### 3. 执行脚本

```javascript
function executeScript(scriptContent) {
  try {
    // 方式1: 创建 script 标签（适用于浏览器环境）
    const script = document.createElement('script');
    script.textContent = scriptContent;
    document.head.appendChild(script);
    
    // 方式2: 使用 Function 构造函数
    // const scriptFunction = new Function(scriptContent);
    // scriptFunction();
    
    // 方式3: 使用 eval（不推荐，仅用于特殊场景）
    // eval(scriptContent);
  } catch (error) {
    console.error('Script execution error:', error);
  }
}
```

### 4. 完整示例（Chrome Extension）

```javascript
// background.js 或 content script
(async function() {
  const PLATFORM = 'amazon';
  const CLIENT_TAG = 'chrome-extension';
  const API_BASE = 'https://api.datadance.ai';
  
  // 获取当前版本
  const currentVersion = await chrome.storage.local.get('pluginVersion')
    .then(result => result.pluginVersion || '0.0.0');
  
  try {
    // 检查版本
    const checkUrl = `${API_BASE}/api/plugin-scripts/check-version?platform=${PLATFORM}&clientTag=${CLIENT_TAG}&currentVersion=${currentVersion}`;
    const checkResponse = await fetch(checkUrl);
    const checkResult = await checkResponse.json();
    
    if (checkResult.status === 'success' && checkResult.data.updateAvailable) {
      // 获取最新脚本
      const latestUrl = `${API_BASE}/api/plugin-scripts/latest?platform=${PLATFORM}&clientTag=${CLIENT_TAG}`;
      const latestResponse = await fetch(latestUrl);
      const latestResult = await latestResponse.json();
      
      if (latestResult.status === 'success') {
        const { scriptUrl, version, checksum } = latestResult.data;
        
        // 下载脚本
        const scriptResponse = await fetch(scriptUrl);
        const scriptContent = await scriptResponse.text();
        
        // 验证校验和（可选）
        if (checksum) {
          const calculatedChecksum = await calculateSHA256(scriptContent);
          if (calculatedChecksum !== checksum) {
            throw new Error('Script integrity check failed');
          }
        }
        
        // 保存到本地存储
        await chrome.storage.local.set({
          pluginScript: scriptContent,
          pluginVersion: version,
          pluginScriptUrl: scriptUrl
        });
        
        console.log(`Plugin updated to version ${version}`);
      }
    }
    
    // 加载并执行脚本
    const stored = await chrome.storage.local.get('pluginScript');
    if (stored.pluginScript) {
      executeScript(stored.pluginScript);
    }
  } catch (error) {
    console.error('Plugin initialization error:', error);
    // 使用缓存的脚本
    const stored = await chrome.storage.local.get('pluginScript');
    if (stored.pluginScript) {
      executeScript(stored.pluginScript);
    }
  }
})();
```

---

## 文件系统存储

### 存储结构

```
public/
  └── plugin-scripts/
      ├── amazon/
      │   ├── chrome-extension/
      │   │   ├── 1.0.0.js
      │   │   ├── 1.1.0.js
      │   │   └── 1.2.0.js
      │   └── firefox-addon/
      │       ├── 1.0.0.js
      │       └── 1.1.0.js
      ├── airbnb/
      │   └── chrome-extension/
      │       └── 1.0.0.js
      └── booking/
          └── chrome-extension/
              └── 1.0.0.js
```

### 文件路径规则

```
文件系统路径: public/plugin-scripts/{platform}/{clientTag}/{version}.js
访问 URL: http://your-domain.com/plugin-scripts/{platform}/{clientTag}/{version}.js

示例:
- public/plugin-scripts/amazon/chrome-extension/1.0.0.js
- 访问: http://your-domain.com/plugin-scripts/amazon/chrome-extension/1.0.0.js
```

### 静态文件服务配置

后端已配置静态文件服务，脚本文件可以直接通过 HTTP 访问：

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

## 版本管理规则

### Latest Version（最新版本）

- 每个 `(platform, clientTag)` 组合只能有一个 `isLatest: true` 的版本
- 设置新版本为 latest 时，会自动取消之前的 latest 版本
- 插件默认下载 latest 版本

### Active Version（激活版本）

- 可以有多个 `isActive: true` 的版本（用于回滚）
- 只有 active 版本可以被设置为 latest
- 停用 latest 版本时，会自动选择最近的 active 版本作为新的 latest

### 版本回滚

1. 找到要回滚的版本 ID
2. 调用 `PUT /api/plugin-scripts/:id/status`，设置 `setAsLatest: true`
3. 插件下次检查时会自动下载回滚后的版本

---

## 错误处理

### 常见错误码

| 状态码 | 错误信息 | 处理建议 |
|--------|----------|----------|
| 400 | `Version already exists` | 使用不同的版本号 |
| 400 | `Invalid version format` | 使用语义化版本格式 (major.minor.patch) |
| 400 | `Missing required field` | 检查请求参数 |
| 400 | `Script size exceeds limit` | 减小脚本文件大小 |
| 404 | `No script found` | 检查 platform 和 clientTag 是否正确 |
| 500 | `Internal server error` | 联系后端开发团队 |

### 插件端错误处理

```javascript
async function safeDownloadScript(platform, clientTag) {
  try {
    const response = await fetch(`/api/plugin-scripts/latest?platform=${platform}&clientTag=${clientTag}`);
    const result = await response.json();
    
    if (result.status === 'error') {
      console.error('API Error:', result.message);
      // 使用本地缓存的脚本
      return loadCachedScript();
    }
    
    // 继续处理...
  } catch (error) {
    console.error('Network Error:', error);
    // 使用本地缓存的脚本
    return loadCachedScript();
  }
}
```

---

## 最佳实践

### 1. 版本号管理

- ✅ 使用语义化版本号（Semantic Versioning）
- ✅ 重大变更：增加 major 版本（1.0.0 → 2.0.0）
- ✅ 新功能：增加 minor 版本（1.0.0 → 1.1.0）
- ✅ Bug 修复：增加 patch 版本（1.0.0 → 1.0.1）

### 2. 脚本开发

- ✅ 保持脚本向后兼容
- ✅ 添加错误处理
- ✅ 添加日志记录
- ✅ 测试脚本在不同环境下的运行

### 3. 上传脚本

- ✅ 上传前测试脚本功能
- ✅ 提供清晰的版本描述和 changelog
- ✅ 先上传为 inactive，测试后再设置为 latest
- ✅ 保留旧版本以便回滚

### 4. 插件集成

- ✅ 实现版本检查机制
- ✅ 实现脚本缓存机制
- ✅ 实现错误处理和降级策略
- ✅ 可选：实现校验和验证

---

## 安全考虑

### 当前状态

- ⚠️ 上传接口暂时无需认证（开发阶段）
- ⚠️ 脚本内容未经过安全扫描

### 未来增强

- 🔒 添加上传接口认证
- 🔒 添加脚本内容验证
- 🔒 添加访问频率限制
- 🔒 添加脚本签名验证

---

## 常见问题

### Q1: 如何更新插件脚本？

**A:** 使用 `POST /api/plugin-scripts/upload` 接口上传新版本，设置 `setAsLatest: true` 即可。

### Q2: 如何回滚到旧版本？

**A:** 使用 `PUT /api/plugin-scripts/:id/status` 接口，找到旧版本的 ID，设置 `setAsLatest: true`。

### Q3: 脚本文件大小有限制吗？

**A:** 当前限制为 1MB，超过限制会返回 400 错误。

### Q4: 如何验证脚本完整性？

**A:** API 返回的 `checksum` 字段包含 SHA256 校验和，插件端可以下载后计算并对比。

### Q5: 脚本文件存储在哪里？

**A:** 脚本文件存储在服务器本地文件系统的 `public/plugin-scripts/` 目录下，通过静态文件服务提供 HTTP 访问。

---

## 联系支持

如有问题或建议，请联系后端开发团队。

---

**文档版本:** 1.0.0  
**最后更新:** 2025-12-16
