# Task 合并分析 - Crawler Tasks vs Award Tasks

## 当前情况分析

### 现状

**Award Tasks（用户任务）:**
- 每个数据源：**1 个**
- 用途：用户可见，积分奖励
- 进度统计：统计该 `source` 的所有数据（不管来自哪个 Crawler Task）

**Crawler Tasks（爬虫任务）:**
- Luma: 1 个
- Airbnb: 2 个
- Booking: 3 个
- 用途：后端数据组织，用户不可见

### 当前逻辑流程

```
用户上传数据
    ↓
创建/获取 CrawlerTask（基于 TASK_TEMPLATES）
    ↓
保存到 CrawlerData（关联到 CrawlerTask）
    ↓
统计 source 的所有数据（忽略具体 CrawlerTask）
    ↓
更新 Award Task 进度（1 个任务，显示总数）
```

---

## 问题分析

### 为什么需要多个 Crawler Tasks？

**Booking 的例子：**
- `booking_past_trips` - 获取过去行程列表
- `booking_past_trip_bookings` - 获取某个行程的预订详情
- `booking_past_trip_booking_detail` - 获取预订的详细信息

这些是不同的数据收集场景，需要不同的爬虫任务模板。

### 当前的问题

1. **用户只看到 1 个任务**，但后端有多个 Crawler Tasks
2. **进度统计不区分** Crawler Task，所有数据都算在一起
3. **用户体验不清晰**：用户不知道有多个数据收集方式

---

## 合并方案分析

### 方案 A：保持现状，优化理解

**思路：** Crawler Tasks 只是后端技术实现，用户不需要知道

**优点：**
- ✅ 简单，用户只看到 1 个任务
- ✅ 不需要修改现有逻辑
- ✅ 用户体验统一

**缺点：**
- ❌ 用户不知道有多个数据收集方式
- ❌ 无法区分不同数据收集场景的进度

**适用场景：** 如果多个 Crawler Tasks 只是技术实现差异，用户不需要区分

---

### 方案 B：合并 - Award Tasks 支持多个

**思路：** 让 Award Tasks 也能有多个，对应不同的 Crawler Tasks

**实现：**
- Booking 有 3 个 Award Tasks（对应 3 个 Crawler Tasks）
- 每个 Award Task 统计对应 CrawlerTask 的数据
- 用户可以看到 3 个不同的任务

**优点：**
- ✅ 用户可以看到所有数据收集方式
- ✅ 进度更清晰，每个任务独立统计
- ✅ 更灵活，支持不同场景

**缺点：**
- ❌ 需要修改配置和代码
- ❌ 用户体验可能更复杂（3 个任务 vs 1 个）
- ❌ 需要迁移现有数据

**适用场景：** 如果用户需要区分不同的数据收集场景

---

### 方案 C：混合方案 - 1 个 Award Task，内部关联多个

**思路：** 保持 1 个 Award Task，但内部可以关联多个 Crawler Tasks

**实现：**
- Award Task 配置中可以指定多个 `crawlerTaskIds`
- 进度统计：统计所有关联的 CrawlerTasks 的数据
- 前端可以显示子任务列表（可选）

**优点：**
- ✅ 保持用户界面简洁（1 个主任务）
- ✅ 支持多个数据收集方式
- ✅ 可以显示子任务进度（可选）

**缺点：**
- ❌ 需要修改数据模型和逻辑
- ❌ 实现相对复杂

---

## 推荐方案

### 推荐：方案 B（Award Tasks 支持多个）

**理由：**

1. **用户需求明确**：用户提到"有些平台是有多个 task 的"
2. **逻辑更清晰**：每个数据收集场景对应一个任务
3. **扩展性好**：未来添加新场景更容易
4. **用户体验更好**：用户可以看到所有可用的数据收集方式

### 实现步骤

#### 1. 更新配置 (`config/awards.json`)

**Booking 示例：**

```json
{
  "id": "booking-data-collection",
  "title": "Booking Data Collection",
  "tasks": [
    {
      "id": "booking-past-trips-submit",
      "title": "Submit Booking Past Trips",
      "description": "Share your Booking.com past trips list",
      "points": 100,
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trips"  // 关联到 Crawler Task
      }
    },
    {
      "id": "booking-trip-bookings-submit",
      "title": "Submit Booking Trip Bookings",
      "description": "Share your Booking.com trip bookings",
      "points": 100,
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_bookings"
      }
    },
    {
      "id": "booking-booking-detail-submit",
      "title": "Submit Booking Detail",
      "description": "Share your Booking.com booking details",
      "points": 100,
      "metadata": {
        "type": "data-submission",
        "source": "booking",
        "crawlerTaskId": "booking_past_trip_booking_detail"
      }
    }
  ]
}
```

#### 2. 更新 Task Service

修改 `taskService.js` 中的 award strategy，支持按 `crawlerTaskId` 统计：

```javascript
'booking-data-collection': {
  prepare: async (userId) => {
    // 统计每个 Crawler Task 的数据
    const bookingPastTrips = await prisma.crawlerData.count({
      where: {
        userId,
        source: 'booking',
        task: {
          title: 'Booking Past Trips'  // 或通过 taskId 关联
        }
      }
    });
    // ... 其他任务
    return { bookingPastTrips, ... };
  },
  computeProgress: async (task, userId, context) => {
    // 根据 task.metadata.crawlerTaskId 统计对应的数据
    const crawlerTaskId = task.metadata?.crawlerTaskId;
    // 统计该 CrawlerTask 的数据
    return count;
  }
}
```

#### 3. 更新数据模型

在 `Task` 表的 `metadata` 中添加 `crawlerTaskId` 字段，用于关联 Crawler Task。

---

## 简化方案（如果不需要区分）

如果多个 Crawler Tasks 只是技术实现差异，用户不需要区分，可以：

1. **保持现状**：1 个 Award Task，统计所有数据
2. **简化理解**：Crawler Tasks 只是后端实现细节
3. **文档说明**：明确 Crawler Tasks 是技术实现，不影响用户体验

---

## 决策建议

### 如果用户需要区分不同数据收集场景
→ **选择方案 B**：让 Award Tasks 支持多个

### 如果多个 Crawler Tasks 只是技术实现
→ **保持现状**：1 个 Award Task，简化理解

---

## 需要确认的问题

1. **用户是否需要区分** Booking 的 3 个数据收集场景？
   - 如果需要 → 方案 B
   - 如果不需要 → 保持现状

2. **Airbnb 的 2 个 Crawler Tasks** 是否需要区分？
   - `airbnb_trips` vs `airbnb_past_trips`

3. **用户体验优先级**：
   - 简洁（1 个任务）vs 详细（多个任务）

---

**最后更新：** 2025-01-06
