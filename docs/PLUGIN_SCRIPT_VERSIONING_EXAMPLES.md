# Plugin Script Versioning - Version Independence Examples

## 核心概念

每个 `(平台, 客户端)` 组合都有**完全独立**的版本管理。

---

## 版本独立性示例

### 示例 1: Amazon 平台的不同客户端

```
Amazon + Chrome Extension:
├── 1.2.0 (latest) ← Chrome 专用版本
├── 1.1.0
└── 1.0.0

Amazon + Firefox Addon:
├── 1.1.0 (latest) ← Firefox 专用版本（可能功能不同）
└── 1.0.0

Amazon + iOS App:
├── 1.0.0 (latest) ← iOS 专用版本（完全不同的实现）
└── 0.9.0

Amazon + Android App:
├── 1.3.0 (latest) ← Android 专用版本
├── 1.2.0
└── 1.0.0

Amazon + Web App:
└── 1.0.0 (latest) ← Web 专用版本
```

**说明：**
- 每个客户端可以有不同的版本号
- 每个客户端可以有不同的最新版本
- 每个客户端可以有不同的脚本内容

---

### 示例 2: 不同平台 + 同一客户端

```
Chrome Extension + Amazon:
├── 1.2.0 (latest)
└── 1.1.0

Chrome Extension + Airbnb:
├── 1.0.0 (latest) ← 可能比 Amazon 版本低
└── 0.9.0

Chrome Extension + Booking:
└── 1.1.0 (latest) ← 独立版本管理

Chrome Extension + Luma:
└── 1.0.0 (latest)
```

**说明：**
- 同一客户端（Chrome Extension）在不同平台上版本独立
- Amazon 可能是 1.2.0，Airbnb 可能是 1.0.0，互不影响

---

### 示例 3: 完整版本矩阵

| Platform | Client Tag | Latest Version | Active Versions | Status |
|----------|------------|----------------|-----------------|--------|
| amazon | chrome-extension | 1.2.0 | 1.0.0, 1.1.0, 1.2.0 | ✅ Active |
| amazon | firefox-addon | 1.1.0 | 1.0.0, 1.1.0 | ✅ Active |
| amazon | ios-app | 1.0.0 | 1.0.0 | ✅ Active |
| amazon | android-app | 1.3.0 | 1.2.0, 1.3.0 | ✅ Active |
| amazon | web-app | 1.0.0 | 1.0.0 | ✅ Active |
| airbnb | chrome-extension | 1.0.0 | 1.0.0 | ✅ Active |
| airbnb | ios-app | 1.0.0 | 1.0.0 | ✅ Active |
| booking | chrome-extension | 1.1.0 | 1.0.0, 1.1.0 | ✅ Active |
| luma | chrome-extension | 1.0.0 | 1.0.0 | ✅ Active |

---

## API 调用示例

### 场景 1: Chrome Extension 检查 Amazon 版本

```javascript
// Chrome Extension 插件
const platform = 'amazon';
const clientTag = 'chrome-extension';
const currentVersion = '1.1.0';

// 检查版本
const response = await fetch(
  `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=${currentVersion}`
);

// 返回: { latestVersion: "1.2.0", updateAvailable: true }
```

### 场景 2: iOS App 检查 Amazon 版本

```javascript
// iOS App
const platform = 'amazon';
const clientTag = 'ios-app';
const currentVersion = '1.0.0';

// 检查版本
const response = await fetch(
  `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=${currentVersion}`
);

// 返回: { latestVersion: "1.0.0", updateAvailable: false }
// 注意：即使 Chrome Extension 有 1.2.0，iOS App 仍然是 1.0.0
```

### 场景 3: Chrome Extension 检查 Airbnb 版本

```javascript
// Chrome Extension 插件（不同平台）
const platform = 'airbnb';
const clientTag = 'chrome-extension';
const currentVersion = '1.0.0';

// 检查版本
const response = await fetch(
  `/api/plugin-scripts/check-version?platform=${platform}&clientTag=${clientTag}&currentVersion=${currentVersion}`
);

// 返回: { latestVersion: "1.0.0", updateAvailable: false }
// 注意：这是 Airbnb 的版本，与 Amazon 的版本完全独立
```

---

## 上传脚本示例

### 为不同客户端上传不同版本

```bash
# 1. 上传 Chrome Extension 版本
curl -X POST /api/plugin-scripts/upload \
  -d '{
    "platform": "amazon",
    "clientTag": "chrome-extension",
    "version": "1.3.0",
    "script": "// Chrome specific code",
    "setAsLatest": true
  }'

# 2. 上传 iOS App 版本（完全独立的版本）
curl -X POST /api/plugin-scripts/upload \
  -d '{
    "platform": "amazon",
    "clientTag": "ios-app",
    "version": "1.1.0",
    "script": "// iOS specific code (different from Chrome)",
    "setAsLatest": true
  }'

# 3. 上传 Android App 版本（又是独立的版本）
curl -X POST /api/plugin-scripts/upload \
  -d '{
    "platform": "amazon",
    "clientTag": "android-app",
    "version": "1.4.0",
    "script": "// Android specific code",
    "setAsLatest": true
  }'
```

**结果：**
- Amazon + Chrome Extension: latest = 1.3.0
- Amazon + iOS App: latest = 1.1.0
- Amazon + Android App: latest = 1.4.0

**每个组合完全独立！**

---

## 版本号可以不同

### 示例：不同客户端版本号不同步

```
Amazon + Chrome Extension:
├── 1.5.0 (latest) ← 已经到 1.5.0 了

Amazon + iOS App:
├── 1.0.0 (latest) ← 还在 1.0.0

Amazon + Android App:
├── 2.0.0 (latest) ← 已经到 2.0.0 了（可能功能完全不同）
```

**这是完全正常的！** 因为：
- 每个客户端可能有不同的开发进度
- 每个客户端可能有不同的功能需求
- 每个客户端可能有不同的发布时间表

---

## 数据库存储示例

### 实际数据示例

```sql
-- Amazon + Chrome Extension 的版本
INSERT INTO PluginScript (platform, clientTag, version, script, isLatest) VALUES
('amazon', 'chrome-extension', '1.2.0', '...', true),
('amazon', 'chrome-extension', '1.1.0', '...', false),
('amazon', 'chrome-extension', '1.0.0', '...', false);

-- Amazon + iOS App 的版本（完全独立）
INSERT INTO PluginScript (platform, clientTag, version, script, isLatest) VALUES
('amazon', 'ios-app', '1.0.0', '...', true);

-- Airbnb + Chrome Extension 的版本（又是独立的）
INSERT INTO PluginScript (platform, clientTag, version, script, isLatest) VALUES
('airbnb', 'chrome-extension', '1.0.0', '...', true);
```

---

## 查询示例

### 获取特定组合的最新版本

```javascript
// 获取 Amazon + Chrome Extension 的最新版本
GET /api/plugin-scripts/latest?platform=amazon&clientTag=chrome-extension
// 返回: version 1.2.0

// 获取 Amazon + iOS App 的最新版本
GET /api/plugin-scripts/latest?platform=amazon&clientTag=ios-app
// 返回: version 1.0.0（完全不同的版本）

// 获取 Airbnb + Chrome Extension 的最新版本
GET /api/plugin-scripts/latest?platform=airbnb&clientTag=chrome-extension
// 返回: version 1.0.0（又是独立的版本）
```

---

## 版本独立性保证

### 数据库约束

```prisma
@@unique([platform, clientTag, version])
```

**这意味着：**
- ✅ 同一个 `(platform, clientTag)` 不能有重复的版本号
- ✅ 不同的 `(platform, clientTag)` 可以有相同的版本号
- ✅ 例如：`(amazon, chrome-extension, 1.0.0)` 和 `(amazon, ios-app, 1.0.0)` 可以同时存在

### Latest 版本独立性

```prisma
@@index([platform, clientTag, isLatest])
```

**这意味着：**
- ✅ 每个 `(platform, clientTag)` 组合可以有且仅有一个 `isLatest: true`
- ✅ 不同组合的 latest 版本完全独立
- ✅ 例如：`(amazon, chrome-extension)` 的 latest 是 1.2.0，`(amazon, ios-app)` 的 latest 是 1.0.0

---

## 实际使用场景

### 场景 1: 不同设备需要不同的实现

```
Chrome Extension (浏览器插件):
- 需要操作 DOM
- 需要注入脚本到页面
- 版本: 1.2.0

iOS App (原生应用):
- 需要调用 iOS API
- 需要处理移动端交互
- 版本: 1.0.0（可能功能更简单）

Android App (原生应用):
- 需要调用 Android API
- 需要处理 Android 特定逻辑
- 版本: 1.3.0（可能有更多功能）
```

### 场景 2: 不同平台需要不同的脚本

```
Amazon (复杂平台):
- 需要处理多种订单格式
- 需要处理不同地区的差异
- 版本: 1.2.0

Airbnb (相对简单):
- 只需要提取行程信息
- 版本: 1.0.0

Booking (中等复杂度):
- 需要处理预订详情
- 版本: 1.1.0
```

### 场景 3: 渐进式发布

```
Chrome Extension (主要平台):
- 快速迭代，版本: 1.5.0

Firefox Addon (次要平台):
- 慢速迭代，版本: 1.1.0

iOS App (新平台):
- 刚发布，版本: 1.0.0
```

---

## 总结

### ✅ 完全独立的版本管理

- **每个 `(platform, clientTag)` 组合**都有独立的版本号
- **每个组合**可以有不同版本号（1.0.0 vs 1.5.0）
- **每个组合**可以有不同最新版本
- **每个组合**可以有不同脚本内容

### 📊 版本矩阵

```
                    Chrome    Firefox   iOS      Android   Web
Amazon              1.2.0     1.1.0     1.0.0    1.3.0     1.0.0
Airbnb              1.0.0     -         1.0.0    -         -
Booking             1.1.0     -         -        1.0.0     -
Luma                1.0.0     -         -        -         -
```

**每个单元格都是独立的版本管理！**

---

## 关键点

1. ✅ **完全独立**: 每个 `(platform, clientTag)` 组合独立管理版本
2. ✅ **版本号可以不同**: Chrome 可以是 1.5.0，iOS 可以是 1.0.0
3. ✅ **脚本内容可以不同**: 不同客户端可以有完全不同的实现
4. ✅ **发布时间可以不同**: 可以分别发布不同客户端的更新
5. ✅ **回滚独立**: 可以单独回滚某个客户端的版本
