# Award Task 格式设计 - Crawler vs Non-Crawler

## 需求分析

### 当前情况

**Award Tasks 分为两类：**

1. **Crawler 相关的任务**（数据收集）
   - `amazon-data-collection`
   - `airbnb-data-collection`
   - `booking-data-collection`
   - `luma-data-collection`
   - 特点：需要关联到 CrawlerTask，统计 CrawlerData

2. **非 Crawler 的任务**（其他奖励）
   - `referral-rewards` - 推荐奖励
   - `social-engagement` - 社交互动
   - `profile-awards` - 个人资料
   - `assets-collection` - NFT 收集
   - `ddc-holdings` - DDC 持有
   - 等等...
   - 特点：不涉及数据上传，有自己的业务逻辑

---

## 推荐格式设计

### 方案：使用 `taskType` 字段区分

在 `Task` 的 `metadata` 中添加 `taskType` 字段：

```json
{
  "taskType": "crawler" | "regular",
  // 如果是 crawler，还需要：
  "crawlerTaskId": "booking_past_trips",  // 关联到 Crawler Task
  "source": "booking"  // 数据源
}
```

---

## 详细格式规范

### 1. Crawler 相关的 Task（数据收集）

```json
{
  "id": "booking-past-trips-submit",
  "title": "Submit Booking Past Trips",
  "description": "Share your Booking.com past trips list",
  "points": 100,
  "claimLimit": null,
  "metadata": {
    "taskType": "crawler",  // 标识为 crawler 任务
    "source": "booking",    // 数据源
    "crawlerTaskId": "booking_past_trips",  // 关联到 Crawler Task 模板
    "type": "data-submission"
  }
}
```

**特点：**
- `taskType: "crawler"` - 标识为 crawler 任务
- `crawlerTaskId` - 对应 `TASK_TEMPLATES` 中的 `taskId`
- `source` - 数据源（amazon, luma, airbnb, booking）
- 进度统计：通过 `crawlerTaskId` 统计对应 `CrawlerTask` 的 `CrawlerData`

### 2. 非 Crawler 的 Task（普通任务）

```json
{
  "id": "referral-1",
  "title": "Direct Invite Reward",
  "description": "Reward for directly inviting a user",
  "points": 50,
  "claimLimit": null,
  "metadata": {
    "taskType": "regular",  // 标识为普通任务
    // 不需要 crawlerTaskId 和 source
  }
}
```

**特点：**
- `taskType: "regular"` - 标识为普通任务（或省略，默认就是 regular）
- 不需要 `crawlerTaskId` 和 `source`
- 进度统计：通过各自的 award strategy 计算（如 referral, profile 等）

---

## 完整配置示例

### Booking Data Collection（Crawler 任务，多个）

```json
{
  "id": "booking-data-collection",
  "title": "Booking Data Collection",
  "description": "Share Your Booking.com trips to earn rewards",
  "icon": "businessOutline",
  "color": "#003580",
  "status": "LIVE",
  "enabled": true,
  "metadata": {
    "source": "booking",
    "type": "data-collection",
    "category": "data-sharing",
    "logoUrl": "/assets/websites/booking.svg",
    "actionUrl": "/user/crawl-tasks",
    "buttonText": "Submit Data"
  },
  "tasks": [
    {
      "id": "booking-past-trips-submit",
      "title": "Submit Booking Past Trips",
      "description": "Share your Booking.com past trips list",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "taskType": "crawler",
        "source": "booking",
        "crawlerTaskId": "booking_past_trips",
        "type": "data-submission"
      }
    },
    {
      "id": "booking-trip-bookings-submit",
      "title": "Submit Booking Trip Bookings",
      "description": "Share your Booking.com trip bookings",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "taskType": "crawler",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_bookings",
        "type": "data-submission"
      }
    },
    {
      "id": "booking-booking-detail-submit",
      "title": "Submit Booking Detail",
      "description": "Share your Booking.com booking details",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "taskType": "crawler",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_booking_detail",
        "type": "data-submission"
      }
    }
  ]
}
```

### Referral Rewards（非 Crawler 任务）

```json
{
  "id": "referral-rewards",
  "title": "Referral Rewards",
  "description": "Earn rewards from your referral network activities",
  "icon": "peopleOutline",
  "color": "#FF6B6B",
  "status": "LIVE",
  "enabled": true,
  "tasks": [
    {
      "id": "referral-1",
      "title": "Direct Invite Reward",
      "description": "Reward for directly inviting a user",
      "points": 50,
      "claimLimit": null,
      "metadata": {
        "taskType": "regular"
        // 或者省略 taskType，默认就是 regular
      }
    },
    {
      "id": "referral-2",
      "title": "Level 2 Referral Bonus",
      "points": 5,
      "claimLimit": null
      // metadata 可以省略，默认就是 regular
    }
  ]
}
```

---

## 代码逻辑判断

### Task Service 中的判断

```javascript
async function computeProgress(task, userId, context) {
  const taskType = task.metadata?.taskType || 'regular';
  
  if (taskType === 'crawler') {
    // Crawler 任务：统计对应 CrawlerTask 的数据
    const crawlerTaskId = task.metadata.crawlerTaskId;
    const source = task.metadata.source;
    
    // 找到对应的 CrawlerTask
    const crawlerTask = await prisma.crawlerTask.findFirst({
      where: {
        userId,
        source,
        taskId: crawlerTaskId  // 需要添加 taskId 字段到 CrawlerTask
      }
    });
    
    if (!crawlerTask) return 0;
    
    // 统计该 CrawlerTask 的数据
    const count = await prisma.crawlerData.count({
      where: {
        userId,
        source,
        taskId: crawlerTask.id
      }
    });
    
    return count;
  } else {
    // 普通任务：使用各自的 award strategy
    const strategy = awardStrategies[awardId];
    if (strategy?.computeProgress) {
      return await strategy.computeProgress(task, userId, context);
    }
    // 默认逻辑...
  }
}
```

---

## 格式规范总结

### Task Metadata 字段规范

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `taskType` | string | ❌ | 任务类型：`"crawler"` 或 `"regular"`（默认） | `"crawler"` |
| `crawlerTaskId` | string | 条件 | 如果是 crawler 任务，必填 | `"booking_past_trips"` |
| `source` | string | 条件 | 如果是 crawler 任务，必填 | `"booking"` |
| `type` | string | ❌ | 任务子类型（可选） | `"data-submission"` |

### 判断规则

1. **如果 `taskType === "crawler"`**：
   - ✅ 必须有 `crawlerTaskId` 和 `source`
   - ✅ 进度统计：通过 `crawlerTaskId` 统计对应 `CrawlerTask` 的数据
   - ✅ 使用 crawler 相关的 award strategy

2. **如果 `taskType === "regular"` 或省略**：
   - ✅ 不需要 `crawlerTaskId` 和 `source`
   - ✅ 进度统计：使用各自的 award strategy（referral, profile 等）
   - ✅ 使用非 crawler 的 award strategy

---

## 向后兼容

### 现有任务的处理

**现有 Crawler 任务（需要更新）：**
```json
// 旧格式
{
  "metadata": {
    "type": "data-submission",
    "source": "amazon"
  }
}

// 新格式
{
  "metadata": {
    "taskType": "crawler",
    "source": "amazon",
    "crawlerTaskId": "amazon_orders",  // 新增
    "type": "data-submission"
  }
}
```

**现有非 Crawler 任务（保持不变）：**
```json
// 可以保持原样，或添加 taskType
{
  "metadata": {
    "taskType": "regular"  // 可选，默认就是 regular
  }
}
```

---

## 实现建议

### 1. 更新配置格式

在 `config/awards.json` 中：
- Crawler 相关的 tasks 添加 `taskType: "crawler"` 和 `crawlerTaskId`
- 非 Crawler 的 tasks 可以添加 `taskType: "regular"`（可选）

### 2. 更新 Task Service

- 根据 `taskType` 判断使用哪种进度计算逻辑
- Crawler 任务：按 `crawlerTaskId` 统计
- 普通任务：使用现有的 award strategy

### 3. 数据库 Schema

- 在 `CrawlerTask` 表中添加 `taskId` 字段（对应 TASK_TEMPLATES 中的 taskId）

---

## 优势

1. ✅ **清晰区分**：通过 `taskType` 明确区分两种任务类型
2. ✅ **向后兼容**：现有非 crawler 任务可以保持不变
3. ✅ **扩展性好**：未来添加新类型任务很容易
4. ✅ **逻辑统一**：所有任务都在 Award Tasks 中，通过 metadata 区分

---

**最后更新：** 2025-01-06
