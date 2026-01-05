# Plugin Script Versioning - Business Logic

## 核心业务逻辑

### 1. 插件激活时的版本检查流程

```
┌─────────────────────────────────────────────────────────┐
│ 插件启动/激活                                            │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ 1. 读取本地存储的版本号                                  │
│    - 如果首次安装：version = null                       │
│    - 如果已安装：version = "1.1.0" (例如)              │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ 2. 调用版本检查接口                                      │
│    GET /api/plugin-scripts/check-version                │
│    ?platform=amazon&clientTag=chrome-extension          │
│    &currentVersion=1.1.0                                │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ 3. 后端返回版本信息                                      │
│    {                                                    │
│      currentVersion: "1.1.0",                          │
│      latestVersion: "1.2.0",                            │
│      isUpToDate: false,                                 │
│      updateAvailable: true                              │
│    }                                                    │
└──────────────────┬──────────────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │                   │
         ▼                   ▼
┌──────────────┐    ┌──────────────────────┐
│ isUpToDate   │    │ updateAvailable      │
│ = true       │    │ = true               │
└──────┬───────┘    └──────┬───────────────┘
       │                   │
       │                   ▼
       │         ┌─────────────────────────┐
       │         │ 4. 下载最新脚本          │
       │         │ GET /api/plugin-scripts/ │
       │         │ latest?platform=amazon&  │
       │         │ clientTag=chrome-extension│
       │         └──────┬──────────────────┘
       │                │
       │                ▼
       │         ┌─────────────────────────┐
       │         │ 5. 保存脚本到本地        │
       │         │ - 验证脚本完整性(可选)   │
       │         │ - 保存脚本内容           │
       │         │ - 更新本地版本号        │
       │         └──────┬──────────────────┘
       │                │
       └────────────────┴───┐
                            │
                            ▼
                 ┌──────────────────────┐
                 │ 6. 执行脚本          │
                 │ - 加载并执行新脚本   │
                 │ - 或使用本地缓存脚本 │
                 └──────────────────────┘
```

---

### 2. 脚本更新流程（开发者上传）

```
┌─────────────────────────────────────────────────────────┐
│ 开发者上传新脚本                                          │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ POST /api/plugin-scripts/upload                         │
│ {                                                       │
│   platform: "amazon",                                   │
│   clientTag: "chrome-extension",                        │
│   version: "1.3.0",                                     │
│   script: "// JavaScript code...",                      │
│   description: "Fixed order parsing bug",                │
│   setAsLatest: true,                                    │
│   setAsActive: true                                     │
│ }                                                       │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ 后端处理逻辑：                                            │
│                                                         │
│ 1. 验证版本格式 (semantic versioning)                   │
│    ✓ 格式: major.minor.patch (1.3.0)                    │
│    ✗ 格式错误: 返回 400                                  │
│                                                         │
│ 2. 检查版本是否已存在                                    │
│    - 查询: (platform, clientTag, version)              │
│    - 如果存在: 返回 400 "Version already exists"        │
│                                                         │
│ 3. 如果 setAsLatest: true                               │
│    - 查找当前 latest 版本 (isLatest: true)             │
│    - 设置当前 latest 为 isLatest: false                │
│    - 设置新版本为 isLatest: true                        │
│                                                         │
│ 4. 如果 setAsActive: true                               │
│    - 设置 isActive: true                                │
│                                                         │
│ 5. 保存到数据库                                          │
│    - 创建新记录                                          │
│    - 返回创建结果                                        │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ 响应: 201 Created                                        │
│ {                                                       │
│   id: "script-uuid",                                    │
│   platform: "amazon",                                   │
│   clientTag: "chrome-extension",                        │
│   version: "1.3.0",                                     │
│   isLatest: true,                                       │
│   isActive: true                                        │
│ }                                                       │
└─────────────────────────────────────────────────────────┘
```

---

### 3. 版本管理逻辑

#### 3.1 最新版本（Latest Version）

**规则：**
- 每个 `(platform, clientTag)` 组合只能有一个 `isLatest: true` 的版本
- 当设置新版本为 latest 时：
  1. 找到当前 latest 版本
  2. 设置 `isLatest: false`
  3. 设置新版本 `isLatest: true`

**示例：**
```
初始状态:
- amazon/chrome-extension/1.0.0: isLatest: false
- amazon/chrome-extension/1.1.0: isLatest: true  ← 当前最新
- amazon/chrome-extension/1.2.0: isLatest: false

上传 1.3.0 并设置 setAsLatest: true:
- amazon/chrome-extension/1.0.0: isLatest: false
- amazon/chrome-extension/1.1.0: isLatest: false  ← 不再是最新
- amazon/chrome-extension/1.2.0: isLatest: false
- amazon/chrome-extension/1.3.0: isLatest: true  ← 新的最新
```

#### 3.2 活跃版本（Active Version）

**规则：**
- 可以有多个 `isActive: true` 的版本（用于回滚）
- 只有 active 版本可以被设置为 latest
- 可以停用某个版本（设置 `isActive: false`）

**示例：**
```
状态:
- amazon/chrome-extension/1.0.0: isActive: true,  isLatest: false
- amazon/chrome-extension/1.1.0: isActive: true,  isLatest: false
- amazon/chrome-extension/1.2.0: isActive: true,  isLatest: true   ← 当前最新
- amazon/chrome-extension/1.3.0: isActive: false, isLatest: false  ← 已停用（测试版本）

可以回滚到 1.1.0:
- 设置 1.1.0 为 isLatest: true
- 1.2.0 自动变为 isLatest: false
```

---

### 4. 插件端业务逻辑

#### 4.1 首次安装

```javascript
// 插件首次安装时
async function initializePlugin() {
  const localVersion = localStorage.getItem('pluginVersion');
  
  if (!localVersion) {
    // 首次安装，直接获取最新版本
    const response = await fetch(
      '/api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension'
    );
    const { data } = await response.json();
    
    // 保存脚本和版本
    localStorage.setItem('pluginScript', data.script);
    localStorage.setItem('pluginVersion', data.version);
    
    // 执行脚本
    executeScript(data.script);
  }
}
```

#### 4.2 定期检查更新

```javascript
// 插件激活时检查更新
async function checkForUpdates() {
  const localVersion = localStorage.getItem('pluginVersion');
  const platform = 'amazon';
  const clientTag = 'chrome-extension';
  
  // 检查版本
  const checkResponse = await fetch(
    `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=${localVersion}`
  );
  const { data } = await checkResponse.json();
  
  if (data.updateAvailable) {
    console.log(`Update available: ${data.latestVersion}`);
    
    // 下载新脚本
    const scriptResponse = await fetch(
      `/api/plugin-scripts/latest?platform=${platform}&clientTag=${clientTag}`
    );
    const { data: scriptData } = await scriptResponse.json();
    
    // 保存新脚本
    localStorage.setItem('pluginScript', scriptData.script);
    localStorage.setItem('pluginVersion', scriptData.version);
    
    // 重新加载并执行新脚本
    location.reload(); // 或动态加载新脚本
  } else {
    console.log('Plugin is up to date');
    // 使用本地缓存的脚本
    const cachedScript = localStorage.getItem('pluginScript');
    executeScript(cachedScript);
  }
}
```

#### 4.3 脚本执行

```javascript
function executeScript(scriptContent) {
  try {
    // 方式1: 使用 eval (不推荐，但简单)
    // eval(scriptContent);
    
    // 方式2: 创建 script 标签并注入
    const script = document.createElement('script');
    script.textContent = scriptContent;
    document.head.appendChild(script);
    
    // 方式3: 使用 Function 构造函数
    // const scriptFunction = new Function(scriptContent);
    // scriptFunction();
    
  } catch (error) {
    console.error('Script execution error:', error);
    // 回退到上一个版本或显示错误
  }
}
```

---

### 5. 版本回滚场景

#### 场景：新版本有 bug，需要回滚

```
1. 管理员发现 1.3.0 版本有严重 bug
   ↓
2. 管理员调用: PUT /api/plugin-scripts/:id/status
   Body: { setAsLatest: true }
   Where id 是 1.2.0 版本的 ID
   ↓
3. 后端处理:
   - 找到当前 latest (1.3.0)
   - 设置 1.3.0.isLatest = false
   - 设置 1.2.0.isLatest = true
   ↓
4. 下次插件检查版本时:
   - 检测到 latestVersion = 1.2.0
   - 如果插件当前是 1.3.0，会自动降级到 1.2.0
   ↓
5. 所有插件逐步回滚到稳定版本
```

---

### 6. 多平台支持

#### 示例：不同平台使用不同脚本

```
平台: amazon
├── chrome-extension
│   ├── 1.2.0 (latest)
│   ├── 1.1.0
│   └── 1.0.0
└── firefox-addon
    ├── 1.1.0 (latest)
    └── 1.0.0

平台: airbnb
├── chrome-extension
│   └── 1.0.0 (latest)
└── desktop-app
    └── 1.0.0 (latest)

平台: booking
└── chrome-extension
    ├── 1.2.0 (latest)
    └── 1.1.0
```

每个 `(platform, clientTag)` 组合独立管理版本。

---

### 7. 数据一致性保证

#### 7.1 唯一性约束

- 数据库唯一约束：`(platform, clientTag, version)`
- 防止重复版本

#### 7.2 Latest 版本一致性

- 使用数据库事务确保：
  - 设置新 latest 时，旧 latest 必须被取消
  - 如果操作失败，回滚所有更改

#### 7.3 并发控制

- 使用数据库锁或乐观锁防止并发更新冲突
- 例如：两个请求同时设置不同版本为 latest

---

## 业务规则总结

### ✅ 必须遵守的规则

1. **版本格式**: 必须符合语义化版本 (major.minor.patch)
2. **唯一性**: 同一 (platform, clientTag) 不能有重复版本号
3. **Latest 唯一性**: 每个 (platform, clientTag) 只能有一个 latest
4. **Latest 必须是 Active**: 只有 active 版本才能设置为 latest

### ⚠️ 可选规则

1. **版本激活**: 新版本默认可以 inactive（需要手动激活）
2. **版本描述**: 建议每个版本都有描述和 changelog
3. **版本元数据**: 可以存储作者、测试状态等信息

### 🔄 自动行为

1. **设置 Latest**: 自动取消之前的 latest
2. **版本检查**: 插件自动检测并下载更新
3. **脚本缓存**: 插件本地缓存脚本，减少网络请求

---

## 错误处理

### 常见错误场景

1. **版本不存在**
   - 插件请求的版本不存在
   - 返回 404，插件使用本地缓存或显示错误

2. **版本格式错误**
   - 上传时版本格式不符合规范
   - 返回 400，拒绝保存

3. **脚本执行失败**
   - 插件端执行脚本时出错
   - 插件应该回退到上一个可用版本

4. **网络错误**
   - 插件无法连接后端
   - 使用本地缓存的脚本继续运行

---

## 性能考虑

1. **缓存策略**
   - 后端可以缓存 latest 版本（Redis）
   - 插件本地缓存脚本，减少请求

2. **批量查询**
   - 插件可以一次查询多个平台的版本
   - 减少 HTTP 请求次数

3. **增量更新**
   - 未来可以考虑只传输脚本差异（diff）
   - 减少传输数据量

---

## 安全考虑（未来）

1. **脚本验证**
   - 检查 JavaScript 语法
   - 检查恶意代码模式

2. **访问控制**
   - 上传接口需要认证
   - 不同角色有不同的权限

3. **内容签名**
   - 脚本内容签名验证
   - 防止脚本被篡改
