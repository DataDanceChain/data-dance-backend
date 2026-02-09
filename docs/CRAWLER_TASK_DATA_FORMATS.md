# 爬虫任务与数据格式说明（前端对接文档）

本文档描述后端**返回**与**接收**的爬虫任务相关数据结构，供前端对接使用。

---

## 给前端同事 — 速览

| 需求 | 说明 |
|------|------|
| **任务唯一标识** | 每个任务的 **id** 即 taskId（如 `luma_events`、`airbnb_current_trips`），列表、创建、拉数据都用它。 |
| **单任务完成数** | 用任务对象里的 **recordCount**，表示该账号在该任务下已上传的条数。 |
| **多任务平台整体分值** | 前端按 **source** 分组，把该平台下所有任务的 **recordCount** 累加得到总条数；积分 = 总条数 × 该平台的每条约几分（规则见业务配置，或前端按约定计算）。 |
| **上传时归属到具体任务** | 每条数据可选带 **taskId**，与任务的 id 一致即可归到该任务并正确更新 recordCount / 奖 progress。 |

**相关 API 一览**（均需登录）:

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/crawler-tasks` | 任务列表，query: `source`、`status`、`search`、`page`、`limit`（最大 100） |
| POST | `/api/crawler-tasks` | 创建任务，body 可带 `source`、`taskId` |
| GET | `/api/crawler-tasks/:taskId/data` | 某任务下的数据列表，query: `page`、`limit`（最大 100） |
| POST | `/api/upload` | 上传数据，每条可带 `taskId` 归属到对应任务 |

**约定**：Base URL 以项目/环境配置为准；鉴权统一用请求头 `Authorization: Bearer <token>`。错误响应格式统一为 `{ "status": "error", "message": "..." }`，必要时带 `details` 或 `data`。

---

## 一、任务列表（后端返回）

**接口**: `GET /api/crawler-tasks`  
**鉴权**: 需要登录，请求头带 `Authorization: Bearer <token>`  
**Query**: `source`（可选）、`status`、`search`、`page`、`limit`

**响应**:

```json
{
  "status": "success",
  "data": {
    "tasks": [
      {
        "id": "luma_events",
        "title": "events",
        "description": "Luma events history",
        "source": "luma",
        "status": "pending",
        "createdAt": "2025-01-01T00:00:00.000Z",
        "updatedAt": "2025-01-01T00:00:00.000Z",
        "recordCount": 0,
        "dataUrl": null,
        "log": null,
        "tags": [{ "id": "luma", "name": "Luma" }, { "id": "orders", "name": "Orders" }],
        "origin": "https://lu.ma",
        "path": "/home?period=past"
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 4, "pages": 1 }
  }
}
```

### 任务项字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 任务唯一 id（taskId），列表/详情/上传归属均用此值 |
| `title` | string | 任务标题 |
| `description` | string | 任务描述 |
| `source` | string | 平台：`amazon` \| `luma` \| `airbnb` \| `booking` |
| `status` | string | `pending` \| `running` \| `done` \| `error` |
| `recordCount` | number | 该账号在该任务下已上传条数（完成数量） |
| `origin` | string | 爬取目标站点 base URL |
| `path` | string | 站点内路径（与前端 mock 一致） |

### 多任务平台整体分值（前端累加）

一个平台有多个任务时（如 Airbnb 有「过去行程」+「当前行程」），平台整体的完成条数、积分由**前端**计算：

- **总条数**：按 `source` 分组，将该平台下所有任务的 `recordCount` 累加。
- **积分**：总条数 × 该平台每条约几分（当前各 source 均为 10，以业务配置为准）。

**各 taskId 与 source / origin / path 对应**:

| taskId | source | title | origin | path |
|--------|--------|-------|--------|------|
| `amazon_orders` | amazon | Amazon Order History | https://www.amazon.com | /gp/css/order-history |
| `luma_events` | luma | events | https://lu.ma | /home?period=past |
| `airbnb_trips` | airbnb | Airbnb Past Trips | https://www.airbnb.com.sg | /users/profile/past-trips |
| `airbnb_current_trips` | airbnb | Airbnb Trips | https://www.airbnb.com.sg | /trips/v1 |
| `booking_past_bookings` | booking | Booking.com Past Bookings | https://secure.booking.com | /mytrips.en-gb.html |

### 创建任务（可选）

**接口**: `POST /api/crawler-tasks`  
**Body**: `{ "source": "airbnb", "taskId": "airbnb_current_trips" }`（`taskId` 可选，不传则创建该 source 下第一个任务）  
**成功 (201)** 返回 `data.task`，结构含 `id`（任务 id）、`dbId`（UUID）、`title`、`description`、`source`、`status`、`recordCount`、`createdAt`、`updatedAt`、`origin`、`path`。

---

## 二、单任务数据列表（后端返回）

**接口**: `GET /api/crawler-tasks/:taskId/data?page=1&limit=50`  
**鉴权**: 需要登录。`:taskId` 可为任务 id（如 `luma_events`）或 CrawlerTask 的 DB UUID。

**响应**:

```json
{
  "status": "success",
  "data": {
    "data": [
      {
        "id": "uuid",
        "source": "luma",
        "type": "event",
        "timestamp": "2025-01-01T12:00:00.000Z",
        "metadata": { "sourceUrl": "https://lu.ma/..." },
        "payload": { ... },
        "createdAt": "2025-01-01T12:00:00.000Z"
      }
    ],
    "pagination": { "page": 1, "limit": 50, "total": 10, "pages": 1 }
  }
}
```

每条记录**通用字段**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | CrawlerData 主键 UUID |
| `source` | string | `amazon` \| `luma` \| `airbnb` \| `booking` |
| `type` | string | 数据类型（见下各 source） |
| `timestamp` | string (ISO) | 业务时间 |
| `metadata` | object | 元数据，建议含 `sourceUrl` |
| `payload` | object | 业务数据，**按 source 不同**（见下） |
| `createdAt` | string (ISO) | 入库时间 |

---

## 三、各 source 的 payload 格式（返回 = 上传时存下的）

后端**返回**的 `payload` 就是上传时保存的结构；上传时也应按下列格式传。

### 1. Amazon（taskId: `amazon_orders`）

- **type**: `order` 或 `product`
- **唯一标识**: `orderid` 或 `orderId`（格式建议 `123-1234567-1234567`）

**payload 示例（后端返回 / 上传期望）**:

```json
{
  "source": "amazon",
  "type": "order",
  "timestamp": "2025-01-01T12:00:00.000Z",
  "metadata": { "sourceUrl": "https://www.amazon.com/gp/css/order-history" },
  "payload": {
    "orderid": "123-1234567-1234567",
    "title": "Product name",
    "price": 29.99,
    "currency": "USD"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `orderid` / `orderId` | ✅ | 订单号，去重用 |
| `title` | 建议 | 商品/订单标题 |
| `price` | 建议 | 金额 |
| `currency` | 建议 | 如 USD |

---

### 2. Luma（taskId: `luma_events`）

- **type**: 如 `event`
- **唯一标识**: `eventId` 或 `taskId` 或 `id`（至少其一建议有）

**payload 示例**:

```json
{
  "source": "luma",
  "type": "event",
  "timestamp": "2025-01-01T12:00:00.000Z",
  "metadata": { "sourceUrl": "https://lu.ma/event/xxx" },
  "payload": {
    "eventId": "evt_xxx",
    "taskId": "task_xxx",
    "id": "xxx",
    "title": "Event name",
    "date": "2025-01-15",
    "dueDate": "2025-01-15T19:00:00.000Z"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `eventId` / `taskId` / `id` | 建议 | 至少一个，用于去重与质量分 |
| `title` | 建议 | 活动标题 |
| `date` / `dueDate` | 建议 | 日期/时间 |

---

### 3. Airbnb（taskId: `airbnb_trips` 或 `airbnb_current_trips`）

- **type**: 如 `trip` 或自定义
- 后端未对 payload 做强制字段校验，建议包含可唯一标识一条行程的字段。

**payload 示例**:

```json
{
  "source": "airbnb",
  "type": "trip",
  "timestamp": "2025-01-01T12:00:00.000Z",
  "metadata": { "sourceUrl": "https://www.airbnb.com.sg/trips/xxx" },
  "payload": {
    "id": "trip_or_reservation_id",
    "title": "Trip to Tokyo",
    "startDate": "2025-01-10",
    "endDate": "2025-01-15",
    "status": "completed",
    "listingTitle": "Apartment name"
  }
}
```

（具体字段名可按前端/爬虫约定，后端原样存储并返回。）

---

### 4. Booking（taskId: `booking_past_bookings`）

- **type**: 如 `booking` 或自定义
- 后端未对 payload 做强制字段校验。

**payload 示例**:

```json
{
  "source": "booking",
  "type": "booking",
  "timestamp": "2025-01-01T12:00:00.000Z",
  "metadata": { "sourceUrl": "https://secure.booking.com/mytrips.en-gb.html" },
  "payload": {
    "id": "booking_id",
    "title": "Hotel name - City",
    "checkIn": "2025-01-10",
    "checkOut": "2025-01-15",
    "status": "past"
  }
}
```

---

## 四、上传接口（后端接收）与任务 id、分数归集

**接口**: `POST /api/upload`  
**鉴权**: 需要登录。  
**Body**: `{ "data": [ item1, item2, ... ] }` 或直接 `[ item1, item2, ... ]`

每条 **item** 通用结构:

```json
{
  "source": "amazon|luma|airbnb|booking",
  "type": "order|product|event|trip|booking|...",
  "timestamp": "ISO8601",
  "metadata": { "sourceUrl": "..." },
  "payload": { ... },
  "taskId": "airbnb_current_trips"
}
```

- **source** / **type** / **payload** 必填；**metadata** 建议含 `sourceUrl`。
- **taskId**（可选）：任务模板 id，如 `luma_events`、`airbnb_trips`、`airbnb_current_trips`、`booking_past_bookings`、`amazon_orders`。带上后，本条数据会归到该任务下，该任务的 **recordCount** 与奖 progress（doneCount）会正确累加；不传则按该 source 的第一个任务归集（兼容旧行为）。
- Amazon 必须带 `payload.orderid` 或 `payload.orderId`。
- Luma 建议带 `payload.eventId` 或 `taskId` 或 `id` 之一。

**任务 id 与分数归集**:

- 每个任务在列表中都有唯一 **id**（即 taskId，如 `airbnb_current_trips`），用于区分不同任务。
- 回传（上传）时在每条数据上带 **taskId**，后端会把该条数据关联到对应 CrawlerTask，并只给该任务增加 **recordCount**；Award 的 progress（doneCount）按各 crawlerTaskId 的 recordCount 计算，因此带 taskId 后分数/完成度会按任务正确归集。

**上传成功响应 (200)** 示例:

```json
{
  "status": "success",
  "data": {
    "uploadedCount": 3,
    "pointsEarned": 30,
    "duplicatesCount": 0,
    "duplicateDetails": [],
    "message": "Successfully uploaded 3 items, earned 30 points"
  }
}
```

去重规则:

- **Amazon**: 按 `orderid`/`orderId`。
- **Luma**: 按 `eventId` → `taskId` → `id`。
- **Airbnb / Booking**: 当前无后端专用 sourceId 提取，按 contentHash 等通用去重。

---

## 五、小结表（每条数据：后端给出 = 存库结构）

| source | taskId | type 建议 | payload 必填/建议 | 唯一标识（后端用） |
|--------|--------|-----------|-------------------|--------------------|
| amazon | amazon_orders | order / product | orderid 必填；title, price, currency 建议 | orderid / orderId |
| luma | luma_events | event | eventId/taskId/id 建议；title, date 建议 | eventId → taskId → id |
| airbnb | airbnb_trips / airbnb_current_trips | trip | 无强制；建议 id、标题、日期 | 无专用，靠 contentHash |
| booking | booking_past_bookings | booking | 无强制；建议 id、标题、日期 | 无专用，靠 contentHash |

所有任务的数据在 **GET 任务列表** 和 **GET 任务数据** 中均使用上述结构；**POST /api/upload** 也按同一 payload/metadata 格式提交即可。
