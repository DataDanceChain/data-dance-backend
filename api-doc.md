# Data Dance API 文档

## 基础信息

- **基础URL**: `http://localhost:3000/api`
- **认证方式**: Bearer Token
- **内容类型**: application/json

## 目录

1. [认证 API](#认证-api)
2. [用户 API](#用户-api)
3. [活动 API](#活动-api)
4. [资产 API](#资产-api)
5. [通知 API](#通知-api)
6. [NFT 数据市场 API](#nft-数据市场-api)
7. [Data NFT 快照与市场 API（新版）](#data-nft-快照与市场-api)
8. [Promotions API](#promotions-api)
9. [Award System API](#award-system-api)
10. [组织交易 API](#组织交易-api)
11. [Pass API](#pass-api)
12. [X API](#x-api)
13. [Crawler API](#crawler-api)

## 测试账号
为了方便测试，我们提供了一个测试账号，可以使用账号密码登录：
- 邮箱：test@example.com
- 密码：password123

该账号可以绕过 Web3Auth 的限制，直接使用账号密码登录，并返回 token。

## 认证 API

### 用户注册

```
POST /api/auth/register
```

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "User Name"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "token": " <token>",
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "User Name"
    }
  }
}
```

### 用户登录

```
POST /api/auth/login
```

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "token": " <token>",
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "User Name",
      "isOrganization": false
    }
  }
}
```

### 通过钱包地址注册/登录

```
POST /api/auth/register-with-wallet
```

**请求体**:
```json
{
  "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "chainId": 1,
  "signature": "0x...", // 钱包签名
  "message": "Sign this message to verify your wallet ownership" // 签名的消息
}
```

**响应** (200 OK 或 201 Created):
```json
{
  "status": "success",
  "data": {
    "token": " <token>",
    "user": {
      "id": "user-uuid",
      "email": "0x1234567890abcdef1234567890abcdef12345678@wallet.user",
      "name": "User_123456",
      "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
      "chainId": 1
    }
  }
}
```

### Web3Auth 登录

```
POST /api/auth/web3auth-login
```

**请求体**:
```json
{
  "userInfo": {
    "email": "user@example.com",
    "name": "User Name",
    "profileImage": "https://example.com/avatar.jpg"
  },
  "walletAddress": "0x1234567890abcdef1234567890abcdef12345678", // 可选，钱包登录时必填
  "xid": "123456789", // 可选，X 渠道登录时必填
  "xUsername": "username", // 可选，X 渠道登录时通常会提供
  "xAccessToken": "access_token", // 可选，X 渠道登录时如果有 token 可以传入
  "xRefreshToken": "refresh_token", // 可选，X 渠道登录时如果有 refresh token 可以传入
  "invitationCode": "REF-ABCD1234" // 可选，新用户注册时可提供邀请码
}
```

**说明**:
- `invitationCode`: 用于记录谁邀请了新用户，而不是生成新用户的邀请码。每个用户都会由后端自动生成一个唯一的邀请码（格式为 `DD-{cuid}`）。
- `xAccessToken` 和 `xRefreshToken`: 这两个字段是可选的，用于存储 X 账号的访问令牌。如果前端在 X 登录时获取到这些令牌，可以传入；如果没有，可以不传，后端会正常处理。

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "token": "<jwt_token>",
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "User Name",
      "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
      "xid": "123456789",
      "xUsername": "username",
      "isOrganization": false
    },
    "invitationStatus": {
      "success": true,
      "code": "REFERRAL_SUCCESSFUL",
      "message": "邀请关系已成功记录。"
    }
  }
}
```

**Error Responses**

400 Bad Request - missing authentication credential:
```json
{
  "status": "fail",
  "code": "MISSING_CREDENTIAL",
  "message": "Missing authentication credential"
}
```

409 Conflict - X account already bound to another user:
```json
{
  "status": "error",
  "code": "X_ACCOUNT_ALREADY_BOUND",
  "message": "This X account is already bound to another user",
  "details": {
    "toUserId": "conflicting-user-id",
    "boundAt": "2025-05-16T..."
  }
}
```

500 Internal Server Error - generic server error:
```json
{
  "status": "error",
  "code": "SERVER_ERROR",
  "message": "Internal server error"
}
```

## 用户 API

### 获取当前用户信息

```
GET /api/users/me
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "User Name",
      "avatar": "/assets/avatars/default.png",
      "isOrganization": false,
      "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
      "xid": "1234567890", // X (Twitter) User ID, 可为null
      "xUsername": "twitter_handle" // X (Twitter) username, 可为null
    }
  }
}
```

### 更新用户信息

```
PATCH /api/users/me
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "name": "Updated Name",
  "avatar": "/assets/avatars/new-avatar.png"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "Updated Name",
      "avatar": "/assets/avatars/new-avatar.png",
      "isOrganization": false,
      "walletAddress": "0x1234567890abcdef1234567890abcdef12345678"
    }
  }
}
```

### 更新用户密码

```
PUT /api/users/password
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**请求体**:
```json
{
  "currentPassword": "oldPassword123",
  "newPassword": "newPassword123"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "密码已更新"
}
```

**错误响应** (401 Unauthorized):
```json
{
  "status": "fail",
  "message": "当前密码不正确"
}
```

**错误响应** (403 Forbidden):
```json
{
  "status": "fail",
  "message": "只有组织用户可以修改密码"
}
```

**说明**:
- 此接口仅限组织用户使用
- 普通用户（regular user）使用 Web3Auth 登录，不需要也不应该使用密码
- 需要提供当前密码以验证身份
- 新密码会被加密存储

### 获取用户积分信息

```
GET /api/users/points
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "totalPoints": 1250,
    "history": [
      {
        "id": "transaction-uuid",
        "amount": 100,
        "description": "Activity participation reward",
        "createdAt": "2023-06-01T12:00:00.000Z"
      }
    ]
  }
}
```

### 更新用户钱包地址

```
PUT /api/users/wallet
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "chainId": 1
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "钱包地址已更新",
  "data": {
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "User Name",
      "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
      "chainId": 1
    }
  }
}
```

### 导入钱包私钥

```
POST /api/users/wallet/import
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "privateKey": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "钱包已导入",
  "data": {
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "User Name",
      "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
      "chainId": 1
    }
  }
}
```

### Get User's Referral Code

```
GET /api/users/referral-code
```

**Request Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": { "code": "REF-ABCD1234" }
}
```

### 获取当前用户注册时间

```
GET /api/users/registered-at
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": { "registeredAt": "2025-01-15T08:30:00.000Z" }
}
```

## 活动 API

### 获取活动列表

```
GET /api/activities
```

**请求头**:
```
Authorization: Bearer <token>
```

**查询参数**:
- `category`: 活动分类ID
- `search`: 搜索关键词
- `page`: 页码 (默认为1)
- `limit`: 每页数量 (默认为10)
- `isPromoted`: 是否只返回推广活动 (true/false)

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "activities": [
      {
        "id": "yacht-club-membership",
        "title": "Elite Yacht Club Membership NFT Limited Sale",
        "description": "Elite Yacht Club membership benefits...",
        "image": "/assets/nfts/yacht-club.png",
        "startDate": "2025-02-19T00:00:00.000Z",
        "endDate": "2025-03-19T00:00:00.000Z",
        "type": "MEMBERSHIP",
        "remaining": 100,
        "total": 100,
        "statusNote": "Limited edition, while supplies last",
        "price": 0.1,
        "isPromoted": true,
        "promotionInfo": {
          "selectedDataNfts": [
            {
              "id": "data-nft-uuid",
              "name": "数据资产包名称",
              "isOwned": true
            },
            {
              "id": "data-nft-uuid-2",
              "name": "数据资产包名称",
              "isOwned": false,
              "quantity": 1
            }
          ]
        },
        "nft": {
          "name": "Elite Yacht Club Membership",
          "description": "This NFT grants you exclusive access to Elite Yacht Club facilities and events.",
          "image": "/assets/nfts/yacht-club.png",
          "totalSupply": 100,
          "price": 0.1,
          "validityStart": "2025-02-19T00:00:00.000Z",
          "validityEnd": "2026-02-19T00:00:00.000Z",
          "usageRules": "This NFT can be used to access all Elite Yacht Club facilities and events."
        },
        "isClaimed": false,
        "creator": {
          "id": "org-uuid",
          "name": "Yacht Club",
          "logo": "/assets/logos/yacht-club.png",
          "isOrganization": true
        },
        "categories": [
          {
            "id": "category-uuid",
            "name": "Luxury"
          }
        ],
        "tags": [
          {
            "id": "tag-uuid",
            "name": "Membership"
          }
        ]
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 50,
      "pages": 5
    }
  }
}
```

### 获取单个活动详情

```
GET /api/activities/{activityId}
```

**响应** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "yacht-club-membership",
    "title": "Elite Yacht Club Membership NFT Limited Sale",
    "description": "Elite Yacht Club membership benefits...",
    "image": "/assets/nfts/yacht-club.png",
    "startDate": "2025-02-19T00:00:00.000Z",
    "endDate": "2025-03-19T00:00:00.000Z",
    "type": "MEMBERSHIP",
    "remaining": 100,
    "total": 100,
    "statusNote": "Limited edition, while supplies last",
    "claimed": true,
    "isPromoted": true,
    "promotionInfo": {
      "selectedDataNfts": [
        {
          "id": "data-nft-uuid",
          "name": "数据资产包名称",
          "isOwned": true
        },
        {
          "id": "data-nft-uuid-2",
          "name": "数据资产包名称",
          "isOwned": false,
          "quantity": 1
        }
      ]
    },
    "equityTitle": "EQUITY & BENEFITS",
    "equityDetails": [
      "60 hours of private yacht usage",
      "Free participation in elite gatherings",
      "Exclusive access to 2F VIP member area",
      "Cigar room usage without minimum consumption"
    ],
    "externalLinksTitle": "EXTERNAL LINKS",
    "externalLinks": [
      {
        "name": "Event Details",
        "url": "Event related link"
      }
    ],
    "nftName": "Elite Yacht Club Membership NFT",
    "nftDescription": "Enjoy top-tier club membership benefits, limited to 100 units",
    "nftImage": "/assets/nfts/yacht-club.png",
    "nftTotalSupply": 100,
    "nftPrice": 38888.00,
    "nftValidityStart": "2025-02-19T00:00:00.000Z",
    "nftValidityEnd": "2025-03-19T00:00:00.000Z",
    "nftUsageRules": "This NFT is only for the holder to redeem membership benefits. Final interpretation rights belong to the Elite Yacht Club.",
    "creator": {
      "id": "org-uuid",
      "name": "Yacht Club",
      "logo": "/assets/logos/yacht-club.png",
      "description": "Official organization for Yacht Club",
      "isOrganization": true
    },
    "categories": [
      {
        "id": "category-uuid",
        "name": "Luxury"
      }
    ],
    "tags": [
      {
        "id": "tag-uuid",
        "name": "Membership"
      }
    ]
  }
}
```

**说明**:
- `isPromoted`: 标识该活动是否为推广活动
- `promotionInfo`: 当 `isPromoted` 为 true 时，包含推广相关的信息
  - `selectedDataNfts`: 推广活动关联的数据资产列表
    - `isOwned`: 标识当前用户是否拥有该数据资产
    - `quantity`: 当 `isOwned` 为 false 时，表示需要购买的数量

### 获取推荐活动

```
GET /api/activities/featured
```

**响应** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "yacht-club-membership",
      "title": "Elite Yacht Club Membership NFT Limited Sale",
      "description": "Elite Yacht Club membership benefits...",
      "image": "/assets/nfts/yacht-club.png",
      "startDate": "2025-02-19T00:00:00.000Z",
      "endDate": "2025-03-19T00:00:00.000Z",
      "type": "MEMBERSHIP",
      "creator": {
        "id": "org-uuid",
        "name": "Yacht Club",
        "logo": "/assets/logos/yacht-club.png"
      }
    }
  ]
}
```

### 领取活动

```
POST /api/activities/{activityId}/claim
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "claim": {
      "id": "claim-uuid",
      "userId": "user-uuid",
      "activityId": "yacht-club-membership",
      "status": "CLAIMED",
      "claimedAt": "2023-06-01T12:00:00.000Z"
    }
  }
}
```

### 获取用户已领取的活动

```
GET /api/activities/claimed
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "yacht-club-membership",
      "title": "Elite Yacht Club Membership NFT Limited Sale",
      "description": "Elite Yacht Club membership benefits...",
      "image": "/assets/nfts/yacht-club.png",
      "startDate": "2025-02-19T00:00:00.000Z",
      "endDate": "2025-03-19T00:00:00.000Z",
      "type": "MEMBERSHIP",
      "remaining": 100,
      "total": 100,
      "statusNote": "Limited edition, while supplies last",
      "claimedAt": "2023-06-01T12:00:00.000Z",
      "status": "CLAIMED",
      "creator": {
        "id": "org-uuid",
        "name": "Yacht Club",
        "logo": "/assets/logos/yacht-club.png",
        "isOrganization": true
      },
      "categories": [
        {
          "id": "category-uuid",
          "name": "Luxury"
        }
      ],
      "tags": [
        {
          "id": "tag-uuid",
          "name": "Membership"
        }
      ]
    }
  ]
}
```

### 获取用户已领取的活动（通过过滤活动表）

```
GET /api/activities/user-claimed
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "yacht-club-membership",
      "title": "Elite Yacht Club Membership NFT Limited Sale",
      "description": "Elite Yacht Club membership benefits...",
      "image": "/assets/nfts/yacht-club.png",
      "startDate": "2025-02-19T00:00:00.000Z",
      "endDate": "2025-03-19T00:00:00.000Z",
      "type": "MEMBERSHIP",
      "remaining": 100,
      "total": 100,
      "statusNote": "Limited edition, while supplies last",
      "claimedAt": "2023-06-01T12:00:00.000Z",
      "status": "CLAIMED",
      "creator": {
        "id": "org-uuid",
        "name": "Yacht Club",
        "logo": "/assets/logos/yacht-club.png",
        "isOrganization": true
      },
      "categories": [
        {
          "id": "category-uuid",
          "name": "Luxury"
        }
      ],
      "tags": [
        {
          "id": "tag-uuid",
          "name": "Membership"
        }
      ]
    }
  ]
}
```

### 更新活动合约信息

```
PATCH /api/activities/:id/contract
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "chainId": 1,
  "tokenStandard": "ERC721"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "活动合约信息已更新",
  "data": {
    "activity": {
      "id": "activity-uuid",
      "title": "活动标题",
      "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
      "chainId": 1,
      "tokenStandard": "ERC721"
    }
  }
}
```

### 部署活动合约

```
POST /api/activities/:id/deploy-contract
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "活动合约已部署",
  "data": {
    "activity": {
      "id": "activity-uuid",
      "title": "活动标题",
      "contractAddress": "0x1234567890abcdef1234567890abcdef12345678",
      "chainId": 1,
      "tokenStandard": "ERC721"
    }
  }
}
```

### 获取我创建的活动

```
GET /api/activities/created-by-me
```

**请求头**:
```
Authorization: Bearer <token>
```

**说明**:
- 仅返回当前登录用户（组织/商家）作为创建者（creator）的所有活动。
- 适用于商家后台活动管理页面。

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "activities": [
      {
        "id": "activity-uuid",
        "title": "Activity Title",
        "description": "Activity description...",
        "image": "/assets/nfts/yacht-club.png",
        "startDate": "2025-02-19T00:00:00.000Z",
        "endDate": "2025-03-19T00:00:00.000Z",
        "type": "MEMBERSHIP",
        "remaining": 100,
        "total": 100,
        "statusNote": "Limited edition, while supplies last",
        "price": 0.1,
        "nft": { /* ... */ },
        "isClaimed": false,
        "creator": {
          "id": "org-uuid",
          "name": "Yacht Club",
          "logo": "/assets/logos/yacht-club.png",
          "isOrganization": true
        },
        "categories": [
          { "id": "category-uuid", "name": "Luxury" }
        ],
        "tags": [
          { "id": "tag-uuid", "name": "Membership" }
        ]
      }
      // ...更多活动
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 2,
      "pages": 1
    }
  }
}
```

**状态码说明**:
- `200 OK`: 请求成功，返回当前组织/商家发起的活动列表
- `401 Unauthorized`: 未登录或 token 无效
- `403 Forbidden`: 权限不足（非组织/商家用户）

**接口说明**:
- 该接口根据当前登录用户的 token 自动筛选，只返回该用户（组织/商家）创建的活动。
- 支持分页、搜索等参数（如有需要可补充）。

### 创建新活动

```
POST /api/activities/new
```

**请求头**:
```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**请求体**（multipart/form-data，支持图片上传）：
| 字段名           | 类型         | 说明                       |
|------------------|--------------|----------------------------|
| title            | string       | 活动标题                   |
| description      | string       | 活动描述                   |
| startDate        | string/date  | 开始时间（ISO字符串）      |
| endDate          | string/date  | 结束时间（ISO字符串）      |
| type             | string       | 活动类型（如 MEMBERSHIP）  |
| total            | int          | 总量                       |
| remaining        | int          | 剩余                       |
| statusNote       | string       | 状态说明                   |
| price            | float        | NFT价格                    |
| nftName          | string       | NFT名称                    |
| nftDescription   | string       | NFT描述                    |
| nftTotalSupply   | int          | NFT总量                    |
| nftUsageRules    | string       | NFT使用规则                |
| nftValidityStart | string/date  | NFT有效期开始              |
| nftValidityEnd   | string/date  | NFT有效期结束              |
| equityTitle      | string       | 权益标题                   |
| equityDetails    | string[]     | 权益详情（可多选）         |
| externalLinksTitle | string     | 外链标题                   |
| externalLinks    | json/string  | 外链（JSON字符串）         |
| showInExplore    | boolean      | 是否在探索页展示           |
| isPromoted       | boolean      | 是否为推广活动             |
| dataNfts         | json/string  | 推广活动关联的数据资产列表 |
| categories       | string[]     | 分类ID数组                 |
| tags             | string[]     | 标签ID数组                 |
| logo             | file         | 组织logo图片（图片文件）    |
| nft              | file         | NFT图片（图片文件）        |
| banner           | file         | Banner图片（图片文件）     |

**说明**：
- 图片字段需用 `FormData` 上传，字段名分别为 `logo`、`nft`、`banner`。
- 其他字段为普通表单字段。
- 图片会自动存储到 `/assets/logos/`、`/assets/nfts/`、`/assets/banners/`，返回图片路径。
- `isPromoted` 字段用于标识是否为推广活动。
- `dataNfts` 字段为 JSON 字符串，格式如下：
```json
[
{
    "id": "data-nft-uuid",
    "isOwned": true
  },
  {
    "id": "data-nft-uuid-2",
    "isOwned": false,
    "quantity": 1
}
]
```

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
      "id": "activity-uuid",
      "title": "Elite Yacht Club Membership NFT Limited Sale",
      "description": "Elite Yacht Club membership benefits...",
    "logo": "/assets/logos/xxx.jpg",
    "nftImage": "/assets/nfts/xxx.jpg",
    "image": "/assets/banners/xxx.jpg",
      "startDate": "2025-02-19T00:00:00.000Z",
      "endDate": "2025-03-19T00:00:00.000Z",
      "type": "MEMBERSHIP",
      "remaining": 100,
      "total": 100,
      "price": 0.1,
    "isPromoted": true,
    "promotionInfo": {
      "dataNfts": [
        {
          "id": "data-nft-uuid",
          "name": "数据资产包名称",
          "isOwned": true
        },
        {
          "id": "data-nft-uuid-2",
          "name": "数据资产包名称",
          "isOwned": false,
          "quantity": 1
        }
      ]
    },
    ... // 其他字段
  }
}
```

**错误响应** (400 Bad Request):
```json
{
  "status": "fail",
  "message": "Invalid request parameters"
}
```

**字段说明**:
- `logo`：组织logo图片路径
- `nftImage`：NFT图片路径
- `image`：Banner图片路径
- `isPromoted`：是否为推广活动
- `promotionInfo`：推广活动相关信息，包含关联的数据资产列表
- 其他字段同上

### Tag Management API

#### Get All Tags

```
GET /api/tags
```

**Request Headers:**
- (optional) Authorization: Bearer <token>

**Response** (200 OK):
```json
{
  "status": "success",
  "data": [
    { "id": "tag-uuid-1", "name": "Sports & Fitness" },
    { "id": "tag-uuid-2", "name": "Music & Entertainment" }
    // ...
  ]
}
```

---

#### Create a New Tag

```
POST /api/tags
```

**Request Headers:**
- Authorization: Bearer <token>
- Content-Type: application/json

**Request Body:**
```json
{
  "name": "Blockchain"
}
```

**Response** (201 Created):
```json
{
  "status": "success",
  "data": { "id": "tag-uuid-3", "name": "Blockchain" }
}
```

**Error Response** (400 Bad Request):
```json
{
  "status": "fail",
  "message": "Tag already exists"
}
```

---

#### Associate Tags with an Activity

```
POST /api/activities/:id/tags
```

**Request Headers:**
- Authorization: Bearer <token>
- Content-Type: application/json

**Request Body:**
```json
{
  "tags": ["tag-uuid-1", "tag-uuid-3"]
}
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": [
    { "id": "tag-uuid-1", "name": "Sports & Fitness" },
    { "id": "tag-uuid-3", "name": "Blockchain" }
  ]
}
```

**Error Response** (400 Bad Request):
```json
{
  "status": "fail",
  "message": "Invalid tag IDs"
}
```

---

#### Activity Object Tag Field

- In all activity GET/list responses, the `tags` field should be an array of tag objects or tag IDs, e.g.:

```json
{
  "id": "activity-uuid",
  "title": "Activity Title",
  ...
  "tags": [
    { "id": "tag-uuid-1", "name": "Sports & Fitness" },
    { "id": "tag-uuid-3", "name": "Blockchain" }
  ]
}
```

**Field Explanation:**
- `id`: Tag unique ID
- `name`: Tag name (string)

## 资产 API

### 获取资产总览

```
GET /api/assets
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "points": {
      "total": 1250,
      "recentTransactions": [
        {
          "id": "transaction-uuid",
          "amount": 100,
          "description": "Activity participation reward",
          "createdAt": "2023-06-01T12:00:00.000Z"
        }
      ]
    },
    "badges": {
      "total": 5,
      "recent": [
        {
          "id": "badge-uuid",
          "name": "Yacht Club Badge",
          "image": "/assets/badges/yacht-club.png"
        }
      ]
    }
  }
}
```

### 获取积分

```
GET /api/assets/points
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "total": 1250,
    "transactions": [
      {
        "id": "transaction-uuid",
        "amount": 100,
        "description": "Activity participation reward",
        "createdAt": "2023-06-01T12:00:00.000Z"
      }
    ]
  }
}
```

### 获取徽章列表

```
GET /api/assets/badges
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "collected": [
      {
        "id": "badge-uuid",
        "name": "Yacht Club Badge",
        "description": "Official badge for Yacht Club",
        "image": "/assets/badges/yacht-club.png",
        "creator": {
          "id": "creator-uuid",
          "name": "Yacht Club",
          "isOrganization": true
        },
        "acquiredAt": "2023-06-01T12:00:00.000Z"
      }
    ],
    "uncollected": [
      {
        "id": "badge-uuid-2",
        "name": "Mercedes Badge",
        "description": "Official badge for Mercedes",
        "image": "/assets/badges/mercedes-logo.png",
        "creator": {
          "id": "creator-uuid-2",
          "name": "Mercedes",
          "isOrganization": true
        }
      }
    ]
  }
}
```

### 获取徽章详情

```
GET /api/assets/badges/{badgeId}
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "badge-uuid",
    "name": "Yacht Club Badge",
    "description": "Official badge for Yacht Club",
    "image": "/assets/badges/yacht-club.png",
    "creator": {
      "id": "creator-uuid",
      "name": "Yacht Club",
      "isOrganization": true
    },
    "isCollected": true,
    "acquiredAt": "2023-06-01T12:00:00.000Z"
  }
}
```

### 收集徽章

```
POST /api/assets/badges/{badgeId}/collect
```

**请求头**:
```Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "Badge collected successfully",
  "data": {
    "id": "badge-uuid",
    "name": "Yacht Club Badge",
    "description": "Official badge for Yacht Club",
    "image": "/assets/badges/yacht-club.png",
    "creator": {
      "id": "creator-uuid",
      "name": "Yacht Club",
      "isOrganization": true
    },
    "acquiredAt": "2023-06-01T12:00:00.000Z"
  }
}
```

### 获取交易记录

```
GET /api/assets/transactions
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": [
    {
      "id": "transaction-uuid",
      "type": "POINT_EARNED",
      "amount": 100,
      "description": "Activity participation reward",
      "createdAt": "2023-06-01T12:00:00.000Z"
    },
    {
      "id": "transaction-uuid-2",
      "type": "BADGE_ACQUIRED",
      "assetId": "badge-uuid",
      "description": "Collected badge: Yacht Club Badge",
      "createdAt": "2023-06-01T12:00:00.000Z"
    }
  ]
}
```

**说明**:
- 此接口返回用户的所有资产交易记录
- 交易类型包括但不限于：
  - `POINT_EARNED`: 积分获取
  - `BADGE_ACQUIRED`: 徽章获取
  - `NFT_PURCHASED`: NFT 购买
  - `NFT_SOLD`: NFT 出售
- 返回最近的 50 条交易记录
- 按时间倒序排列

### 生成Apple Wallet Pass

```
POST /assets/passes/generate
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**请求体**:
```json
{
  "creatorId": "creator-uuid",
  "creatorName": "Creator Name",
  "creatorLogo": "/assets/logos/creator-logo.png",
  "userId": "user-uuid",
  "userName": "User Name",
  "userWalletAddress": "0x1234567890abcdef1234567890abcdef12345678"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "passUrl": "https://api.datadance.app/assets/passes/1234567890.pkpass",
    "expiresAt": "2024-12-31T23:59:59.000Z"
  }
}
```

**Pass 显示说明**:
1. Pass 背景图片（strip）会显示用户在该创作者下拥有的 NFT：
   - 单个 NFT：完整显示
   - 两个 NFT：左右平分显示
   - 三个及以上 NFT：显示最新的三个，平均分配空间
2. Pass 正面显示：
   - 创作者名称
   - 会员状态
   - 会员姓名
   - 钱包地址（简略形式）
   - NFT 总数
   - 最后铸造日期
3. Pass 背面显示：
   - 创作者名称
   - 完整钱包地址
   - NFT 列表（包含名称、类型、标签、铸造日期）
   - 有效期

**错误响应**:

**响应** (400 Bad Request):
```json
{
  "status": "fail",
  "message": "Invalid request parameters"
}
```

**响应** (500 Internal Server Error):
```json
{
  "status": "error",
  "message": "Failed to generate pass",
  "error": "Error details (only in development)"
}
```

**注意事项**:
1. Pass 有效期默认为生成日期起一年
2. NFT 图片会自动调整大小以适应显示区域
3. 所有图片资源（NFT图片、创作者logo等）必须可以通过提供的URL访问

### 获取用户的所有Pass

```
GET /assets/passes
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "passes": [
      {
        "id": "pass-uuid",
        "creatorId": "creator-uuid",
        "creatorName": "Creator Name",
        "creatorLogo": "/assets/logos/creator-logo.png",
        "passUrl": "https://api.datadance.app/assets/passes/1234567890.pkpass",
        "createdAt": "2024-03-20T12:00:00.000Z",
        "expiresAt": "2024-12-31T23:59:59.000Z"
      }
    ]
  }
}
```

### 获取单个Pass详情

```
GET /assets/passes/{passId}
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "pass-uuid",
    "creatorId": "creator-uuid",
    "creatorName": "Creator Name",
    "creatorLogo": "/assets/logos/creator-logo.png",
    "passUrl": "https://api.datadance.app/assets/passes/1234567890.pkpass",
    "createdAt": "2024-03-20T12:00:00.000Z",
    "expiresAt": "2024-12-31T23:59:59.000Z",
    "status": "active"
  }
}
```

### 更新Pass状态

```
PATCH /assets/passes/{passId}/status
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**请求体**:
```json
{
  "status": "revoked" // 可选值: "active", "revoked", "expired"
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "pass-uuid",
    "status": "revoked"
  }
}
```

### 生成 Google Wallet Pass

```
POST /assets/passes/generate
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "creatorId": "creator-uuid",
  "creatorName": "Creator Name",
  "creatorLogo": "/assets/logos/creator-logo.png",
  "userId": "user-uuid",
  "userName": "User Name",
  "userWalletAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "platform": "google" // 指定为 google 即生成 Google Wallet Pass
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "passUrl": "https://pay.google.com/gp/v/save/eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresAt": "2024-12-31T23:59:59.000Z",
    "googleObjectId": "loyalty_creator-uuid_user-uuid",
    "googleClassId": "loyalty_creator-uuid"
  }
}
```

**Google Wallet Pass 显示说明**:
1. Pass 类型为 Loyalty（会员卡），每个 creator 一个 class，每个 user/creator 组合一个 object。
2. Pass 上会显示该用户在该 creator 下的所有 NFT 信息（如 NFT 名称、铸造日期等）。
3. 用户点击 passUrl 跳转到 Google Wallet 领取页面，需在 Android 真机上操作。
4. 领取后可在 Google Wallet App 中查看。

**注意事项**:
- 生成 Google Wallet Pass 时，platform 字段必须为 "google"。
- 其余参数与 Apple Wallet Pass 一致。
- Apple Wallet Pass 默认 platform 为 "apple"，返回 .pkpass 文件下载链接。
- Google Wallet Pass 返回 passUrl 为 Google 官方领取链接。

## 通知 API

### 获取通知列表

```
GET /api/notifications
```

**请求头**:
```
Authorization: Bearer <token>
```

**查询参数**:
- `page`: 页码 (默认为1)
- `limit`: 每页数量 (默认为20)
- `unreadOnly`: 是否只返回未读通知 (true/false)

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "notifications": [
      {
        "id": "notification-uuid",
        "title": "New Badge Collected",
        "content": "Congratulations! You've earned the Yacht Club Badge from Yacht Club (Creator).",
        "type": "BADGE",
        "isRead": false,
        "createdAt": "2023-06-01T12:00:00.000Z"
      }
    ],
    "pagination": {
      "total": 5,
      "page": 1,
      "limit": 20,
      "pages": 1
    },
    "unreadCount": 3
  }
}
```

### 标记通知为已读

```
PATCH /api/notifications/{notificationId}/read
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "notification": {
      "id": "notification-uuid",
      "isRead": true
    }
  }
}
```

### 标记所有通知为已读

```
PATCH /api/notifications/read-all
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "All notifications marked as read",
  "data": {
    "updatedCount": 3
  }
}
```

## NFT 数据市场 API

### 获取市场 NFT 数据资产列表

```
GET /nft-market
```

**请求头**:
```
Authorization: Bearer <token>
```

**查询参数**:
- `tag` (可选): 标签筛选
- `search` (可选): 关键词搜索，支持 DataNFT 名称、简介、商家名称、标签名模糊匹配，结果按关联度排序

**响应** (200 OK):
```json
{
  "status": "success",
  "data": [
    {
      "id": "nft-uuid",
      "title": "数据资产名称",
      "coverImage": "/assets/nfts/cover.png",
      "owner": "组织/商家名称",
      "ownerId": "merchant-uuid",
      "ownerAvatar": "/assets/avatars/org.png",
      "size": 10000,
      "price": 2.5,
      "description": "数据资产简介"
    }
  ]
}
```

**说明**:
- 支持通过 `search` 参数对 DataNFT 名称、简介、商家名称、标签名进行模糊搜索。
- 搜索结果会按关联度（命中字段优先级：名称 > 商家名称 > 简介 > 标签）降序排列。
- 可与标签筛选（tag）同时使用。

### 获取市场 NFT 数据资产详情

```
GET /nft-market/{id}
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "nft-uuid",
    "title": "数据资产名称",
    "coverImage": "/assets/nfts/cover.png",
    "owner": "组织/商家名称",
    "ownerId": "merchant-uuid",
    "ownerAvatar": "/assets/avatars/org.png",
    "size": 10000,
    "price": 2.5,
    "description": "数据资产简介",
    "tags": ["旅游", "高净值"],
    "sales": 123,
    "revenue": 456.78
  }
}
```

### 购买市场 NFT 数据资产

```
POST /nft-market/{id}/purchase
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "quantity": 1
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "Purchase successful",
  "data": {
    "orderId": "order-uuid",
    "nftId": "nft-uuid",
    "quantity": 1,
    "price": 2.5,
    "total": 2.5,
    "purchasedAt": "2024-06-01T12:00:00.000Z"
  }
}
```

### 获取我购买的 NFT 数据资产

```
GET /nft-market/my-purchases
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": [
    {
      "orderId": "order-uuid",
      "nftId": "nft-uuid",
      "title": "数据资产名称",
      "coverImage": "/assets/nfts/cover.png",
      "quantity": 1,
      "price": 2.5,
      "total": 2.5,
      "purchasedAt": "2024-06-01T12:00:00.000Z"
    }
  ]
}
```

### 获取我发售的 NFT 数据资产及销售情况

```
GET /nft-market/my-sales
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": [
    {
      "nftId": "nft-uuid",
      "title": "数据资产名称",
      "coverImage": "/assets/nfts/cover.png",
      "sales": 123,
      "revenue": 456.78
    }
  ]
}
```

## Data NFT 快照与市场 API（新版）

### 快照（Snapshot）API

#### 创建快照
```
POST /api/snapshots
```
**请求头**: Authorization: Bearer <token>
**请求体**:
```json
{
  "name": "快照名称",
  "description": "快照描述",
  "activityId": "activity-uuid",
  "tags": ["tag-uuid-1", "tag-uuid-2"]
}
```

**字段说明**:
- `name`: 快照名称
- `description`: 快照描述（可选）
- `activityId`: 关联的活动ID
- `tags`: 标签ID数组（可选）

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "snapshot-uuid",
    "name": "快照名称",
    "description": "快照描述",
    "activityId": "activity-uuid",
    "merchantId": "merchant-uuid",
    "claims": [
      {
        "id": "claim-uuid",
        "userId": "user-uuid",
        "status": "CLAIMED",
        "claimedAt": "2024-03-20T12:00:00.000Z",
        "user": {
          "id": "user-uuid",
          "name": "User Name",
          "email": "user@example.com"
        }
      }
    ],
    "activity": {
      "id": "activity-uuid",
      "title": "活动标题"
    },
    "merchant": {
      "id": "merchant-uuid",
      "name": "商家名称"
    },
    "tags": [
      {
        "id": "tag-uuid-1",
        "name": "标签1"
      },
      {
        "id": "tag-uuid-2",
        "name": "标签2"
      }
    ],
    "createdAt": "2024-03-20T12:00:00.000Z",
    "updatedAt": "2024-03-20T12:00:00.000Z"
  }
}
```

**说明**:
- 创建快照时会自动从关联的 Activity 获取当前的 claims 信息
- claims 信息反映了创建快照时 Activity 的领取状态
- 快照创建后，claims 信息会被永久保存，不会随着 Activity 的后续变化而改变
- 只有活动的创建者（商家）可以创建快照
- 系统会自动验证 Activity 的所有权，确保只有创建者可以创建快照

#### 获取快照列表（支持分页、筛选）
```
GET /api/snapshots?page=1&limit=10&activityId=xxx&merchantId=xxx&search=xxx
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": {
    "snapshots": [ { "id": "snapshot-uuid", ... } ],
    "total": 20,
    "page": 1,
    "totalPages": 2
  }
}
```

#### 获取单个快照
```
GET /api/snapshots/{id}
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": { "id": "snapshot-uuid", ... }
}
```

#### 更新快照
```
PUT /api/snapshots/{id}
```
**请求体**:
```
{
  "name": "新名称",
  "description": "新描述",
  "tags": ["tag-uuid-1", "tag-uuid-2"]
}
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": { "id": "snapshot-uuid", ... }
}
```

#### 删除快照
```
DELETE /api/snapshots/{id}
```
**响应** (200 OK):
```
{
  "status": "success",
  "message": "Snapshot deleted successfully"
}
```

#### 按活动/商家获取快照
```
GET /api/snapshots/activity/{activityId}?page=1&limit=10
GET /api/snapshots/merchant/{merchantId}?page=1&limit=10
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": {
    "snapshots": [ { ... } ],
    "total": 10,
    "page": 1,
    "totalPages": 1
  }
}
```

---

### DataNFT API（商家侧管理）

#### 合并快照生成 DataNFT（支持图片上传）
```
POST /api/data-nfts/merge
```
**请求头**:
- Authorization: Bearer <token>
- Content-Type: multipart/form-data

**请求体**（multipart/form-data）：
| 字段名   | 类型         | 说明                                 |
|----------|--------------|--------------------------------------|
| name     | string       | 数据资产包名称                       |
| price    | float        | 价格                                 |
| image    | file/string  | 配图，支持图片文件或已有图片路径     |
| ...      | ...          | 其它字段同上                         |

- `image` 字段可上传图片文件（file），也可直接传已有图片路径（string）。
- 图片会保存到 `/assets/nfts/` 目录，返回图片路径。

**响应** (201 Created):
```json
{
  "status": "success",
  "data": { "id": "data-nft-uuid", "image": "/assets/nfts/xxx.jpg", ... }
}
```

#### 获取 DataNFT 列表（支持分页、筛选、标签）
```
GET /api/data-nfts?page=1&limit=10&search=xxx&minPrice=0&maxPrice=100&tags=tag-uuid-1,tag-uuid-2
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": {
    "data": [
      {
        "id": "data-nft-uuid",
        "name": "数据资产包名称",
        "size": 100,
        "price": 2.5,
        "image": "/assets/nfts/cover.png",
        ... // 其它字段
      }
    ],
    "pagination": {
      "total": 20,
      "page": 1,
      "limit": 10,
      "pages": 2
    }
  }
}
```

#### 获取单个 DataNFT
```
GET /api/data-nfts/{id}
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": {
    "id": "data-nft-uuid",
    "name": "数据资产包名称",
    "size": 100,
    "price": 2.5,
    "image": "/assets/nfts/cover.png",
    ... // 其它字段
  }
}
```

#### 更新 DataNFT（支持图片上传）
```
PUT /api/data-nfts/{id}
```
**请求头**:
- Authorization: Bearer <token>
- Content-Type: multipart/form-data

**请求体**（multipart/form-data）同上。

---

#### 发布/下架 DataNFT
```
POST /api/data-nfts/{id}/publish
POST /api/data-nfts/{id}/unpublish
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": { ... }
}
```

#### 购买 DataNFT
```
POST /api/data-nfts/{id}/purchase
```
**Request Headers:**
```
Authorization: Bearer <token>
```
**Request Body:**
```json
{
  "quantity": 3 // Optional, default is 1. Number of DataNFTs to purchase in this order.
}
```
**Response** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "purchase-uuid",
    "dataNFTId": "data-nft-uuid",
    "buyerId": "user-uuid",
    "quantity": 3,
    "createdAt": "2024-03-20T12:00:00.000Z",
    "dataNFT": {
      "id": "data-nft-uuid",
      "name": "Data Asset Bundle Name",
      "description": "Data asset description",
      "price": 2.5,
      "image": "/assets/nfts/cover.png",
      "snapshots": [...],
      "tags": [...]
    },
    "purchaseCount": 1
  }
}
```
**Notes:**
- You can purchase multiple DataNFTs in a single order by specifying the `quantity` field in the request body.
- The purchase record and transaction records will reflect the quantity.
- Transaction amount = price * quantity.
- After a successful purchase, transaction records are automatically generated.
- If the buyer is an organization user, an expense (WITHDRAW) transaction will be created.
- The seller (merchant) will receive an income (DEPOSIT) transaction.
- `purchaseCount` indicates how many times the current user has purchased this DataNFT (across all orders).

#### 按商家获取 DataNFT
```
GET /api/data-nfts/merchant/{merchantId}?page=1&limit=10
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": {
    "data": [ { ... } ],
    "pagination": { ... }
  }
}
```

#### 获取我已购买的 DataNFT
```
GET /api/data-nfts/purchased?page=1&limit=10
```
**响应** (200 OK):
```
{
  "status": "success",
  "data": {
    "data": [ { ... } ],
    "pagination": { ... }
  }
}
```

---

### /nft-market 说明
- `/nft-market` 相关接口为市场公开展示和购买入口，主要面向所有用户。
- `/api/data-nfts` 相关接口为商家侧管理和个人资产查询。
- 两者数据结构类似，但 `/nft-market` 只展示已发布（isPublished=true）的 DataNFT。

---

### tags 字段说明
- DataNFT、Snapshot、Activity 等对象的 `tags` 字段均为对象数组：
```
"tags": [
  { "id": "tag-uuid-1", "name": "A" },
  { "id": "tag-uuid-2", "name": "B" }
]
```

---

### 响应格式统一
所有接口响应均推荐如下格式：
```
{
  "status": "success",
  "data": ...
}
```
或分页：
```
{
  "status": "success",
  "data": {
    "data": [ ... ],
    "pagination": { ... }
  }
}
```
或删除：
```
{
  "status": "success",
  "message": "xxx"
}
```

---

> 其余原有接口文档可保留，建议在目录和相关章节补充"新版快照与DataNFT API"说明。

## Promotions API

### 获取标签相关的 DataNFT 列表

```
GET /api/promotions/data-nfts/by-tags
```

**请求头**:
```
Authorization: Bearer <token>
```

**查询参数**:
- `tags`: 标签ID数组，用逗号分隔 (例如: tag-uuid-1,tag-uuid-2)
- `page`: 页码 (默认为1)
- `limit`: 每页数量 (默认为10)

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "owned": [
      {
        "id": "data-nft-uuid",
        "name": "数据资产包名称",
        "description": "数据资产简介",
        "price": 2.5,
        "image": "/assets/nfts/cover.png",
        "isPublished": true,
        "merchant": {
          "id": "merchant-uuid",
          "name": "组织/商家名称",
          "avatar": "/assets/avatars/org.png"
        },
        "tags": [
          { "id": "tag-uuid-1", "name": "旅游" },
          { "id": "tag-uuid-2", "name": "高净值" }
        ]
      }
    ],
    "available": [
      {
        "id": "data-nft-uuid-2",
        "name": "数据资产包名称",
        "description": "数据资产简介",
        "price": 2.5,
        "image": "/assets/nfts/cover.png",
        "isPublished": true,
        "merchant": {
          "id": "merchant-uuid",
          "name": "组织/商家名称",
          "avatar": "/assets/avatars/org.png"
        },
        "tags": [
          { "id": "tag-uuid-1", "name": "旅游" },
          { "id": "tag-uuid-2", "name": "高净值" }
        ]
      }
    ],
    "pagination": {
      "total": 20,
      "page": 1,
      "limit": 10,
      "pages": 2
    }
  }
}
```

### 创建推广活动

```
POST /api/promotions
```

**请求头**:
```
Authorization: Bearer <token>
Content-Type: application/json
```

**请求体**:
```json
{
  "title": "推广活动标题",
  "description": "推广活动描述",
  "startDate": "2024-03-20T00:00:00.000Z",
  "endDate": "2024-04-20T00:00:00.000Z",
  "type": "PROMOTION",
  "total": 100,
  "remaining": 100,
  "price": 0.1,
  "selectedDataNfts": [
    {
      "id": "data-nft-uuid",
      "isOwned": true
    },
    {
      "id": "data-nft-uuid-2",
      "isOwned": false,
      "quantity": 1
    }
  ],
  "nft": {
    "name": "NFT名称",
    "description": "NFT描述",
    "totalSupply": 100,
    "price": 0.1,
    "validityStart": "2024-03-20T00:00:00.000Z",
    "validityEnd": "2024-04-20T00:00:00.000Z",
    "usageRules": "使用规则"
  }
}
```

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "promotion-uuid",
    "title": "推广活动标题",
    "description": "推广活动描述",
    "startDate": "2024-03-20T00:00:00.000Z",
    "endDate": "2024-04-20T00:00:00.000Z",
    "type": "PROMOTION",
    "total": 100,
    "remaining": 100,
    "price": 0.1,
    "isPromoted": true,
    "promotionInfo": {
      "selectedDataNfts": [
        {
          "id": "data-nft-uuid",
          "name": "数据资产包名称",
          "isOwned": true
        },
        {
          "id": "data-nft-uuid-2",
          "name": "数据资产包名称",
          "isOwned": false,
          "quantity": 1
        }
      ]
    },
    "nft": {
      "name": "NFT名称",
      "description": "NFT描述",
      "totalSupply": 100,
      "price": 0.1,
      "validityStart": "2024-03-20T00:00:00.000Z",
      "validityEnd": "2024-04-20T00:00:00.000Z",
      "usageRules": "使用规则"
    },
    "creator": {
      "id": "creator-uuid",
      "name": "创建者名称",
      "avatar": "/assets/avatars/creator.png"
    }
  }
}
```

### 获取推广活动列表

```
GET /api/promotions
```

**请求头**:
```
Authorization: Bearer <token>
```

**查询参数**:
- `page`: 页码 (默认为1)
- `limit`: 每页数量 (默认为10)
- `status`: 状态筛选 (可选: "active", "ended", "all")

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "promotions": [
      {
        "id": "promotion-uuid",
        "title": "推广活动标题",
        "description": "推广活动描述",
        "startDate": "2024-03-20T00:00:00.000Z",
        "endDate": "2024-04-20T00:00:00.000Z",
        "type": "PROMOTION",
        "total": 100,
        "remaining": 100,
        "price": 0.1,
        "isPromoted": true,
        "promotionInfo": {
          "selectedDataNfts": [
            {
              "id": "data-nft-uuid",
              "name": "数据资产包名称",
              "isOwned": true
            },
            {
              "id": "data-nft-uuid-2",
              "name": "数据资产包名称",
              "isOwned": false,
              "quantity": 1
            }
          ]
        },
        "nft": {
          "name": "NFT名称",
          "description": "NFT描述",
          "totalSupply": 100,
          "price": 0.1,
          "validityStart": "2024-03-20T00:00:00.000Z",
          "validityEnd": "2024-04-20T00:00:00.000Z",
          "usageRules": "使用规则"
        },
        "creator": {
          "id": "creator-uuid",
          "name": "创建者名称",
          "avatar": "/assets/avatars/creator.png"
        }
      }
    ],
    "pagination": {
      "total": 20,
      "page": 1,
      "limit": 10,
      "pages": 2
    }
  }
}
```

### 获取推广活动详情

```
GET /api/promotions/{id}
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "promotion-uuid",
    "title": "推广活动标题",
    "description": "推广活动描述",
    "startDate": "2024-03-20T00:00:00.000Z",
    "endDate": "2024-04-20T00:00:00.000Z",
    "type": "PROMOTION",
    "total": 100,
    "remaining": 100,
    "price": 0.1,
    "isPromoted": true,
    "promotionInfo": {
      "selectedDataNfts": [
        {
          "id": "data-nft-uuid",
          "name": "数据资产包名称",
          "isOwned": true
        },
        {
          "id": "data-nft-uuid-2",
          "name": "数据资产包名称",
          "isOwned": false,
          "quantity": 1
        }
      ]
    },
    "nft": {
      "name": "NFT名称",
      "description": "NFT描述",
      "totalSupply": 100,
      "price": 0.1,
      "validityStart": "2024-03-20T00:00:00.000Z",
      "validityEnd": "2024-04-20T00:00:00.000Z",
      "usageRules": "使用规则"
    },
    "creator": {
      "id": "creator-uuid",
      "name": "创建者名称",
      "avatar": "/assets/avatars/creator.png"
    }
  }
}
```

### 字段说明

#### 推广活动状态
- `active`: 当前时间在 startDate 和 endDate 之间
- `ended`: 当前时间已超过 endDate
- `all`: 所有状态

#### 推广活动字段
- `isPromoted`: 是否为推广活动
- `promotionInfo`: 推广活动相关信息
  - `selectedDataNfts`: 选中的数据资产列表
    - `id`: 数据资产ID
    - `name`: 数据资产名称
    - `isOwned`: 是否已拥有
    - `quantity`: 数量（仅当 isOwned 为 false 时有效）

#### NFT 字段
- `name`: NFT 名称
- `description`: NFT 描述
- `totalSupply`: 总供应量
- `price`: 价格
- `validityStart`: 有效期开始时间
- `validityEnd`: 有效期结束时间
- `usageRules`: 使用规则

## 错误响应

## Award System API

### Get User Awards List

```
GET /api/awards
```

**Headers**:
```
Authorization: Bearer <token>
```

**Description**: Get all award information for the currently authenticated user, including award progress and task list.

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "awardId": "award-uuid",
        "title": "Early Bird Reward",
        "description": "Thank you for your early participation!",
        "icon": "starOutline",
        "color": "#FFB86C",
        "status": "LIVE",
        "metadata": {},
        "totalTasks": 3,
        "claimedTasks": 1,
        "progress": 0.33,
        "finalStatus": "IN_PROGRESS",
        "tasks": [
          {
            "id": "task-uuid",
            "title": "Complete Profile",
            "description": "Fill in your profile information including name, email, and profile picture to help us know you better",
            "points": 100,
            "claimLimit": 1,
            "requirementCount": 3,
            "doneCount": 2,
            "claimed": false,
            "progress": 0.66,
            "finalStatus": "IN_PROGRESS"
          }
        ]
      }
    ],
    "referralOverview": {
      // See Referral System API below
    }
  }
}
```

---

### Claim Award

```
POST /api/awards/{awardId}/claim
```

**Headers**:
```
Authorization: Bearer <token>
```

**Path Parameters**:
- `awardId`: ID of the award to claim

**Response** (200 OK):
```json
{
  "status": "success",
  "message": "Reward claimed successfully.",
  "data": {
    "award": {
      "awardId": "award-uuid",
      "title": "Early Bird Reward",
      "isClaimed": true,
      "claimedAt": "2023-07-15T10:00:00.000Z"
    },
    "pointsAwarded": 100
  }
}
```

**Error Response**:
- 404 Not Found: Award does not exist or has already been claimed
```json
{
  "status": "error",
  "message": "Reward not found or already claimed."
}
```

---

- `200 OK`: 请求成功
- `201 Created`: 资源创建成功
- `400 Bad Request`: 请求参数错误
- `401 Unauthorized`: 未授权（未登录）
- `403 Forbidden`: 权限不足
- `404 Not Found`: 资源不存在
- `500 Internal Server Error`: 服务器内部错误

## 组织交易 API

### 获取组织交易记录

```
GET /api/organization/transactions
```

**Request Headers:**
```
Authorization: Bearer <token>
```
**Query Parameters:**
- `page`: Page number (default 1)
- `limit`: Items per page (default 10)
- `type`: Transaction type (DEPOSIT/WITHDRAW)
- `status`: Transaction status (PENDING/COMPLETED/FAILED)
- `startDate`: Start date
- `endDate`: End date

### Get Award Tasks List

```
GET /api/awards/:awardId/tasks
```

**Headers**:
```
Authorization: Bearer <token>
```

**Path Parameters**:
- `awardId`: Award ID

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "transactions": [
      {
        "id": "transaction-uuid",
        "amount": 7.5,
        "type": "DEPOSIT",
        "status": "COMPLETED",
        "description": "DataNFT sale: Data Asset Bundle Name (Purchase #1, quantity: 3)",
        "userId": "org-uuid",
        "metadata": {
          "dataNFTId": "data-nft-uuid",
          "buyerId": "buyer-uuid",
          "purchaseCount": 1,
          "quantity": 3
        },
        "createdAt": "2024-03-20T12:00:00.000Z",
        "updatedAt": "2024-03-20T12:00:00.000Z"
      }
    ],
    "pagination": {
      "total": 20,
      "page": 1,
      "limit": 10,
      "pages": 2

    "tasks": [
      {
        "id": "task-uuid",
        "title": "Complete Profile",
        "description": "Fill in your profile information including name, email, and profile picture to help us know you better",
        "points": 100,
        "claimLimit": 1,
        "requirementCount": 3,
        "doneCount": 2,
        "claimed": false,
        "progress": 0.66,
        "finalStatus": "IN_PROGRESS"
      }
    ]
  }
}
```

---

### Record Task Progress

```
POST /api/awards/tasks/:taskId/progress
```

**Headers**:
```
Authorization: Bearer <token>
```

**Path Parameters**:
- `taskId`: Task ID

**Request Body**:
```json
{
  "delta": 1 // Progress increment
}
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "taskId": "task-uuid",
    "status": "IN_PROGRESS"
  }
}
```

---

### Claim Task Reward

```
POST /api/awards/tasks/:taskId/claim
```

**Headers**:
```
Authorization: Bearer <token>
```

**Path Parameters**:
- `taskId`: Task ID

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "taskId": "task-uuid",
    "claimedAt": "2023-07-15T10:00:00.000Z",
    "points": 100
  }
}
```

**Error Response**:
- 400 Bad Request: Task not completed or already claimed
```json
{
  "status": "fail",
  "message": "Task not completed or already claimed."
}
```

---

### Referral System API

#### Use Referral Code

```
POST /api/referrals/use-code
```

**Headers**:
```
Authorization: Bearer <token>
```

**Request Body**:
```json
{
  "code": "DD-ABCD1234"
}
```

**Response** (200 OK):
```json
{
  "status": "success",
  "message": "Referral code used successfully",
  "data": {
    "inviterId": "inviter-user-id",
    "inviterName": "Inviter Name",
    "inviteeId": "current-user-id",
    "code": "DD-ABCD1234",
    "createdAt": "2025-05-19T13:11:27.758Z"
  }
}
```

**Error Responses**:
- 400 Bad Request: Missing referral code
```json
{
  "status": "fail",
  "code": "MISSING_CODE",
  "message": "Please provide a referral code"
}
```

- 409 Conflict: Already invited
```json
{
  "status": "fail",
  "code": "ALREADY_REFERRED",
  "message": "User has already been referred",
  "data": {
    "inviterId": "previous-inviter-id",
    "inviterName": "Previous Inviter",
    "code": "DD-PREV1234",
    "createdAt": "2025-05-19T13:00:00.000Z"
  }
}
```

- 404 Not Found: Invalid referral code
```json
{
  "status": "fail",
  "code": "INVALID_CODE",
  "message": "Invalid referral code"
}
```

- 400 Bad Request: Self-referral not allowed
```json
{
  "status": "fail",
  "code": "SELF_REFERRAL_NOT_ALLOWED",
  "message": "Cannot use your own referral code"
}
```

- 500 Internal Server Error: Server error
```json
{
  "status": "error",
  "message": "Server error",
  "error": "Error message in development mode only"
}
```

---

#### Claim Referral Rewards

```
POST /api/referrals/claim-rewards
```

**Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "claimedAt": "2025-05-17T12:00:00Z",
    "totalPoints": 150,
    "count": 3
  }
}
```

**Error Response**:
- 400 Bad Request: No rewards available to claim

---

#### Get Referral Status

```
GET /api/referrals/status
```

**Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "hasBeenInvited": true,
    "inviterInfo": {
      "id": "user123",
      "name": "John Doe",
      "code": "REF-ABC123",
      "inviteTime": "2025-05-17T10:30:00Z"
    },
    "ownReferralCode": "REF-XYZ789",
    "invitedUsers": [
      {
        "id": "user456",
        "name": "Jane Smith",
        "inviteTime": "2025-05-16T15:45:00Z"
      }
    ]
  }
}
```

---

#### Get Referral Network Overview

```
GET /api/referrals/overview
```

**Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "referrals": [
      {
        "id": "user-id",
        "email": "user@example.com",
        "nickname": "User Name",
        "level": 1,
        "theirPoints": 100,
        "yourReward": 5,
        "referrals": [
          {
            "id": "referee-id",
            "email": "referee@example.com",
            "nickname": "Referee Name",
            "level": 2,
            "theirPoints": 50,
            "yourReward": 3,
            "referrals": []
          }
        ]
      }
    ],
    "levelCounts": {
      "1": 3,
      "2": 2,
      "3": 1,
      "4": 0
    },
    "earnedByLevel": [150, 100, 50, 0],
    "totalReferralPoints": 300,
    "unclaimReferralAwards": 50,
    "networkActivity": 450
  }
}
```

## Pass API

### Create Pass

```
POST /api/passes
```

**Request Headers**:
```
Authorization: Bearer <token>
```

**Request Body**:
```json
{
  "creatorId": "creator-uuid",
  "platform": "apple",  // or "google"
  "expiresAt": "2025-12-31T23:59:59Z"
}
```

**Response** (201 Created):
```json
{
  "status": "success",
  "data": {
    "pass": {
      "id": "pass-uuid",
      "creatorId": "creator-uuid",
      "creatorName": "Creator Name",
      "creatorLogo": "/assets/logos/creator-logo.png",
      "userId": "user-uuid",
      "userName": "User Name",
      "userWalletAddress": "0x1234...",
      "passUrl": "https://example.com/passes/pass-uuid",
      "status": "active",
      "platform": "apple",
      "expiresAt": "2025-12-31T23:59:59Z",
      "serialNumber": "PASS123",
      "passTypeIdentifier": "pass.ai.datadance.app",
      "createdAt": "2025-05-17T10:00:00Z",
      "updatedAt": "2025-05-17T10:00:00Z"
    }
  }
}
```

### Get User Passes

```
GET /api/passes
```

**Request Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "passes": [
      {
        "id": "pass-uuid",
        "creatorId": "creator-uuid",
        "creatorName": "Creator Name",
        "creatorLogo": "/assets/logos/creator-logo.png",
        "passUrl": "https://example.com/passes/pass-uuid",
        "status": "active",
        "platform": "apple",
        "expiresAt": "2025-12-31T23:59:59Z",
        "serialNumber": "PASS123",
        "createdAt": "2025-05-17T10:00:00Z"
      }
    ]
  }
}
```

### Get Pass Details

```
GET /api/passes/:passId
```

**Request Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "pass": {
      "id": "pass-uuid",
      "creatorId": "creator-uuid",
      "creatorName": "Creator Name",
      "creatorLogo": "/assets/logos/creator-logo.png",
      "userId": "user-uuid",
      "userName": "User Name",
      "userWalletAddress": "0x1234...",
      "passUrl": "https://example.com/passes/pass-uuid",
      "status": "active",
      "platform": "apple",
      "expiresAt": "2025-12-31T23:59:59Z",
      "serialNumber": "PASS123",
      "passTypeIdentifier": "pass.ai.datadance.app",
      "createdAt": "2025-05-17T10:00:00Z",
      "updatedAt": "2025-05-17T10:00:00Z"
    }
  }
}
```

### Update Pass Push Token

```
PUT /api/passes/:passId/push-token
```

**Request Headers**:
```
Authorization: Bearer <token>
```

**Request Body**:
```json
{
  "pushToken": "device-push-token"
}
```

**Response** (200 OK):
```json
{
  "status": "success",
  "message": "Push token updated successfully",
  "data": {
    "pass": {
      "id": "pass-uuid",
      "pushToken": "device-push-token",
      "updatedAt": "2025-05-17T10:30:00Z"
    }
  }
}
```

### Delete Pass

```
DELETE /api/passes/:passId
```

**Request Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "status": "success",
  "message": "Pass deleted successfully"
}
```

## X API

### Get X Post Details

```
GET /api/x/posts/:postId
```

**Path Parameters**:
- `postId`: X post ID (required)

**Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "1234567890",
    "text": "Post content",
    "author": {
      "id": "123456",
      "username": "author_username",
      "name": "Author Name"
    },
    "created_at": "2025-05-17T10:00:00Z",
    "metrics": {
      "retweets": 10,
      "likes": 20,
      "replies": 5
    }
  }
}
```

---

### X Account OAuth2 PKCE Binding Flow

#### Step 1: Initiate Authorization

```
GET /api/x/oauth2/authorize
```

**Description**: Start the X OAuth2.0 PKCE authorization flow. The backend generates PKCE parameters and constructs the X authorization URL, redirecting the user to X for authorization. Login required.

**Headers**:
```
Authorization: Bearer <token>
```

**Response**:
- `302 Found`: Redirect to X authorization page
  - `Location`: X authorization URL

**Error Response**:
- 401 Unauthorized: Not authenticated
- 500 Internal Server Error: Failed to generate authorization URL
```json
{
  "status": "error",
  "code": "X_OAUTH_START_FAILED",
  "message": "Failed to start X OAuth2 authorization."
}
```

---

#### Step 2: Handle X Callback

```
GET /api/x/oauth2/callback
```

**Description**: X callback endpoint after authorization. The backend exchanges code and state for access token and refresh token, retrieves X user information and binds the account.

**Query Parameters**:
- `code`: X authorization code
- `state`: CSRF prevention state

**Response**:
- `302 Found`: Redirect to frontend URL with binding result parameters
  - `Location`: e.g., `https://yourfrontend.com/settings/connections?x_status=success` or `x_status=error&code=STATE_INVALID`

**Error Response**:
- Returned via redirect parameters, common errors:
  - Missing/invalid state (`x_status=error&code=STATE_INVALID`)
  - Missing/invalid code (`x_status=error&code=CODE_INVALID`)
  - Token exchange failed (`x_status=error&code=TOKEN_EXCHANGE_FAILED`)
  - Failed to fetch user info (`x_status=error&code=USER_INFO_FETCH_FAILED`)
  - Account already bound (`x_status=error&code=X_ACCOUNT_ALREADY_BOUND`)
  - Database update failed (`x_status=error&code=DATABASE_UPDATE_FAILED`)

---

#### Step 3: Get X Account Binding Status

```
GET /api/x/status
```

**Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK - Bound):
```json
{
  "status": "success",
  "data": {
    "bound": true,
    "xid": "1234567890123456789",
    "xUsername": "twitterUser",
    "xName": "Twitter User Name",
    "xProfileImageUrl": "https://pbs.twimg.com/profile_images/..."
  }
}
```

**Response** (200 OK - Not Bound):
```json
{
  "status": "success",
  "data": {
    "bound": false
  }
}
```

**Error Response**:
- 401 Unauthorized: Not authenticated
- 500 Internal Server Error: Failed to fetch status
```json
{
  "status": "error",
  "code": "STATUS_FETCH_FAILED",
  "message": "Failed to fetch X binding status."
}
```

## Crawler API

> 详细的系统架构、去重逻辑、数据质量评分等说明请参考：`docs/crawler-system-overview.md`

### 核心接口

#### 获取爬虫任务列表

```
GET /api/crawler-tasks
```

**请求头**:
```
Authorization: Bearer <token>
```

**查询参数**:
- `source`: 数据源过滤 ('amazon' | 'luma') (可选)
- `status`: 状态过滤 ('pending' | 'running' | 'done' | 'error') (可选)
- `search`: 关键词搜索 (可选)
- `page`: 页码 (默认: 1) (可选)
- `limit`: 每页条数 (默认: 10, 最大: 100) (可选)

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "tasks": [
      {
        "id": "task-amz-20250601-xyz",
        "title": "Amazon Order History",
        "source": "amazon",
        "status": "running",
        "recordCount": 150,
        "createdAt": "2025-06-01T09:00:00.000Z",
        "updatedAt": "2025-06-01T09:30:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 2,
      "pages": 1
    }
  }
}
```

#### 获取单个任务详情

```
GET /api/crawler-tasks/{taskId}
```

**请求头**:
```
Authorization: Bearer <token>
```

**路径参数**:
- `taskId`: 任务ID (必需)

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "task-amz-20250601-xyz",
    "title": "Amazon Order History",
    "source": "amazon",
    "status": "running",
    "recordCount": 100,
    "createdAt": "2025-06-01T09:00:00.000Z",
    "updatedAt": "2025-06-01T09:30:00.000Z"
  }
}
```

#### 上传爬虫数据

```
POST /api/crawler/upload
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体格式** (支持三种):
```javascript
// 1. 直接数组格式
[
  {
    "source": "amazon",
    "type": "order",
    "timestamp": "2025-06-02T11:58:00Z",
    "payload": {
      "orderid": "113-1234567-7890123",
      "title": "Wireless Bluetooth Headphones",
      "price": 129.99,
      "currency": "USD"
    },
    "metadata": {
      "sourceUrl": "https://amazon.com/orders",
      "category": "Electronics"
    }
  }
]

// 2. 单个对象格式
{
  "source": "luma",
  "type": "event",
  "timestamp": "2025-06-02T11:59:00Z",
  "payload": {
    "eventId": "luma-evt-123",
    "title": "Tech Conference 2024"
  }
}

// 3. 包装格式 (兼容)
{
  "data": [DataItem, ...]
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "uploadedCount": 10,
    "pointsEarned": 100,
    "duplicatesCount": 2,
    "message": "数据上传成功"
  }
}
```

**错误响应**:
- 400 Bad Request: 数据格式验证失败
- 401 Unauthorized: 认证失败
- 429 Too Many Requests: 超出上传限制

### 数据格式

#### DataItem 结构
```typescript
interface DataItem {
  source: 'amazon' | 'luma';
  type: 'order' | 'product' | 'event' | 'task' | 'custom';
  timestamp: string;  // ISO8601格式
  payload: Record<string, any>;  // 数据内容
  metadata?: {        // 可选元数据
    sourceUrl?: string;
    category?: string;
    region?: string;
  };
}
```

#### 数据源要求
- **Amazon**: payload必须包含 `orderid` 字段
- **Luma**: payload建议包含 `eventId`、`taskId` 或 `id` 字段

### 扩展接口

#### 获取爬虫统计
```
GET /api/crawler/stats
```

#### 获取上传限制
```
GET /api/crawler/limits
```

#### 创建爬虫任务
```
POST /api/crawler-tasks
```

#### 更新任务状态
```
PUT /api/crawler-tasks/:taskId/status
```

#### 删除爬虫任务
```
DELETE /api/crawler-tasks/:taskId
```