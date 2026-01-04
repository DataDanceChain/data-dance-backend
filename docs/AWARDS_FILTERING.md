# Awards/Rewards API 过滤逻辑说明

## 概述

后端返回的 awards/rewards 是有过滤的，只有 `enabled: true` 的 awards 才会在 API 响应中返回。

---

## API 端点

### 1. 获取平台奖励定义（无需登录）

**端点:** `GET /api/awards`

**说明:** 返回所有启用的平台奖励定义

**响应格式:**
```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "id": "amazon-data-collection",
        "title": "Amazon Data Collection",
        "description": "Share Your Amazon order to earn rewards",
        "icon": "businessOutline",
        "color": "#FF9500",
        "status": "LIVE",
        "metadata": {
          "source": "amazon",
          "type": "data-collection",
          "category": "data-sharing",
          "logoUrl": "/assets/websites/amazon.png",
          "actionUrl": "/user/crawl-tasks",
          "buttonText": "Submit Data"
        }
      },
      {
        "id": "referral-rewards",
        "title": "Referral Rewards",
        "description": "Earn rewards from your referral network activities",
        "icon": "peopleOutline",
        "color": "#FF6B6B",
        "status": "LIVE"
      }
    ]
  }
}
```

---

### 2. 获取用户奖励状态（需要登录）

**端点:** `GET /api/users/awards`

**说明:** 返回当前用户所有启用的奖励及其任务状态

**响应格式:**
```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "awardId": "amazon-data-collection",
        "title": "Amazon Data Collection",
        "description": "Share Your Amazon order to earn rewards",
        "icon": "businessOutline",
        "color": "#FF9500",
        "metadata": {
          "source": "amazon",
          "type": "data-collection",
          "category": "data-sharing",
          "logoUrl": "/assets/websites/amazon.png",
          "actionUrl": "/user/crawl-tasks",
          "buttonText": "Submit Data"
        },
        "totalTasks": 1,
        "claimedTasks": 0,
        "progress": 0.5,
        "finalStatus": "IN_PROGRESS",
        "tasks": [
          {
            "taskId": "amazon-order-submit",
            "title": "Submit Amazon Order Data",
            "description": "Share Your Amazon order to earn rewards",
            "points": 100,
            "progress": 0.5,
            "finalStatus": "IN_PROGRESS",
            "claimed": false,
            "claimLimit": null
          }
        ]
      },
      {
        "awardId": "referral-rewards",
        "title": "Referral Rewards",
        "description": "Earn rewards from your referral network activities",
        "icon": "peopleOutline",
        "color": "#FF6B6B",
        "totalTasks": 4,
        "claimedTasks": 2,
        "progress": 0.5,
        "finalStatus": "IN_PROGRESS",
        "tasks": [
          {
            "taskId": "referral-1",
            "title": "Direct Invite Reward",
            "description": "Reward for directly inviting a user",
            "points": 50,
            "progress": 1,
            "finalStatus": "COMPLETED",
            "claimed": true,
            "claimLimit": null
          }
          // ... 其他任务
        ]
      }
    ],
    "referralOverview": {
      "totalReferrals": 10,
      "level1Count": 5,
      "level2Count": 3,
      "level3Count": 2,
      "level4Count": 0
    }
  }
}
```

---

## 过滤逻辑

### 过滤规则

1. **基于 `enabled` 字段**: 只有 `config.enabled !== false` 的 awards 才会返回
2. **基于数据库存在性**: 如果 award 在数据库中不存在，也会被跳过
3. **返回顺序**: 按照 `config/awards.json` 中定义的顺序返回

### 代码实现

```javascript
// src/services/awardService.js

// getAwardDefinitions() 中的过滤逻辑
return awardConfig
  .filter(config => config.enabled !== false)  // 过滤掉 enabled: false 的
  .map(config => awardMap.get(config.id));

// getUserAwards() 中的过滤逻辑
for (const config of awardConfig) {
  if (config.enabled === false) continue;  // 跳过 enabled: false 的
  const award = awardMap.get(config.id);
  if (!award) continue;  // 跳过数据库中不存在的
  // ... 处理逻辑
}
```

---

## 当前启用的 Awards

根据 `config/awards.json`，目前只有 **2 个 awards** 是启用的：

### 1. Amazon Data Collection (`amazon-data-collection`)
- **enabled**: `true`
- **状态**: `LIVE`
- **任务**: Amazon Order Submit（无限制提交）
- **奖励**: 每次提交 100 积分

### 2. Referral Rewards (`referral-rewards`)
- **enabled**: `true`
- **状态**: `LIVE`
- **任务**: 
  - Direct Invite Reward (50 积分)
  - Level 2 Referral Bonus (5 积分)
  - Level 3 Referral Bonus (3 积分)
  - Level 4 Referral Bonus (1 积分)

---

## 当前禁用的 Awards

以下 awards 在 `config/awards.json` 中设置为 `enabled: false`，**不会在 API 响应中返回**：

1. ❌ **Social Engagement** (`social-engagement`) - `enabled: false`
2. ❌ **Profile Awards** (`profile-awards`) - `enabled: false`
3. ❌ **Early Registration** (`early-registration`) - `enabled: false`
4. ❌ **Assets Collection** (`assets-collection`) - `enabled: false`
5. ❌ **Badge Collection** (`badge-collection`) - `enabled: false`
6. ❌ **DDC Holdings** (`ddc-holdings`) - `enabled: false`
7. ❌ **Ecosystem Participation** (`ecosystem-participation`) - `enabled: false`
8. ❌ **Trading Incentives** (`trading-incentives`) - `enabled: false`
9. ❌ **Loyalty Program** (`loyalty-program`) - `enabled: false`
10. ❌ **Business Partnership** (`business-partnership`) - `enabled: false`
11. ❌ **Innovation Rewards** (`innovation-rewards`) - `enabled: false`
12. ❌ **Education Rewards** (`education-rewards`) - `enabled: false`
13. ❌ **Seasonal Events** (`seasonal-events`) - `enabled: false`
14. ❌ **Ecosystem Building** (`ecosystem-building`) - `enabled: false`

---

## 如何启用/禁用 Awards

### 启用一个 Award

在 `config/awards.json` 中，将对应 award 的 `enabled` 字段设置为 `true` 或删除该字段（默认为 `true`）：

```json
{
  "id": "social-engagement",
  "title": "Social Engagement",
  "enabled": true,  // 改为 true 或删除此行
  // ...
}
```

### 禁用一个 Award

在 `config/awards.json` 中，将对应 award 的 `enabled` 字段设置为 `false`：

```json
{
  "id": "amazon-data-collection",
  "title": "Amazon Data Collection",
  "enabled": false,  // 设置为 false
  // ...
}
```

---

## 前端注意事项

### 1. 只显示返回的 Awards

前端应该只显示 API 返回的 awards，不需要额外过滤：

```javascript
// ✅ 正确：直接使用 API 返回的数据
const response = await fetch('/api/users/awards');
const { awards } = response.data;
// awards 已经是过滤后的，只包含 enabled: true 的

// ❌ 错误：不需要再次过滤
const filteredAwards = awards.filter(a => a.enabled === true);
```

### 2. 处理空列表

如果所有 awards 都被禁用，API 会返回空数组：

```json
{
  "status": "success",
  "data": {
    "awards": []
  }
}
```

前端应该优雅地处理这种情况，显示"暂无可用奖励"等提示。

### 3. 动态更新

当后端更新 `awards.json` 并重启服务后，新的过滤结果会立即生效，前端无需修改代码。

---

## 总结

- ✅ **有过滤**: 只有 `enabled: true` 的 awards 会返回
- ✅ **当前启用**: 只有 2 个 awards（Amazon Data Collection 和 Referral Rewards）
- ✅ **动态控制**: 通过修改 `config/awards.json` 中的 `enabled` 字段来控制显示
- ✅ **向后兼容**: 禁用的 awards 不会影响已存在的用户数据，只是不显示

---

## 相关文件

- `config/awards.json` - Awards 配置文件
- `src/services/awardService.js` - Awards 服务逻辑
- `src/controllers/awardController.js` - Awards API 控制器
- `src/routes/awardRoutes.js` - Awards 路由定义
