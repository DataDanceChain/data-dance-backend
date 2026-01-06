# Task 统一方案 - 合并 Crawler Tasks 和 Award Tasks

## 问题分析

### 当前问题

1. **两套系统**：Award Tasks（用户任务）和 Crawler Tasks（爬虫任务）分离
2. **逻辑不一致**：Award Task 统计所有 source 数据，不区分 Crawler Task
3. **扩展性差**：新增数据收集场景需要同时维护两套配置

### 用户需求

- ✅ 需要支持某些平台有多个 task（如 Booking 有 3 个）
- ✅ 逻辑应该统一，不应该有两套系统
- ✅ 当前逻辑已经通了，需要合并和更新

---

## 推荐方案：统一为 Award Tasks

### 核心思路

**让 Award Tasks 直接对应 Crawler Tasks，1:1 映射**

- 每个 Crawler Task 对应一个 Award Task
- Award Task 统计对应 CrawlerTask 的数据
- 用户可以看到所有数据收集方式

---

## 实现方案

### 1. 更新配置结构

**当前结构（分离）：**
```json
// awards.json - Award Tasks
{
  "id": "booking-data-collection",
  "tasks": [
    { "id": "booking-trip-submit" }  // 1 个任务
  ]
}

// crawlerService.js - Crawler Tasks
{
  booking: [
    { taskId: 'booking_past_trips' },
    { taskId: 'booking_past_trip_bookings' },
    { taskId: 'booking_past_trip_booking_detail' }
  ]
}
```

**新结构（统一）：**
```json
// awards.json - 直接对应 Crawler Tasks
{
  "id": "booking-data-collection",
  "tasks": [
    {
      "id": "booking-past-trips-submit",
      "crawlerTaskId": "booking_past_trips",  // 关联到 Crawler Task
      "title": "Submit Booking Past Trips",
      "points": 100
    },
    {
      "id": "booking-trip-bookings-submit",
      "crawlerTaskId": "booking_past_trip_bookings",
      "title": "Submit Booking Trip Bookings",
      "points": 100
    },
    {
      "id": "booking-booking-detail-submit",
      "crawlerTaskId": "booking_past_trip_booking_detail",
      "title": "Submit Booking Detail",
      "points": 100
    }
  ]
}
```

### 2. 更新 Task Service 逻辑

**当前逻辑：**
```javascript
// 统计所有 source 的数据（不区分 CrawlerTask）
const totalCount = await prisma.crawlerData.count({
  where: { userId, source: 'booking' }
});
```

**新逻辑：**
```javascript
// 根据 crawlerTaskId 统计对应 CrawlerTask 的数据
const crawlerTaskId = task.metadata?.crawlerTaskId;
const crawlerTask = await prisma.crawlerTask.findFirst({
  where: {
    userId,
    source: 'booking',
    // 通过 title 或 taskId 匹配
  }
});

const totalCount = await prisma.crawlerData.count({
  where: {
    userId,
    source: 'booking',
    taskId: crawlerTask.id  // 关联到具体的 CrawlerTask
  }
});
```

### 3. 数据关联方式

**方案 A：通过 CrawlerTask.title 匹配**
```javascript
// 在 TASK_TEMPLATES 中定义
{
  taskId: 'booking_past_trips',
  title: 'Booking Past Trips'  // 用于匹配
}

// 在 Award Task metadata 中
{
  "crawlerTaskTitle": "Booking Past Trips"
}
```

**方案 B：通过 CrawlerTask 的 taskId 字段（需要添加）**
```javascript
// 在 CrawlerTask 表中添加 taskId 字段
model CrawlerTask {
  taskId String?  // 对应 TASK_TEMPLATES 中的 taskId
  // ...
}

// 在 Award Task metadata 中
{
  "crawlerTaskId": "booking_past_trips"
}
```

**推荐：方案 B**（更清晰，更易维护）

---

## 具体实现步骤

### Step 1: 更新数据库 Schema

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

### Step 2: 更新 Crawler Service

```javascript
// 创建 CrawlerTask 时保存 taskId
task = await prisma.crawlerTask.create({
  data: {
    taskId: template.taskId,  // 保存 taskId
    title: template.title,
    source: template.source,
    userId
  }
});
```

### Step 3: 更新 Awards 配置

```json
{
  "id": "booking-data-collection",
  "tasks": [
    {
      "id": "booking-past-trips-submit",
      "title": "Submit Booking Past Trips",
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trips"  // 关联
      }
    },
    {
      "id": "booking-trip-bookings-submit",
      "title": "Submit Booking Trip Bookings",
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_bookings"
      }
    },
    {
      "id": "booking-booking-detail-submit",
      "title": "Submit Booking Detail",
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_booking_detail"
      }
    }
  ]
}
```

### Step 4: 更新 Task Service Strategy

```javascript
'booking-data-collection': {
  prepare: async (userId) => {
    // 获取所有 Booking 的 CrawlerTasks
    const crawlerTasks = await prisma.crawlerTask.findMany({
      where: { userId, source: 'booking' },
      select: { id: true, taskId: true }
    });
    
    // 统计每个 CrawlerTask 的数据
    const countsByTaskId = {};
    for (const ct of crawlerTasks) {
      const count = await prisma.crawlerData.count({
        where: {
          userId,
          source: 'booking',
          taskId: ct.id
        }
      });
      countsByTaskId[ct.taskId] = count;
    }
    
    return { countsByTaskId, ... };
  },
  computeProgress: async (task, userId, { countsByTaskId }) => {
    // 根据 task.metadata.crawlerTaskId 获取对应的数据数量
    const crawlerTaskId = task.metadata?.crawlerTaskId;
    return countsByTaskId[crawlerTaskId] || 0;
  }
}
```

---

## 迁移计划

### 阶段 1: 数据库迁移
1. 添加 `CrawlerTask.taskId` 字段
2. 为现有 CrawlerTasks 填充 taskId（基于 title 匹配）

### 阶段 2: 配置更新
1. 更新 `awards.json`，为 Booking/Airbnb 添加多个 tasks
2. 每个 task 的 metadata 中添加 `crawlerTaskId`

### 阶段 3: 代码更新
1. 更新 `crawlerService.js`，创建 CrawlerTask 时保存 taskId
2. 更新 `taskService.js`，按 crawlerTaskId 统计进度

### 阶段 4: 测试和验证
1. 测试 Booking 的 3 个任务独立统计
2. 测试 Airbnb 的 2 个任务独立统计
3. 验证积分计算正确

---

## 优势

1. ✅ **逻辑统一**：Award Tasks 直接对应 Crawler Tasks
2. ✅ **扩展性好**：新增数据收集场景只需在 awards.json 添加
3. ✅ **用户体验清晰**：用户可以看到所有数据收集方式
4. ✅ **代码简化**：不需要维护两套系统

---

## 注意事项

1. **向后兼容**：需要迁移现有数据，确保 taskId 正确填充
2. **默认行为**：如果 task 没有 crawlerTaskId，回退到按 source 统计（兼容性）
3. **Airbnb 也需要更新**：从 1 个任务变为 2 个任务

---

## 决策建议

**推荐实施此方案**，因为：
- ✅ 符合用户需求（支持多个 task）
- ✅ 逻辑更清晰统一
- ✅ 扩展性更好
- ✅ 当前逻辑已经通了，只需要合并和扩展

---

**最后更新：** 2025-01-06
