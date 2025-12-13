# 商家端前端 API 文档

> **最后更新**: 2025-11-24  
> **版本**: 2.0  
> **Base URL**: `https://api.datadance.ai` (生产环境) / `http://localhost:3000` (开发环境)

## 📋 目录

1. [认证与授权](#认证与授权)
2. [DataNFT 管理 API](#datanft-管理-api)
3. [数据市场 API](#数据市场-api)
4. [交易与余额 API](#交易与余额-api)
5. [区块链相关 API](#区块链相关-api)
6. [快照管理 API](#快照管理-api)
7. [标签管理 API](#标签管理-api)

---

## 🔐 认证与授权

所有 API 都需要在请求头中携带 JWT token：

```
Authorization: Bearer <your-jwt-token>
```

### 登录获取 Token

```
POST /api/auth/login
```

**请求体**:
```json
{
  "email": "merchant@example.com",
  "password": "password123"
}
```

**响应**:
```json
{
  "status": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "user-uuid",
      "email": "merchant@example.com",
      "name": "商家名称",
      "isOrganization": true
    }
  }
}
```

---

## 📦 DataNFT 管理 API

### 1. 创建 DataNFT（合并快照）

将多个快照合并成一个 DataNFT 数据资产包。

```
POST /api/data-nfts/merge
```

**请求头**:
- `Authorization: Bearer <token>`
- `Content-Type: multipart/form-data`

**请求体** (multipart/form-data):
| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `snapshotIds` | string[] | ✅ | 快照 ID 数组（JSON 字符串） |
| `name` | string | ✅ | DataNFT 名称 |
| `description` | string | ❌ | 描述 |
| `price` | number | ✅ | 价格（USDT） |
| `image` | file/string | ❌ | 配图（文件上传或已有图片路径） |
| `tags` | string[] | ❌ | 标签 ID 数组（JSON 字符串） |

**响应** (201 Created):
```json
{
  "id": "data-nft-uuid",
  "name": "数据资产包名称",
  "description": "描述",
  "price": 99.99,
  "image": "/assets/nfts/xxx.jpg",
  "merchantId": "merchant-uuid",
  "isPublished": false,
  "snapshots": [
    {
      "id": "snapshot-uuid-1",
      "name": "快照1"
    }
  ],
  "tags": [
    {
      "id": "tag-uuid",
      "name": "标签名称"
    }
  ],
  "createdAt": "2025-11-24T10:00:00.000Z"
}
```

---

### 2. 获取我的 DataNFT 列表

获取当前商家创建的所有 DataNFT（包括已发布和未发布的）。

```
GET /api/data-nfts?allMine=true&page=1&limit=10
```

**查询参数**:
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `allMine` | boolean | false | 设为 `true` 获取我的所有 DataNFT |
| `page` | number | 1 | 页码 |
| `limit` | number | 10 | 每页数量 |
| `search` | string | - | 搜索关键词（名称、描述） |
| `minPrice` | number | - | 最低价格 |
| `maxPrice` | number | - | 最高价格 |
| `tags` | string | - | 标签 ID（逗号分隔） |

**响应** (200 OK):
```json
{
  "data": [
    {
      "id": "data-nft-uuid",
      "name": "数据资产包名称",
      "description": "描述",
      "price": 99.99,
      "image": "/assets/nfts/xxx.jpg",
      "isPublished": true,
      "size": 1000,
      "merchant": {
        "id": "merchant-uuid",
        "name": "商家名称",
        "avatar": "/assets/avatars/xxx.jpg"
      },
      "snapshots": [...],
      "tags": [...],
      "blockchainTokenId": "3",
      "blockchainTxHash": "0x...",
      "blockchainRecordedAt": "2025-11-24T10:00:00.000Z",
      "createdAt": "2025-11-24T10:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 50,
    "page": 1,
    "limit": 10,
    "pages": 5
  }
}
```

**字段说明**:
- `size`: 数据量（记录数或用户数）
- `blockchainTokenId`: 链上 Token ID（如果已上链）
- `blockchainTxHash`: 链上交易哈希（如果已上链）
- `blockchainRecordedAt`: 上链时间（如果已上链）

---

### 3. 获取单个 DataNFT 详情

```
GET /api/data-nfts/{id}
```

**响应** (200 OK):
```json
{
  "id": "data-nft-uuid",
  "name": "数据资产包名称",
  "description": "描述",
  "price": 99.99,
  "image": "/assets/nfts/xxx.jpg",
  "isPublished": true,
  "size": 1000,
  "merchant": {
    "id": "merchant-uuid",
    "name": "商家名称",
    "avatar": "/assets/avatars/xxx.jpg"
  },
  "snapshots": [
    {
      "id": "snapshot-uuid",
      "name": "快照名称",
      "activity": {
        "id": "activity-uuid",
        "name": "活动名称"
      }
    }
  ],
  "tags": [
    {
      "id": "tag-uuid",
      "name": "标签名称"
    }
  ],
  "dataSource": "snapshot",
  "dataRecords": null,
  "blockchainTokenId": "3",
  "blockchainTxHash": "0x...",
  "blockchainRecordedAt": "2025-11-24T10:00:00.000Z",
  "createdAt": "2025-11-24T10:00:00.000Z",
  "updatedAt": "2025-11-24T10:00:00.000Z"
}
```

**字段说明**:
- `dataSource`: 数据来源，`"snapshot"` 表示来自活动快照，`"upload"` 表示直接上传的数据包
- `dataRecords`: 如果是上传的数据包，这里包含数据记录信息

---

### 4. 更新 DataNFT

只能更新未发布的 DataNFT。

```
PUT /api/data-nfts/{id}
```

**请求头**:
- `Authorization: Bearer <token>`
- `Content-Type: multipart/form-data`

**请求体** (multipart/form-data):
| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `name` | string | ❌ | DataNFT 名称 |
| `description` | string | ❌ | 描述 |
| `price` | number | ❌ | 价格 |
| `image` | file/string | ❌ | 配图 |
| `tags` | string[] | ❌ | 标签 ID 数组（JSON 字符串） |

**响应** (200 OK):
```json
{
  "id": "data-nft-uuid",
  "name": "更新后的名称",
  ...
}
```

**错误响应**:
- `400 Bad Request`: DataNFT 已发布，无法更新
- `403 Forbidden`: 无权更新此 DataNFT
- `404 Not Found`: DataNFT 不存在

---

### 5. 删除 DataNFT

只能删除未发布的 DataNFT。

```
DELETE /api/data-nfts/{id}
```

**响应** (204 No Content)

**错误响应**:
- `400 Bad Request`: DataNFT 已发布，无法删除
- `403 Forbidden`: 无权删除此 DataNFT
- `404 Not Found`: DataNFT 不存在

---

### 6. 发布 DataNFT

将 DataNFT 发布到市场，供其他用户购买。

```
POST /api/data-nfts/{id}/publish
```

**响应** (200 OK):
```json
{
  "id": "data-nft-uuid",
  "isPublished": true,
  ...
}
```

---

### 7. 下架 DataNFT

将已发布的 DataNFT 从市场下架。

```
POST /api/data-nfts/{id}/unpublish
```

**响应** (200 OK):
```json
{
  "id": "data-nft-uuid",
  "isPublished": false,
  ...
}
```

---

### 8. 获取 DataNFT 持有者列表

获取购买了此 DataNFT 的所有用户。

```
GET /api/data-nfts/{id}/holders?page=1&limit=10
```

**查询参数**:
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | 1 | 页码 |
| `limit` | number | 10 | 每页数量 |

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "holders": [
      {
        "id": "user-uuid",
        "email": "buyer@example.com",
        "name": "买家名称",
        "avatar": "/assets/avatars/xxx.jpg",
        "purchasedAt": "2025-11-24T10:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 25,
      "pages": 3
    }
  }
}
```

---

### 9. 按商家获取 DataNFT 列表

获取指定商家已发布的所有 DataNFT。

```
GET /api/data-nfts/merchant/{merchantId}?page=1&limit=10
```

**查询参数**:
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | 1 | 页码 |
| `limit` | number | 10 | 每页数量 |

**响应** (200 OK):
```json
{
  "data": [
    {
      "id": "data-nft-uuid",
      "name": "数据资产包名称",
      "price": 99.99,
      "isPublished": true,
      ...
    }
  ],
  "pagination": {
    "total": 20,
    "page": 1,
    "limit": 10,
    "pages": 2
  }
}
```

---

## 🛒 数据市场 API

### 1. 获取市场列表

获取所有已发布的 DataNFT（公开市场）。

```
GET /api/nft-market?tag=标签名&search=关键词
```

**查询参数**:
| 参数 | 类型 | 说明 |
|------|------|------|
| `tag` | string | 按标签筛选 |
| `search` | string | 搜索关键词（名称、描述、商家名称、标签） |

**响应** (200 OK):
```json
{
  "status": "success",
  "data": [
    {
      "id": "data-nft-uuid",
      "title": "数据资产包名称",
      "coverImage": "/assets/nfts/xxx.jpg",
      "owner": "商家名称",
      "ownerId": "merchant-uuid",
      "ownerAvatar": "/assets/avatars/xxx.jpg",
      "size": 1000,
      "price": 99.99,
      "description": "描述",
      "tags": ["标签1", "标签2"]
    }
  ]
}
```

---

### 2. 获取市场详情

获取单个 DataNFT 的市场详情（包括销量和收入）。

```
GET /api/nft-market/{id}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "data-nft-uuid",
    "title": "数据资产包名称",
    "coverImage": "/assets/nfts/xxx.jpg",
    "owner": "商家名称",
    "ownerId": "merchant-uuid",
    "ownerAvatar": "/assets/avatars/xxx.jpg",
    "size": 1000,
    "price": 99.99,
    "description": "描述",
    "tags": ["标签1", "标签2"],
    "sales": 25,
    "revenue": 2499.75
  }
}
```

**字段说明**:
- `sales`: 销量（购买次数）
- `revenue`: 总收入（销量 × 单价）

---

### 3. 购买 DataNFT

购买指定的 DataNFT。

```
POST /api/nft-market/{id}/purchase
```

**请求体**:
```json
{
  "quantity": 1
}
```

**响应** (201 Created):
```json
{
  "id": "purchase-uuid",
  "dataNFTId": "data-nft-uuid",
  "buyerId": "buyer-uuid",
  "quantity": 1,
  "purchaseCount": 1,
  "dataNFT": {
    "id": "data-nft-uuid",
    "name": "数据资产包名称",
    "price": 99.99,
    ...
  },
  "createdAt": "2025-11-24T10:00:00.000Z"
}
```

**错误响应**:
- `400 Bad Request`: DataNFT 未发布或余额不足
- `403 Forbidden`: 不能购买自己的 DataNFT
- `404 Not Found`: DataNFT 不存在

**注意**: 
- 购买时会自动检查组织用户余额
- 购买成功后会自动生成交易流水（商家收入 + 买家支出）

---

### 4. 获取我购买的 DataNFT

获取当前用户购买的所有 DataNFT。

```
GET /api/data-nfts/purchased?page=1&limit=10
```

**查询参数**:
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | 1 | 页码 |
| `limit` | number | 10 | 每页数量 |

**响应** (200 OK):
```json
{
  "data": [
    {
      "id": "purchase-uuid",
      "dataNFTId": "data-nft-uuid",
      "quantity": 1,
      "dataNFT": {
        "id": "data-nft-uuid",
        "name": "数据资产包名称",
        "price": 99.99,
        "image": "/assets/nfts/xxx.jpg",
        "merchant": {
          "id": "merchant-uuid",
          "name": "商家名称",
          "avatar": "/assets/avatars/xxx.jpg"
        },
        ...
      },
      "createdAt": "2025-11-24T10:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 10,
    "page": 1,
    "limit": 10,
    "pages": 1
  }
}
```

---

### 5. 获取我的销售情况

获取当前商家已发布的所有 DataNFT 及其销售数据。

```
GET /api/nft-market/my-sales
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": [
    {
      "nftId": "data-nft-uuid",
      "title": "数据资产包名称",
      "coverImage": "/assets/nfts/xxx.jpg",
      "sales": 25,
      "revenue": 2499.75
    }
  ]
}
```

**字段说明**:
- `sales`: 销量（购买次数）
- `revenue`: 总收入（销量 × 单价）

---

## 💰 交易与余额 API

### 1. 获取余额

获取当前商家的账户余额。

```
GET /api/transactions/balance
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "balance": 5000.00,
    "currency": "USDT",
    "lastUpdated": "2025-11-24T10:00:00.000Z"
  }
}
```

**注意**: 
- 余额 = 所有已完成的充值 - 所有已完成的提现
- 只有 `status: 'COMPLETED'` 的交易才会计入余额

---

### 2. 获取交易记录

获取当前商家的所有交易记录。

```
GET /api/transactions?page=1&limit=10&type=DEPOSIT&status=COMPLETED
```

**查询参数**:
| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | number | 页码（默认 1） |
| `limit` | number | 每页数量（默认 10） |
| `type` | string | 交易类型：`DEPOSIT`（充值）或 `WITHDRAW`（提现） |
| `status` | string | 交易状态：`PENDING`、`COMPLETED`、`FAILED` |

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "transactions": [
      {
        "id": "tx-uuid",
        "amount": 100.00,
        "type": "DEPOSIT",
        "status": "COMPLETED",
        "description": "DataNFT sale: 数据资产包名称 (Purchase #1, quantity: 1)",
        "userId": "merchant-uuid",
        "metadata": {
          "dataNFTId": "data-nft-uuid",
          "buyerId": "buyer-uuid",
          "purchaseCount": 1,
          "quantity": 1
        },
        "createdAt": "2025-11-24T10:00:00.000Z",
        "updatedAt": "2025-11-24T10:00:00.000Z"
      }
    ],
    "pagination": {
      "total": 50,
      "page": 1,
      "limit": 10,
      "pages": 5
    }
  }
}
```

**交易类型说明**:
- `DEPOSIT`: 充值/收入（DataNFT 销售、手动充值等）
- `WITHDRAW`: 提现/支出（购买 DataNFT、手动提现等）

**交易状态说明**:
- `PENDING`: 待处理
- `COMPLETED`: 已完成
- `FAILED`: 失败

---

### 3. 创建充值交易

创建一笔充值交易（通常由管理员操作）。

```
POST /api/transactions/deposit
```

**请求体**:
```json
{
  "amount": 1000.00,
  "description": "手动充值"
}
```

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "tx-uuid",
    "amount": 1000.00,
    "type": "DEPOSIT",
    "status": "PENDING",
    "description": "手动充值",
    "userId": "merchant-uuid",
    "createdAt": "2025-11-24T10:00:00.000Z"
  }
}
```

---

### 4. 创建提现交易

创建一笔提现交易。

```
POST /api/transactions/withdraw
```

**请求体**:
```json
{
  "amount": 500.00,
  "description": "提现到银行账户"
}
```

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "tx-uuid",
    "amount": 500.00,
    "type": "WITHDRAW",
    "status": "PENDING",
    "description": "提现到银行账户",
    "userId": "merchant-uuid",
    "createdAt": "2025-11-24T10:00:00.000Z"
  }
}
```

**错误响应**:
- `400 Bad Request`: 余额不足

---

### 5. 更新交易状态

更新交易状态（通常由管理员操作）。

```
PATCH /api/transactions/{id}/status
```

**请求体**:
```json
{
  "status": "COMPLETED"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "tx-uuid",
    "status": "COMPLETED",
    ...
  }
}
```

**注意**: 只有状态为 `COMPLETED` 的交易才会影响余额。

---

## ⛓️ 区块链相关 API

### 1. 获取 DDC NFT Metadata

获取指定 Token ID 的 DDC NFT 元数据。

```
GET /api/metadata/ddcnft/{tokenId}
```

**路径参数**:
- `tokenId` (number): Token ID（当前支持 `1`, `2`, 以及已上链的 DataNFT token ID）

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "name": "DDC NFT #3",
    "description": "DataDance Chain NFT Token #3",
    "image": "https://api.datadance.ai/metadata/ddcnft/3/image",
    "external_url": "https://api.datadance.ai/metadata/ddcnft/3",
    "attributes": [
      {
        "trait_type": "Token ID",
        "value": "3"
      },
      {
        "trait_type": "Contract Address",
        "value": "0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2"
      },
      {
        "trait_type": "Key Hash",
        "value": "0x0fa48222cf2df620b509b72b7fdc2119833dc7538ecdb07173d84174d095692d"
      }
    ]
  }
}
```

---

### 2. 获取支持的 Token IDs

获取所有支持的 Token IDs 和配置信息。

```
GET /api/metadata/ddcnft/list/supported
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "supportedTokenIds": [1, 2],
    "contractAddress": "0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2",
    "baseUrl": "https://api.datadance.ai/metadata/ddcnft",
    "keyHash": "0x0fa48222cf2df620b509b72b7fdc2119833dc7538ecdb07173d84174d095692d"
  }
}
```

**注意**: 
- 当前系统支持的 Token IDs 包括预定义的 `1`, `2`，以及所有已上链的 DataNFT token ID
- 已上链的 DataNFT 可以通过 `blockchainTokenId` 字段查询其链上 metadata

---

## 📸 快照管理 API

### 1. 创建快照

从活动创建快照。

```
POST /api/snapshots
```

**请求体**:
```json
{
  "name": "快照名称",
  "activityId": "activity-uuid",
  "description": "快照描述",
  "tags": ["tag-uuid-1", "tag-uuid-2"]
}
```

**响应** (201 Created):
```json
{
  "id": "snapshot-uuid",
  "name": "快照名称",
  "description": "快照描述",
  "activityId": "activity-uuid",
  "merchantId": "merchant-uuid",
  "createdAt": "2025-11-24T10:00:00.000Z"
}
```

---

### 2. 获取快照列表

获取当前商家的所有快照。

```
GET /api/snapshots?page=1&limit=10
```

**查询参数**:
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | 1 | 页码 |
| `limit` | number | 10 | 每页数量 |

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "snapshots": [
      {
        "id": "snapshot-uuid",
        "name": "快照名称",
        "description": "快照描述",
        "activityId": "activity-uuid",
        "merchantId": "merchant-uuid",
        "createdAt": "2025-11-24T10:00:00.000Z"
      }
    ],
    "total": 20,
    "page": 1,
    "totalPages": 2
  }
}
```

---

### 3. 获取单个快照

```
GET /api/snapshots/{id}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "snapshot-uuid",
    "name": "快照名称",
    "description": "快照描述",
    "activityId": "activity-uuid",
    "merchantId": "merchant-uuid",
    "activity": {
      "id": "activity-uuid",
      "name": "活动名称"
    },
    "createdAt": "2025-11-24T10:00:00.000Z"
  }
}
```

---

### 4. 更新快照

```
PUT /api/snapshots/{id}
```

**请求体**:
```json
{
  "name": "新名称",
  "description": "新描述",
  "tags": ["tag-uuid-1", "tag-uuid-2"]
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "snapshot-uuid",
    "name": "新名称",
    ...
  }
}
```

---

### 5. 删除快照

```
DELETE /api/snapshots/{id}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "Snapshot deleted successfully"
}
```

---

### 6. 按活动获取快照

```
GET /api/snapshots/activity/{activityId}?page=1&limit=10
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "snapshots": [...],
    "total": 10,
    "page": 1,
    "totalPages": 1
  }
}
```

---

### 7. 按商家获取快照

```
GET /api/snapshots/merchant/{merchantId}?page=1&limit=10
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "snapshots": [...],
    "total": 10,
    "page": 1,
    "totalPages": 1
  }
}
```

---

### 8. 从 CSV 上传创建快照

```
POST /api/snapshots/upload-csv
```

**请求头**:
- `Authorization: Bearer <token>`
- `Content-Type: multipart/form-data`

**请求体** (multipart/form-data):
| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `file` | file | ✅ | CSV 文件 |
| `name` | string | ✅ | 快照名称 |
| `description` | string | ❌ | 描述 |
| `activityId` | string | ❌ | 关联的活动 ID |

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "snapshot-uuid",
    "name": "快照名称",
    ...
  }
}
```

---

## 🏷️ 标签管理 API

### 1. 获取所有标签

```
GET /api/tags
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": [
    {
      "id": "tag-uuid",
      "name": "标签名称",
      "createdAt": "2025-11-24T10:00:00.000Z"
    }
  ]
}
```

---

### 2. 创建标签

```
POST /api/tags
```

**请求体**:
```json
{
  "name": "新标签"
}
```

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "tag-uuid",
    "name": "新标签",
    "createdAt": "2025-11-24T10:00:00.000Z"
  }
}
```

---

## 📝 重要说明

### 1. 数据来源类型

DataNFT 有两种数据来源：

- **`snapshot`**: 来自活动快照的数据
  - 通过合并快照创建
  - `size` 从快照的 `claims` 计算（去重后的用户数）
  
- **`upload`**: 直接上传的数据包
  - 通过 CSV 导入脚本创建
  - `size` 从 `dataRecords.recordCount` 获取

### 2. 区块链集成

- DataNFT 上链后会在数据库中记录：
  - `blockchainTokenId`: 链上 Token ID（自增，唯一）
  - `blockchainTxHash`: 链上交易哈希
  - `blockchainRecordedAt`: 上链时间

- 上链操作由后端脚本完成，前端无需处理

### 3. 权限要求

- 所有 API 都需要 JWT 认证
- 交易相关 API 需要组织用户权限（`isOrganization: true`）
- DataNFT 的创建、更新、删除、发布操作只能由创建者（merchant）执行

### 4. 分页说明

所有支持分页的 API 都使用以下格式：

**请求**: `?page=1&limit=10`

**响应**:
```json
{
  "pagination": {
    "total": 100,
    "page": 1,
    "limit": 10,
    "pages": 10
  }
}
```

### 5. 错误处理

所有错误响应都遵循统一格式：

```json
{
  "status": "fail" | "error",
  "code": "ERROR_CODE",
  "message": "错误描述"
}
```

常见 HTTP 状态码：
- `200 OK`: 成功
- `201 Created`: 创建成功
- `204 No Content`: 删除成功
- `400 Bad Request`: 请求参数错误
- `401 Unauthorized`: 未认证或 token 无效
- `403 Forbidden`: 无权限
- `404 Not Found`: 资源不存在
- `500 Internal Server Error`: 服务器错误

---

## 🔗 相关文档

- [完整 API 文档](../api-doc.md)
- [数据包架构说明](./DATA_PACK_ARCHITECTURE.md)
- [DDC NFT Metadata API](./DDC_NFT_METADATA_API.md)
- [服务器数据包设置指南](./SERVER_DATA_PACK_SETUP.md)

---

**最后更新**: 2025-11-24  
**维护者**: DataDance Backend Team








