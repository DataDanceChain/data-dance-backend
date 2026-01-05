# Plugin Script Versioning System - Quick Summary

## 分支信息

**分支名称**: `plugin-script-versioning`

**目的**: 实现插件脚本的版本管理系统，支持动态更新、多平台、多客户端

---

## 核心功能

### 1. 版本管理
- ✅ 支持语义化版本 (1.0.0, 1.1.0, 2.0.0)
- ✅ 每个 (平台, 客户端) 组合独立管理版本
- ✅ 只有一个 "latest" 版本，但可以有多个 "active" 版本（用于回滚）

### 2. 动态更新
- ✅ 插件激活时自动检查版本
- ✅ 如果有新版本，自动下载并更新
- ✅ 支持版本回滚

### 3. 多平台支持
- ✅ 支持 Amazon, Airbnb, Booking, Luma 等平台
- ✅ 每个平台可以有多个客户端版本（Chrome, Firefox, Desktop, Mobile）

### 4. 外部上传
- ✅ 提供上传接口（暂时无需认证）
- ✅ 支持设置版本为 latest 和 active

---

## 数据库模型

```prisma
model PluginScript {
  id          String   @id
  platform    String   // 'amazon', 'airbnb', 'booking', 'luma'
  clientTag   String   // 'chrome-extension', 'firefox-addon', etc.
  version     String   // '1.0.0', '1.1.0', etc.
  script      String   // JavaScript code
  description String?
  isActive    Boolean  @default(true)
  isLatest    Boolean  @default(false)
  metadata    Json?
  createdAt   DateTime
  updatedAt   DateTime
  createdBy   String?

  @@unique([platform, clientTag, version])
  @@index([platform, clientTag, isLatest])
}
```

---

## API 接口列表

| 方法 | 端点 | 功能 | 认证 |
|------|------|------|------|
| GET | `/api/plugin-scripts/latest` | 获取最新脚本 | 否 |
| GET | `/api/plugin-scripts/check-version` | 检查版本更新 | 否 |
| GET | `/api/plugin-scripts/version` | 获取指定版本 | 否 |
| GET | `/api/plugin-scripts/versions` | 列出所有版本 | 否 |
| GET | `/api/plugin-scripts/platforms` | 列出平台和客户端 | 否 |
| POST | `/api/plugin-scripts/upload` | 上传新脚本 | 否（暂时） |
| PUT | `/api/plugin-scripts/:id/status` | 更新版本状态 | 否（暂时） |

---

## 核心业务逻辑

### 插件激活流程

```
1. 插件启动
   ↓
2. 读取本地版本号
   ↓
3. 调用 check-version 接口
   ↓
4. 如果 updateAvailable = true
   ↓
5. 下载最新脚本
   ↓
6. 保存到本地并更新版本号
   ↓
7. 执行脚本
```

### 脚本上传流程

```
1. 开发者上传脚本
   ↓
2. 验证版本格式和唯一性
   ↓
3. 如果 setAsLatest = true
   → 取消之前的 latest
   → 设置新版本为 latest
   ↓
4. 保存到数据库
```

### 版本回滚流程

```
1. 管理员设置旧版本为 latest
   ↓
2. 自动取消当前 latest
   ↓
3. 插件下次检查时自动下载旧版本
```

---

## 关键设计决策

### 1. 版本格式
- **选择**: 语义化版本 (semantic versioning)
- **原因**: 标准、易理解、支持版本比较

### 2. Latest 唯一性
- **规则**: 每个 (platform, clientTag) 只能有一个 latest
- **原因**: 简化插件端的版本检查逻辑

### 3. Active 版本
- **规则**: 可以有多个 active 版本
- **原因**: 支持版本回滚，保留历史版本

### 4. 无认证（暂时）
- **原因**: 简化开发流程，快速迭代
- **未来**: 添加认证和权限控制

---

## 数据示例

### 示例数据

```json
{
  "platform": "amazon",
  "clientTag": "chrome-extension",
  "version": "1.2.0",
  "script": "(function() { console.log('Amazon plugin v1.2.0'); })();",
  "description": "Fixed order ID parsing",
  "isActive": true,
  "isLatest": true,
  "metadata": {
    "changelog": "Fixed bug in order ID extraction",
    "author": "dev-team"
  }
}
```

---

## 实现步骤（待完成）

1. ✅ 创建数据库迁移（Prisma schema）
2. ⏳ 实现 Service 层 (`pluginScriptService.js`)
3. ⏳ 实现 Controller 层 (`pluginScriptController.js`)
4. ⏳ 创建路由 (`pluginScriptRoutes.js`)
5. ⏳ 添加验证逻辑
6. ⏳ 添加错误处理
7. ⏳ 编写测试

---

## 相关文档

- **架构设计**: `docs/PLUGIN_SCRIPT_VERSIONING_ARCHITECTURE.md`
- **业务逻辑**: `docs/PLUGIN_SCRIPT_BUSINESS_LOGIC.md`
- **本总结**: `docs/PLUGIN_SCRIPT_VERSIONING_SUMMARY.md`

---

## 快速开始（实现后）

### 1. 插件检查更新（完整示例）

```javascript
// 插件端完整代码
async function checkAndUpdatePlugin() {
  const platform = 'amazon';
  const clientTag = 'chrome-extension';
  const currentVersion = localStorage.getItem('pluginVersion') || '0.0.0';
  
  try {
    // 1. 检查版本
    const checkResponse = await fetch(
      `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=${currentVersion}`
    );
    const checkResult = await checkResponse.json();
    
    if (checkResult.status === 'success' && checkResult.data.updateAvailable) {
      console.log(`Update available: ${checkResult.data.latestVersion}`);
      
      // 2. 下载最新脚本
      const scriptResponse = await fetch(
        `/api/plugin-scripts/latest?platform=${platform}&clientTag=${clientTag}`
      );
      const scriptResult = await scriptResponse.json();
      
      if (scriptResult.status === 'success') {
        // 3. 保存脚本和版本
        localStorage.setItem('pluginScript', scriptResult.data.script);
        localStorage.setItem('pluginVersion', scriptResult.data.version);
        
        // 4. 执行新脚本
        executeScript(scriptResult.data.script);
        
        console.log(`Plugin updated to ${scriptResult.data.version}`);
      }
    } else {
      console.log('Plugin is up to date');
      // 使用本地缓存的脚本
      const cachedScript = localStorage.getItem('pluginScript');
      if (cachedScript) {
        executeScript(cachedScript);
      }
    }
  } catch (error) {
    console.error('Update check failed:', error);
    // 错误处理：使用本地缓存
    const cachedScript = localStorage.getItem('pluginScript');
    if (cachedScript) {
      executeScript(cachedScript);
    }
  }
}

function executeScript(scriptContent) {
  try {
    const script = document.createElement('script');
    script.textContent = scriptContent;
    document.head.appendChild(script);
  } catch (error) {
    console.error('Script execution error:', error);
  }
}
```

### 2. 上传新脚本（完整示例）

```bash
# 使用 curl
curl -X POST http://localhost:8080/api/plugin-scripts/upload \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "script": "(function() {\n  console.log(\"Amazon plugin v1.3.0\");\n  // Order extraction logic\n})();",
    "description": "Added support for new Amazon order format",
    "metadata": {
      "changelog": "1. Fixed order ID parsing\n2. Added multi-item support",
      "author": "dev-team"
    },
    "setAsLatest": true,
    "setAsActive": true
  }'
```

```javascript
// 使用 JavaScript fetch
async function uploadScript() {
  const response = await fetch('/api/plugin-scripts/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      platform: 'amazon',
      clientTag: 'chrome-extension',
      version: '1.3.0',
      script: `(function() {
        console.log('Amazon plugin v1.3.0');
        // Implementation
      })();`,
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

### 3. API 请求/响应格式

**检查版本:**
```
GET /api/plugin-scripts/check-version?platform=amazon&clientTag=chrome-extension&currentVersion=1.1.0

Response:
{
  "status": "success",
  "data": {
    "currentVersion": "1.1.0",
    "latestVersion": "1.2.0",
    "isUpToDate": false,
    "updateAvailable": true,
    "updateUrl": "/api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension"
  }
}
```

**获取最新脚本:**
```
GET /api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension

Response:
{
  "status": "success",
  "data": {
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.2.0",
    "script": "(function() { ... })();",
    "metadata": { ... }
  }
}
```

**上传脚本:**
```
POST /api/plugin-scripts/upload
Content-Type: application/json

Request Body:
{
  "platform": "amazon",
  "clientTag": "chrome-extension",
  "version": "1.3.0",
  "script": "(function() { ... })();",
  "description": "Optional description",
  "setAsLatest": true,
  "setAsActive": true
}

Response:
{
  "status": "success",
  "data": {
    "id": "script-uuid",
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "isLatest": true,
    "isActive": true
  }
}
```

---

## 注意事项

1. **版本格式**: 必须严格遵守语义化版本格式
2. **Latest 管理**: 设置新 latest 时，会自动取消旧的 latest
3. **脚本大小**: 建议限制脚本大小（如 1MB）
4. **安全性**: 当前无认证，仅用于开发测试
5. **性能**: 考虑添加缓存（Redis）以提高查询性能
