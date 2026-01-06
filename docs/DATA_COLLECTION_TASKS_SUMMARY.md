# Data Collection Tasks Summary

## Task 类型说明

有两种类型的 task：

1. **Award Tasks** - 在 `config/awards.json` 中定义，用户可以看到和完成的任务（用于积分奖励）
2. **Crawler Tasks** - 在 `src/services/crawlerService.js` 的 `TASK_TEMPLATES` 中定义，爬虫任务模板（用于创建爬虫任务）

---

## Award Tasks（用户可见的任务）

### Luma
**数量：1 个**

| Task ID | Title | Points | Claim Limit |
|---------|-------|--------|-------------|
| `luma-event-submit` | Submit Luma Event Data | 100 | 无限制 |

### Airbnb
**数量：1 个**

| Task ID | Title | Points | Claim Limit |
|---------|-------|--------|-------------|
| `airbnb-trip-submit` | Submit Airbnb Trip Data | 100 | 无限制 |

### Booking
**数量：1 个**

| Task ID | Title | Points | Claim Limit |
|---------|-------|--------|-------------|
| `booking-trip-submit` | Submit Booking Trip Data | 100 | 无限制 |

---

## Crawler Tasks（爬虫任务模板）

### Luma
**数量：1 个**

| Task ID | Title | Description |
|---------|-------|-------------|
| `luma_events` | Luma Events | Luma events history |

### Airbnb
**数量：2 个**

| Task ID | Title | Description |
|---------|-------|-------------|
| `airbnb_trips` | Airbnb Trips | Airbnb trips list |
| `airbnb_past_trips` | Airbnb Past Trips | Airbnb past trips |

### Booking
**数量：3 个**

| Task ID | Title | Description |
|---------|-------|-------------|
| `booking_past_trips` | Booking Past Trips | Booking.com past trips list |
| `booking_past_trip_bookings` | Booking Past Trip Bookings | Booking.com bookings list for a past trip (trip detail) |
| `booking_past_trip_booking_detail` | Booking Past Trip Booking Detail | Booking.com archived booking detail (print view) |

---

## 总结

### Award Tasks（用户任务）
- **Luma**: 1 个
- **Airbnb**: 1 个
- **Booking**: 1 个

### Crawler Tasks（爬虫任务模板）
- **Luma**: 1 个
- **Airbnb**: 2 个
- **Booking**: 3 个

---

## 说明

1. **Award Tasks** 是用户在前端看到的任务，完成这些任务可以获得积分奖励
2. **Crawler Tasks** 是后端爬虫系统的任务模板，用于创建实际的爬虫任务
3. 每个数据源至少有一个 Award Task，但可以有多个 Crawler Task 模板

---

**最后更新：** 2025-01-06
