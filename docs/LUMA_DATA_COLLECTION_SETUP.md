# Luma Data Collection - 完整设置检查清单

## ✅ 已完成的配置

### 1. Awards 配置 (`config/awards.json`)

✅ **已添加 luma-data-collection award：**
```json
{
  "id": "luma-data-collection",
  "title": "Luma Data Collection",
  "description": "Share Your Luma events to earn rewards",
  "icon": "businessOutline",
  "color": "#1a1a1a",
  "status": "LIVE",
  "enabled": true,
  "metadata": {
    "source": "luma",
    "type": "data-collection",
    "category": "data-sharing",
    "logoUrl": "/assets/websites/luma.png",
    "actionUrl": "/user/crawl-tasks",
    "buttonText": "Submit Data"
  },
  "tasks": [
    {
      "id": "luma-event-submit",
      "title": "Submit Luma Event Data",
      "description": "Share Your Luma events to earn rewards",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "type": "data-submission",
        "source": "luma"
      }
    }
  ]
}
```

### 2. 业务规则配置 (`config/business-rules.json`)

✅ **已添加 luma 数据收集规则：**
```json
"luma": {
  "pointsPerItem": 10,
  "dailyLimit": 1000,
  "monthlyLimit": 10000,
  "rewardRule": "Earn 10 points for each valid data item submitted",
  "validationRules": [...],
  "errors": {...}
}
```

### 3. Task Service (`src/services/taskService.js`)

✅ **已添加 luma-data-collection award strategy：**
- `unlock()` - 自动解锁任务
- `prepare()` - 获取用户 Luma 数据提交统计
- `computeProgress()` - 计算任务进度

✅ **已更新所有相关判断逻辑：**
- `finalStatus` 判断
- `doneCount` 计算
- 数据收集任务状态处理

### 4. Business Rules Service (`src/services/businessRulesService.js`)

✅ **通用函数已支持 luma：**
- `calculateDataPoints(source, count)` - 支持所有数据源（包括 luma）
- `checkDataLimits(userId, source, itemCount)` - 支持所有数据源（包括 luma）
- `getDataRules(source)` - 支持所有数据源（包括 luma）

**说明：** 这些函数是通用的，通过 `businessRules.dataCollection[source]` 动态读取规则，所以 luma 规则添加后自动生效。

### 5. Crawler Service (`src/services/crawlerService.js`)

✅ **已支持 luma：**
- TASK_TEMPLATES 中包含 luma 任务模板
- 数据验证逻辑支持 luma
- 去重逻辑支持 luma

### 6. 消息常量 (`src/constants/messages.js`)

✅ **已包含 luma：**
```javascript
INVALID_SOURCE: 'Data source must be amazon, luma, airbnb, or booking'
SUGGEST_LUMA_ID: 'Luma event ID or task ID is recommended for better data quality'
```

### 7. 静态文件

✅ **Logo 文件已存在：**
- `public/assets/websites/luma.png` ✅

---

## ⏳ 需要执行的步骤

### 1. 更新数据库

**运行以下命令创建/更新 awards 和 tasks：**

```bash
node scripts/createAwards.js
```

这将：
- 创建 `luma-data-collection` award 到数据库
- 创建 `luma-event-submit` task 到数据库
- 更新 metadata（包括 logoUrl）

---

## 📋 验证清单

### 配置验证

- [x] `config/awards.json` - luma-data-collection 已添加，`enabled: true`
- [x] `config/business-rules.json` - luma 规则已添加
- [x] `src/services/taskService.js` - luma-data-collection strategy 已添加
- [x] `src/services/businessRulesService.js` - 通用函数支持 luma（自动）
- [x] `src/services/crawlerService.js` - luma 支持已存在
- [x] `src/constants/messages.js` - luma 消息已包含
- [x] `public/assets/websites/luma.png` - Logo 文件已存在

### 功能验证

- [ ] 运行 `createAwards.js` 更新数据库
- [ ] 测试 `GET /api/awards` 返回 luma-data-collection
- [ ] 测试 `GET /api/users/awards` 返回 luma 任务状态
- [ ] 测试上传 Luma 数据功能
- [ ] 测试 Luma 数据积分计算
- [ ] 测试 Luma 数据限制检查

---

## 🔍 代码位置总结

### 配置文件
- `config/awards.json` - Award 定义
- `config/business-rules.json` - 业务规则

### 服务层
- `src/services/taskService.js` - Award strategy
- `src/services/businessRulesService.js` - 通用规则函数（自动支持）
- `src/services/crawlerService.js` - 数据收集服务（已支持）

### 常量
- `src/constants/messages.js` - 消息定义（已包含）

### 静态文件
- `public/assets/websites/luma.png` - Logo 文件

---

## 📝 注意事项

1. **通用函数自动支持**：`businessRulesService.js` 中的 `calculateDataPoints`, `checkDataLimits`, `getDataRules` 是通用函数，通过动态读取 `business-rules.json` 中的规则，所以添加 luma 规则后自动生效，无需修改代码。

2. **数据库更新**：配置修改后必须运行 `createAwards.js` 才能生效。

3. **颜色配置**：Luma 主题色已设置为深黑色 `#1a1a1a`。

---

## 🎯 下一步

1. ✅ 运行 `node scripts/createAwards.js` 更新数据库
2. ✅ 测试 API 返回
3. ✅ 测试数据上传功能
4. ✅ 验证积分计算和限制检查

---

**最后更新：** 2025-01-06
