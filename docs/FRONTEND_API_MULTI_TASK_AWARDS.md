# Frontend API Documentation - Multi-Task Awards

## 概述

本次更新支持一个 Award 包含多个 Tasks。特别是 Crawler 类型的 Award（Amazon, Airbnb, Booking, Luma）现在可以包含多个子任务，每个子任务对应一个特定的 Crawler Task。

---

## API 端点

### GET /api/awards

获取所有启用的 Awards 及其 Tasks。

**请求头：**
```
Authorization: Bearer <token>
```

**响应格式：**
```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "awardId": "booking-data-collection",
        "title": "Booking Data Collection",
        "description": "Share Your Booking.com trips to earn rewards",
        "icon": "/assets/icons/business-outline.svg",
        "color": "#003580",
        "status": "LIVE",
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
            "taskId": "booking-past-trips-submit",
            "title": "Submit Booking Past Trips",
            "description": "Share your Booking.com past trips list",
            "points": 100,
            "claimLimit": null,
            "progress": 5,
            "doneCount": 5,
            "finalStatus": "IN_PROGRESS",
            "claimed": false,
            "claimRecords": [],
            "metadata": {
              "type": "data-submission",
              "source": "booking",
              "crawlerTaskId": "booking_past_trips"
            }
          },
          {
            "taskId": "booking-trip-bookings-submit",
            "title": "Submit Booking Trip Bookings",
            "description": "Share your Booking.com bookings list for a past trip",
            "points": 100,
            "claimLimit": null,
            "progress": 3,
            "doneCount": 3,
            "finalStatus": "IN_PROGRESS",
            "claimed": false,
            "claimRecords": [],
            "metadata": {
              "type": "data-submission",
              "source": "booking",
              "crawlerTaskId": "booking_past_trip_bookings"
            }
          },
          {
            "taskId": "booking-booking-detail-submit",
            "title": "Submit Booking Detail",
            "description": "Share your Booking.com archived booking detail",
            "points": 100,
            "claimLimit": null,
            "progress": 0,
            "doneCount": 0,
            "finalStatus": "LOCKED",
            "claimed": false,
            "claimRecords": [],
            "metadata": {
              "type": "data-submission",
              "source": "booking",
              "crawlerTaskId": "booking_past_trip_booking_detail"
            }
          }
        ]
      }
    ]
  }
}
```

---

## 数据结构变更

### Award 结构

保持不变，但 `tasks` 数组现在可以包含多个任务。

### Task 结构

**新增字段：**
- `metadata.crawlerTaskId` (string, 可选): 关联的 Crawler Task ID

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `taskId` | string | Task 的唯一标识符 |
| `title` | string | Task 标题 |
| `description` | string | Task 描述 |
| `points` | number | 奖励积分 |
| `claimLimit` | number \| null | 可领取次数限制（null 表示无限制） |
| `progress` | number | 完成进度（0-1 或实际数量） |
| `doneCount` | number | 已完成数量 |
| `finalStatus` | string | 最终状态：`LOCKED` \| `IN_PROGRESS` \| `COMPLETED` |
| `claimed` | boolean | 是否已领取 |
| `claimRecords` | array | 领取记录（时间戳数组） |
| `metadata` | object | 元数据 |
| `metadata.crawlerTaskId` | string \| undefined | Crawler Task ID（仅 Crawler 类型 Task 有） |

---

## 各平台任务数量

### Amazon Data Collection
- **任务数量**: 1 个
- **Task IDs**:
  - `amazon-order-submit` → `crawlerTaskId: "amazon_orders"`

### Airbnb Data Collection
- **任务数量**: 2 个
- **Task IDs**:
  - `airbnb-trips-submit` → `crawlerTaskId: "airbnb_trips"`
  - `airbnb-past-trips-submit` → `crawlerTaskId: "airbnb_past_trips"`

### Booking Data Collection
- **任务数量**: 3 个
- **Task IDs**:
  - `booking-past-trips-submit` → `crawlerTaskId: "booking_past_trips"`
  - `booking-trip-bookings-submit` → `crawlerTaskId: "booking_past_trip_bookings"`
  - `booking-booking-detail-submit` → `crawlerTaskId: "booking_past_trip_booking_detail"`

### Luma Data Collection
- **任务数量**: 1 个
- **Task IDs**:
  - `luma-event-submit` → `crawlerTaskId: "luma_events"`

---

## 前端适配指南

### 1. 识别 Crawler Task

```javascript
function isCrawlerTask(task) {
  return task.metadata?.crawlerTaskId != null;
}
```

### 2. 显示多个 Tasks

**之前（单个 Task）：**
```jsx
<AwardCard award={award}>
  <TaskItem task={award.tasks[0]} />
</AwardCard>
```

**现在（多个 Tasks）：**
```jsx
<AwardCard award={award}>
  {award.tasks.map(task => (
    <TaskItem key={task.taskId} task={task} />
  ))}
</AwardCard>
```

### 3. 处理 Task 状态

```javascript
function getTaskStatus(task) {
  if (task.finalStatus === 'LOCKED') {
    return 'locked';
  } else if (task.finalStatus === 'IN_PROGRESS') {
    return 'in-progress';
  } else if (task.finalStatus === 'COMPLETED' || task.claimed) {
    return 'completed';
  }
  return 'unknown';
}
```

### 4. 显示进度

```javascript
function renderTaskProgress(task) {
  if (task.claimLimit == null) {
    // 无限制任务：显示实际数量
    return `${task.doneCount} items submitted`;
  } else {
    // 有限制任务：显示进度百分比
    const percentage = (task.progress * 100).toFixed(0);
    return `${percentage}% (${task.doneCount}/${task.requirementCount})`;
  }
}
```

### 5. 处理 Task 点击

```javascript
function handleTaskClick(task) {
  if (isCrawlerTask(task)) {
    // Crawler Task: 导航到数据上传页面
    const source = task.metadata.source;
    const crawlerTaskId = task.metadata.crawlerTaskId;
    navigate(`/user/crawl-tasks?source=${source}&taskId=${crawlerTaskId}`);
  } else {
    // 非 Crawler Task: 处理其他逻辑
    // ...
  }
}
```

---

## 示例：React 组件

```jsx
import React from 'react';

function AwardCard({ award }) {
  const isCrawlerAward = award.metadata?.type === 'data-collection';
  
  return (
    <div className="award-card">
      <div className="award-header">
        <img src={award.metadata?.logoUrl} alt={award.title} />
        <h3>{award.title}</h3>
        <p>{award.description}</p>
      </div>
      
      <div className="award-tasks">
        {award.tasks.map(task => (
          <TaskItem key={task.taskId} task={task} />
        ))}
      </div>
      
      {isCrawlerAward && (
        <button onClick={() => navigate(award.metadata.actionUrl)}>
          {award.metadata.buttonText}
        </button>
      )}
    </div>
  );
}

function TaskItem({ task }) {
  const isCrawlerTask = task.metadata?.crawlerTaskId != null;
  const status = getTaskStatus(task);
  
  return (
    <div className={`task-item task-${status}`}>
      <div className="task-header">
        <h4>{task.title}</h4>
        <span className="points">{task.points} points</span>
      </div>
      
      <p className="task-description">{task.description}</p>
      
      <div className="task-progress">
        {task.claimLimit == null ? (
          <span>{task.doneCount} items submitted</span>
        ) : (
          <span>
            {task.doneCount} / {task.requirementCount}
          </span>
        )}
      </div>
      
      {isCrawlerTask && (
        <div className="task-meta">
          <span className="crawler-badge">
            {task.metadata.source.toUpperCase()} Task
          </span>
        </div>
      )}
      
      {status === 'completed' && !task.claimed && (
        <button onClick={() => claimTask(task.taskId)}>
          Claim Reward
        </button>
      )}
    </div>
  );
}
```

---

## 向后兼容性

- 如果 `metadata.crawlerTaskId` 不存在，说明是旧格式或非 Crawler Task
- `progress` 和 `doneCount` 仍然有效，即使没有 `crawlerTaskId`
- 单个 Task 的 Award 仍然可以正常工作

---

## 错误处理

如果 API 返回错误：

```json
{
  "status": "error",
  "message": "Error message"
}
```

前端应该：
1. 显示错误消息
2. 保持现有 UI 状态
3. 记录错误日志（开发环境）

---

## 测试建议

1. **测试多个 Tasks 显示**：
   - 验证 Airbnb 显示 2 个 tasks
   - 验证 Booking 显示 3 个 tasks

2. **测试 Task 状态**：
   - 验证 `LOCKED`、`IN_PROGRESS`、`COMPLETED` 状态正确显示

3. **测试进度统计**：
   - 验证每个 task 的 `progress` 和 `doneCount` 正确显示

4. **测试向后兼容**：
   - 验证没有 `crawlerTaskId` 的 task 仍然正常工作

---

**最后更新**: 2025-01-06
