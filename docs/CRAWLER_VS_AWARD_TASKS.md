# Crawler Tasks vs Award Tasks - 详细区别说明

## 概述

系统中有两种不同类型的 task，它们服务于不同的目的：

1. **Award Tasks** - 用户可见的任务，用于积分奖励系统
2. **Crawler Tasks** - 后端爬虫任务模板，用于数据收集

---

## Award Tasks（用户任务）

### 定义位置
- **配置文件**: `config/awards.json`
- **数据库表**: `Task` 表
- **用户关联**: `UserTask` 表

### 用途
- ✅ 用户在前端可以看到和完成的任务
- ✅ 完成任务可以获得积分奖励
- ✅ 显示任务进度和状态
- ✅ 用于奖励系统（Awards）

### 特点
- **用户可见**: 前端 UI 显示
- **积分奖励**: 完成任务获得积分
- **进度跟踪**: 显示完成进度
- **状态管理**: LOCKED, IN_PROGRESS, COMPLETED, CLAIMED

### 示例
```json
{
  "id": "luma-event-submit",
  "title": "Submit Luma Event Data",
  "description": "Share Your Luma events to earn rewards",
  "points": 100,
  "claimLimit": null,  // 无限制
  "metadata": {
    "type": "data-submission",
    "source": "luma"
  }
}
```

### API 端点
- `GET /api/users/awards` - 获取用户的所有 awards 和 tasks
- `POST /api/tasks/:taskId/claim` - 领取任务奖励

---

## Crawler Tasks（爬虫任务）

### 定义位置
- **代码**: `src/services/crawlerService.js` 的 `TASK_TEMPLATES`
- **数据库表**: `CrawlerTask` 表
- **数据关联**: `CrawlerData` 表

### 用途
- ✅ 后端爬虫系统的任务模板
- ✅ 用于创建实际的爬虫任务
- ✅ 组织和管理用户上传的数据
- ✅ 支持多个任务模板（如 Airbnb 有 2 个，Booking 有 3 个）

### 特点
- **后端使用**: 用户不可直接看到（除非通过 API）
- **数据组织**: 用于组织用户上传的数据
- **任务模板**: 可以创建多个不同的爬虫任务
- **状态管理**: pending, running, done, error

### 示例
```javascript
{
  taskId: 'airbnb_trips',
  title: 'Airbnb Trips',
  description: 'Airbnb trips list',
  source: 'airbnb'
}
```

### API 端点
- `GET /api/crawler-tasks` - 获取用户的爬虫任务列表
- `POST /api/crawler-tasks` - 创建新的爬虫任务
- `POST /api/crawler-tasks/upload` - 上传数据到爬虫任务

---

## 核心区别对比

| 特性 | Award Tasks | Crawler Tasks |
|------|-------------|---------------|
| **用户可见** | ✅ 是（前端显示） | ❌ 否（后端使用） |
| **用途** | 积分奖励系统 | 数据收集和组织 |
| **数据库表** | `Task` | `CrawlerTask` |
| **配置位置** | `config/awards.json` | `src/services/crawlerService.js` |
| **数量** | 每个数据源 1 个 | 每个数据源 1-3 个（可多个） |
| **积分奖励** | ✅ 有（points 字段） | ❌ 无 |
| **进度跟踪** | ✅ 有（progress） | ❌ 无（只有 recordCount） |
| **状态** | LOCKED, IN_PROGRESS, COMPLETED, CLAIMED | pending, running, done, error |
| **关联数据** | 通过 source 统计 | 直接关联 `CrawlerData` |

---

## 它们的关系

### 工作流程

```
1. 用户在前端看到 Award Task
   ↓
2. 用户点击"Submit Data"按钮
   ↓
3. 前端调用 POST /api/crawler-tasks/upload
   ↓
4. 后端创建/获取 CrawlerTask（基于 TASK_TEMPLATES）
   ↓
5. 数据保存到 CrawlerData（关联到 CrawlerTask）
   ↓
6. 系统统计该 source 的数据数量
   ↓
7. 更新对应的 Award Task 进度
   ↓
8. 用户在前端看到进度更新
```

### 数据流

```
CrawlerData (用户上传的数据)
    ↓
   关联到
    ↓
CrawlerTask (爬虫任务)
    ↓
   统计 source 数据
    ↓
Award Task (用户任务进度)
    ↓
   显示给用户
```

---

## 实际例子

### 场景：用户上传 Airbnb 数据

1. **Award Task** (`airbnb-trip-submit`)
   - 用户在前端看到："Submit Airbnb Trip Data"
   - 显示进度：已提交 5 条数据
   - 完成任务可获得 100 积分

2. **Crawler Tasks** (模板)
   - `airbnb_trips` - Airbnb Trips
   - `airbnb_past_trips` - Airbnb Past Trips
   
3. **实际流程**
   - 用户上传数据 → 创建 `CrawlerTask` (使用 `airbnb_trips` 模板)
   - 数据保存到 `CrawlerData` (关联到 `CrawlerTask`)
   - 系统统计 `source: 'airbnb'` 的数据总数
   - 更新 `airbnb-trip-submit` Award Task 的进度

---

## 为什么需要两种 Task？

### Award Tasks 的作用
- **用户体验**: 用户需要看到清晰的任务和奖励
- **积分系统**: 需要跟踪任务完成情况和积分奖励
- **进度显示**: 用户需要看到完成进度

### Crawler Tasks 的作用
- **数据组织**: 不同来源的数据需要不同的组织方式
- **灵活性**: 一个数据源可以有多个爬虫任务模板（如 Booking 有 3 个）
- **技术实现**: 后端需要任务来管理和追踪数据收集

---

## 总结

- **Award Tasks** = 用户界面上的任务（1 个/数据源）
- **Crawler Tasks** = 后端数据收集任务模板（1-3 个/数据源）

它们协同工作：
- Award Tasks 给用户提供清晰的任务和奖励
- Crawler Tasks 在后端组织和管理数据收集
- 用户上传的数据通过 Crawler Tasks 组织，然后更新 Award Tasks 的进度

---

**最后更新：** 2025-01-06
