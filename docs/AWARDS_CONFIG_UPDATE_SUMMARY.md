# Awards Configuration Update Summary

## 更新完成 ✅

### 更新内容

已更新 `config/awards.json`，为所有 crawler 类型的 awards 添加了多个 tasks 和 `crawlerTaskId` 字段。

---

## 更新详情

### 1. Amazon Data Collection
- **任务数量**: 1 个 task
- **Task ID**: `amazon-order-submit`
- **Crawler Task ID**: `amazon_orders` ✅

### 2. Airbnb Data Collection
- **任务数量**: 2 个 tasks (之前 1 个)
- **Tasks**:
  - `airbnb-trips-submit` → `crawlerTaskId: "airbnb_trips"` ✅
  - `airbnb-past-trips-submit` → `crawlerTaskId: "airbnb_past_trips"` ✅ (新增)

### 3. Booking Data Collection
- **任务数量**: 3 个 tasks (之前 1 个)
- **Tasks**:
  - `booking-past-trips-submit` → `crawlerTaskId: "booking_past_trips"` ✅
  - `booking-trip-bookings-submit` → `crawlerTaskId: "booking_past_trip_bookings"` ✅ (新增)
  - `booking-booking-detail-submit` → `crawlerTaskId: "booking_past_trip_booking_detail"` ✅ (新增)

### 4. Luma Data Collection
- **任务数量**: 1 个 task
- **Task ID**: `luma-event-submit`
- **Crawler Task ID**: `luma_events` ✅ (新增)

---

## 验证结果

```
✅ JSON 格式正确

📊 Crawler Awards 任务统计:

amazon-data-collection: 1 tasks
  - amazon-order-submit: crawlerTaskId = amazon_orders

airbnb-data-collection: 2 tasks
  - airbnb-trips-submit: crawlerTaskId = airbnb_trips
  - airbnb-past-trips-submit: crawlerTaskId = airbnb_past_trips

booking-data-collection: 3 tasks
  - booking-past-trips-submit: crawlerTaskId = booking_past_trips
  - booking-trip-bookings-submit: crawlerTaskId = booking_past_trip_bookings
  - booking-booking-detail-submit: crawlerTaskId = booking_past_trip_booking_detail

luma-data-collection: 1 tasks
  - luma-event-submit: crawlerTaskId = luma_events
```

---

## 配置格式

所有 crawler tasks 现在都包含 `crawlerTaskId` 字段，格式如下：

```json
{
  "id": "task-id",
  "title": "Task Title",
  "description": "Task Description",
  "points": 100,
  "claimLimit": null,
  "metadata": {
    "type": "data-submission",
    "source": "booking",
    "crawlerTaskId": "booking_past_trips"
  }
}
```

---

## 下一步

配置已更新完成。接下来需要：

1. **更新 Task Service**: 支持按 `crawlerTaskId` 统计进度
2. **更新数据库 Schema**: 在 `CrawlerTask` 表中添加 `taskId` 字段
3. **更新 Crawler Service**: 创建 CrawlerTask 时保存 `taskId`

---

**最后更新**: 2025-01-06
