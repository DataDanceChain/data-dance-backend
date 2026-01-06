# Crawler Task Count Analysis

## 分析结果

### 用户提供的任务数量

| Source | Task Count | Task IDs |
|--------|------------|----------|
| **luma** | 1 | `luma_events` |
| **airbnb** | 2 | `airbnb_trips`, `airbnb_past_trips` |
| **booking** | 3 | `booking_past_trips`, `booking_past_trip_bookings`, `booking_past_trip_booking_detail` |

---

## 当前配置对比

### 1. Crawler Service (TASK_TEMPLATES) ✅ 完全符合

**位置**: `src/services/crawlerService.js`

| Source | 当前数量 | Task IDs | 状态 |
|--------|---------|----------|------|
| **luma** | 1 | `luma_events` | ✅ 符合 |
| **airbnb** | 2 | `airbnb_trips`, `airbnb_past_trips` | ✅ 符合 |
| **booking** | 3 | `booking_past_trips`, `booking_past_trip_bookings`, `booking_past_trip_booking_detail` | ✅ 符合 |

**结论**: Crawler Tasks 配置完全符合要求。

---

### 2. Awards Configuration (awards.json) ❌ 不符合

**位置**: `config/awards.json`

| Source | 当前数量 | 应该数量 | 状态 |
|--------|---------|---------|------|
| **luma** | 1 task | 1 task | ✅ 符合 |
| **airbnb** | 1 task | 2 tasks | ❌ **需要更新** |
| **booking** | 1 task | 3 tasks | ❌ **需要更新** |

#### 详细分析

**Luma (`luma-data-collection`)**
- ✅ 当前: 1 个 task (`luma-event-submit`)
- ✅ 应该: 1 个 task (对应 `luma_events`)
- ✅ **状态**: 符合，但需要添加 `crawlerTaskId: "luma_events"`

**Airbnb (`airbnb-data-collection`)**
- ❌ 当前: 1 个 task (`airbnb-trip-submit`)
- ✅ 应该: 2 个 tasks
  - `airbnb_trips` → 应该对应 `airbnb-trips-submit`
  - `airbnb_past_trips` → 应该对应 `airbnb-past-trips-submit`
- ❌ **状态**: 不符合，需要添加第二个 task

**Booking (`booking-data-collection`)**
- ❌ 当前: 1 个 task (`booking-trip-submit`)
- ✅ 应该: 3 个 tasks
  - `booking_past_trips` → 应该对应 `booking-past-trips-submit`
  - `booking_past_trip_bookings` → 应该对应 `booking-trip-bookings-submit`
  - `booking_past_trip_booking_detail` → 应该对应 `booking-booking-detail-submit`
- ❌ **状态**: 不符合，需要添加第二、第三个 task

---

## 需要更新的内容

### 1. Awards 配置更新

需要在 `config/awards.json` 中为以下 awards 添加多个 tasks，并添加 `crawlerTaskId` 字段：

#### Airbnb Data Collection
```json
{
  "id": "airbnb-data-collection",
  "tasks": [
    {
      "id": "airbnb-trips-submit",
      "metadata": {
        "crawlerTaskId": "airbnb_trips"
      }
    },
    {
      "id": "airbnb-past-trips-submit",
      "metadata": {
        "crawlerTaskId": "airbnb_past_trips"
      }
    }
  ]
}
```

#### Booking Data Collection
```json
{
  "id": "booking-data-collection",
  "tasks": [
    {
      "id": "booking-past-trips-submit",
      "metadata": {
        "crawlerTaskId": "booking_past_trips"
      }
    },
    {
      "id": "booking-trip-bookings-submit",
      "metadata": {
        "crawlerTaskId": "booking_past_trip_bookings"
      }
    },
    {
      "id": "booking-booking-detail-submit",
      "metadata": {
        "crawlerTaskId": "booking_past_trip_booking_detail"
      }
    }
  ]
}
```

#### Luma Data Collection
```json
{
  "id": "luma-data-collection",
  "tasks": [
    {
      "id": "luma-event-submit",
      "metadata": {
        "crawlerTaskId": "luma_events"
      }
    }
  ]
}
```

---

## 总结

| 配置项 | 状态 | 说明 |
|--------|------|------|
| **Crawler Tasks (TASK_TEMPLATES)** | ✅ 符合 | 所有 source 的任务数量都正确 |
| **Award Tasks (awards.json)** | ❌ 不符合 | Airbnb 和 Booking 需要添加多个 tasks，所有 tasks 需要添加 `crawlerTaskId` |

---

**最后更新**: 2025-01-06
