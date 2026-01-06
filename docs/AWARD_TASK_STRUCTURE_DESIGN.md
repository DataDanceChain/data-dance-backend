# Award Task Structure Design - 支持多个任务和子任务

## 需求分析

### 用户需求

1. **一个 Award 可以包含多个 Tasks**
2. **如果是 Crawler 类型，Tasks 可以对应多个 Crawler Tasks（子任务）**
3. **非 Crawler 类型的 Tasks 保持现有逻辑**

---

## 设计方案

### 核心思路

**通过 `metadata.crawlerTaskId` 来区分：**

- **Crawler 类型 Task**：有 `metadata.crawlerTaskId` 字段
- **非 Crawler 类型 Task**：没有 `crawlerTaskId` 字段

---

## 配置格式设计

### 1. Crawler 类型的 Award（多个子任务）

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
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trips"
      }
    },
    {
      "id": "booking-trip-bookings-submit",
      "title": "Submit Booking Trip Bookings",
      "description": "Share your Booking.com bookings list for a past trip",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_bookings"
      }
    },
    {
      "id": "booking-booking-detail-submit",
      "title": "Submit Booking Detail",
      "description": "Share your Booking.com archived booking detail",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_booking_detail"
      }
    }
  ]
}
```

### 2. Airbnb（多个子任务）

```json
{
  "id": "airbnb-data-collection",
  "title": "Airbnb Data Collection",
  "metadata": {
    "source": "airbnb",
    "type": "data-collection",
    "isCrawler": true
  },
  "tasks": [
    {
      "id": "airbnb-trips-submit",
      "title": "Submit Airbnb Trips",
      "points": 100,
      "metadata": {
        "type": "data-submission",
        "source": "airbnb",
        "crawlerTaskId": "airbnb_trips"
      }
    },
    {
      "id": "airbnb-past-trips-submit",
      "title": "Submit Airbnb Past Trips",
      "points": 100,
      "metadata": {
        "type": "data-submission",
        "source": "airbnb",
        "crawlerTaskId": "airbnb_past_trips"
      }
    }
  ]
}
```

### 3. Amazon/Luma（单个子任务，保持兼容）

```json
{
  "id": "amazon-data-collection",
  "tasks": [
    {
      "id": "amazon-order-submit",
      "metadata": {
        "type": "data-submission",
        "source": "amazon",
        "crawlerTaskId": "amazon_orders"  // 可选：明确指定，或保持兼容
      }
    }
  ]
}
```

### 4. 非 Crawler 类型的 Award（多个任务，无 crawlerTaskId）

```json
{
  "id": "referral-rewards",
  "title": "Referral Rewards",
  "metadata": {
    "type": "referral"
  },
  "tasks": [
    {
      "id": "referral-1",
      "title": "Direct Invite Reward",
      "points": 50,
      "metadata": {
        "type": "referral"  // 没有 crawlerTaskId
      }
    },
    {
      "id": "referral-2",
      "title": "Level 2 Referral Bonus",
      "points": 5,
      "metadata": {
        "type": "referral"  // 没有 crawlerTaskId
      }
    }
  ]
}
```

---

## 识别规则

### 判断是否为 Crawler Task

```javascript
function isCrawlerTask(task) {
  return task.metadata?.crawlerTaskId != null;
}

function isCrawlerAward(award) {
  // 如果 award 的 tasks 中有任何一个有 crawlerTaskId，就是 crawler award
  return award.tasks?.some(task => task.metadata?.crawlerTaskId != null) ||
         award.metadata?.type === 'data-collection';
}
```

---

## 代码逻辑更新

### Task Service - 支持按 crawlerTaskId 统计

```javascript
'booking-data-collection': {
  unlock: async (userId) => {
    // 解锁所有 Booking tasks
    const tasks = ['booking-past-trips-submit', 'booking-trip-bookings-submit', 'booking-booking-detail-submit'];
    for (const taskId of tasks) {
      await recordTaskProgress(userId, taskId, 1);
    }
  },
  prepare: async (userId) => {
    // 获取所有 Booking 的 CrawlerTasks（需要添加 taskId 字段）
    const crawlerTasks = await prisma.crawlerTask.findMany({
      where: { userId, source: 'booking' },
      select: { id: true, taskId: true }
    });
    
    // 按 taskId 统计数据
    const countsByTaskId = {};
    for (const ct of crawlerTasks) {
      if (ct.taskId) {
        const count = await prisma.crawlerData.count({
          where: {
            userId,
            source: 'booking',
            taskId: ct.id
          }
        });
        countsByTaskId[ct.taskId] = count;
      }
    }
    
    // 如果没有 taskId，回退到按 source 统计（兼容性）
    const totalCount = await prisma.crawlerData.count({
      where: { userId, source: 'booking' }
    });
    
    return { countsByTaskId, totalCount };
  },
  computeProgress: async (task, userId, { countsByTaskId, totalCount }) => {
    // 如果有 crawlerTaskId，按对应的 CrawlerTask 统计
    const crawlerTaskId = task.metadata?.crawlerTaskId;
    if (crawlerTaskId && countsByTaskId[crawlerTaskId] != null) {
      return countsByTaskId[crawlerTaskId];
    }
    
    // 兼容性：如果没有 crawlerTaskId，使用总计数（向后兼容）
    return totalCount || 0;
  }
}
```

---

## 数据库 Schema 更新

### 添加 taskId 字段到 CrawlerTask

```prisma
model CrawlerTask {
  id          String        @id @default(uuid())
  taskId      String?       // 新增：对应 TASK_TEMPLATES 中的 taskId
  title       String
  description String?
  source      String
  status      String        @default("pending")
  // ...
}
```

---

## 完整配置示例

### Booking（3 个子任务）

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
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trips"
      }
    },
    {
      "id": "booking-trip-bookings-submit",
      "title": "Submit Booking Trip Bookings",
      "description": "Share your Booking.com bookings list for a past trip",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_bookings"
      }
    },
    {
      "id": "booking-booking-detail-submit",
      "title": "Submit Booking Detail",
      "description": "Share your Booking.com archived booking detail",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_booking_detail"
      }
    }
  ]
}
```

### Airbnb（2 个子任务）

```json
{
  "id": "airbnb-data-collection",
  "title": "Airbnb Data Collection",
  "description": "Share Your Airbnb trips to earn rewards",
  "icon": "businessOutline",
  "color": "#FF5A5F",
  "status": "LIVE",
  "enabled": true,
  "metadata": {
    "source": "airbnb",
    "type": "data-collection",
    "category": "data-sharing",
    "logoUrl": "/assets/websites/airbnb.webp",
    "actionUrl": "/user/crawl-tasks",
    "buttonText": "Submit Data"
  },
  "tasks": [
    {
      "id": "airbnb-trips-submit",
      "title": "Submit Airbnb Trips",
      "description": "Share your Airbnb trips list",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "type": "data-submission",
        "source": "airbnb",
        "crawlerTaskId": "airbnb_trips"
      }
    },
    {
      "id": "airbnb-past-trips-submit",
      "title": "Submit Airbnb Past Trips",
      "description": "Share your Airbnb past trips",
      "points": 100,
      "claimLimit": null,
      "metadata": {
        "type": "data-submission",
        "source": "airbnb",
        "crawlerTaskId": "airbnb_past_trips"
      }
    }
  ]
}
```

---

## 优势

1. ✅ **灵活**：支持一个 Award 多个 Tasks
2. ✅ **清晰**：通过 `crawlerTaskId` 明确关联关系
3. ✅ **兼容**：没有 `crawlerTaskId` 的任务保持现有逻辑
4. ✅ **扩展**：未来添加新任务只需在配置中添加

---

## 实施步骤

1. **更新配置格式**：在 `awards.json` 中为 Booking/Airbnb 添加多个 tasks
2. **更新数据库 Schema**：添加 `CrawlerTask.taskId` 字段
3. **更新 Crawler Service**：创建 CrawlerTask 时保存 taskId
4. **更新 Task Service**：支持按 `crawlerTaskId` 统计进度
5. **保持兼容**：确保现有逻辑（无 crawlerTaskId）仍然工作

---

**最后更新：** 2025-01-06
