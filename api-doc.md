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
7. [Data NFT 快照与市场 API](#data-nft-快照与市场-api)
8. [Promotions API](#promotions-api)
9. [组织交易 API](#组织交易-api)

## 测试账号
为了方便测试，我们提供了一个测试账号，可以使用账号密码登录：
- 邮箱：test@example.com
- 密码：password123

该账号可以绕过 Web3Auth 的限制，直接使用账号密码登录，并返回 token。

## 认证 API

### 用户注册

```
POST /auth/register
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
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
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
POST /auth/login
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
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
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
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
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

### Web3Auth 登录/注册

```
POST /api/auth/web3auth-login
```

**请求体**:
```json
{
  "userInfo": {
    "email": "user@example.com",
    "name": "User Name",
    "profileImage": "https://example.com/profile.jpg",
    "verifier": "datadance-email-verifier",
    "verifierId": "user@example.com",
    "typeOfLogin": "jwt"
  },
  "walletAddress": "0x123abc..."
}
```

**登录场景**:
1. 如果提供了钱包地址，系统会尝试通过钱包地址查找用户
2. 如果提供了邮箱，系统会尝试通过邮箱查找用户
3. 如果用户不存在且提供了足够信息，系统会创建新用户

**响应** (200 OK - 登录成功):
```json
{
  "status": "success",
  "data": {
    "token": "jwt_token_here",
    "user": {
      "id": "user_id",
      "email": "user@example.com",
      "name": "User Name",
      "walletAddress": "0x123abc...",
      "userType": "regular",
      "authType": "web3auth",
      "isOrganization": false
    }
  }
}
```

**响应** (201 Created - 注册成功):
```json
{
  "status": "success",
    "data": {
    "token": "jwt_token_here",
    "user": {
      "id": "user_id",
      "email": "user@example.com",
      "name": "User Name",
      "walletAddress": "0x123abc...",
      "userType": "regular",
      "authType": "web3auth",
      "isOrganization": false
    }
  }
}
```

## 用户 API

### 获取当前用户信息

```
GET /users/me
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
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "User Name",
      "avatar": "/assets/avatars/default.png",
      "isOrganization": false,
      "walletAddress": "0x1234567890abcdef1234567890abcdef12345678"
    }
  }
}
```

### 更新用户信息

```
PATCH /users/me
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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

### 生成钱包

```
POST /api/users/wallet/generate
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "钱包已生成",
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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

### 更新用户钱包地址

```
POST /api/auth/update-wallet
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**请求体**:
```json
{
  "walletAddress": "0x456def..."
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "钱包地址已更新",
  "data": {
    "user": {
      "id": "user_id",
      "email": "user@example.com",
      "walletAddress": "0x456def...",
      "userType": "regular",
      "authType": "web3auth"
    }
  }
}
```

## 活动 API

### 获取活动列表

```
GET /api/activities
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
GET /activities/{activityId}
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
GET /activities/featured
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
GET /assets
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
GET /assets/points
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
GET /assets/badges
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
GET /assets/badges/{badgeId}
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
POST /assets/badges/{badgeId}/collect
```

**请求头**:
```Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
GET /notifications
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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
PATCH /notifications/{notificationId}/read
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
    "notification": {
      "id": "notification-uuid",
      "isRead": true
    }
  }
}
```

### 标记所有通知为已读

```
PATCH /notifications/read-all
```

**请求头**:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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

### 图片格式说明

所有图片（包括 DataNFT 封面图和 Owner 头像）都通过后端静态文件服务提供，可直接通过 HTTP 访问。

#### DataNFT 封面图 (`coverImage`)

支持两种图片格式：

1. **SVG 矢量图**（数据包）:
   - 路径格式：`/data-pack/{Category} Data Pack.svg`
   - 示例：`/data-pack/Electronics Data Pack.svg`
   - 访问地址：`http://localhost:8080/data-pack/Electronics Data Pack.svg`
   - 特点：矢量图，可无损缩放，文件小
   - MIME 类型：`image/svg+xml`

2. **JPG/PNG 位图**（活动数据）:
   - 路径格式：`/assets/nfts/{filename}.jpg` 或 `/assets/nfts/{filename}.png`
   - 访问地址：`http://localhost:8080/assets/nfts/{filename}.jpg`
   - 特点：位图，固定分辨率
   - MIME 类型：`image/jpeg` 或 `image/png`

#### Owner 头像 (`ownerAvatar`)

- 路径格式：`/assets/avatars/{filename}.jpg` 或 `/assets/avatars/{filename}.png`
- 访问地址：`http://localhost:8080/assets/avatars/{filename}.jpg`
- 特点：商家/组织用户的头像图片
- MIME 类型：`image/jpeg` 或 `image/png`
- 默认头像：`/assets/avatars/default-avatar.jpg`（如果用户未上传头像）

**前端使用**:
```javascript
// 所有图片都可以直接使用，浏览器会自动使用当前域名
<img src={nft.coverImage} alt={nft.title} />
<img src={nft.ownerAvatar} alt={nft.owner} />
```

**注意**: 
- 所有图片路径都是相对于网站根目录的路径
- 图片通过后端静态文件服务提供，无需额外配置
- 支持 SVG、JPG、PNG 等常见图片格式

### Size 字段计算说明

`size` 字段表示数据包包含的数据记录数量，根据 DataNFT 的 `dataSource` 类型使用不同的计算方式：

- **上传数据包** (`dataSource: "upload"`): 
  - 从 `dataRecords.recordCount` 字段读取
  - 表示 CSV 文件中的有效记录数（包含邮箱的记录）
  
- **活动数据** (`dataSource: "activity"`):
  - 从 `snapshots` 中统计唯一用户数
  - 表示参与活动的唯一用户数量

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
      "title": "Electronics Data Pack - North America",
      "coverImage": "/data-pack/Electronics Data Pack.svg",
      "owner": "DataDance Official",
      "ownerId": "merchant-uuid",
      "ownerAvatar": "/assets/avatars/org.png",
      "size": 1234,
      "price": 299.99,
      "description": "Discover high-quality Electronics data from the North America region...",
      "tags": [
        { "id": "tag-uuid-1", "name": "Data Pack" },
        { "id": "tag-uuid-2", "name": "Electronics" }
      ]
    }
  ]
}
```

**字段说明**:
- `id`: DataNFT 唯一标识符
- `title`: DataNFT 名称
- `coverImage`: 封面图片路径
  - 数据包格式：`/data-pack/{Category} Data Pack.svg` (SVG 矢量图)
  - 活动数据格式：`/assets/nfts/{filename}.jpg` (JPG/PNG 位图)
  - 支持 SVG 和 JPG/PNG 格式，浏览器自动识别
- `owner`: 所有者名称（字符串）
- `ownerId`: 所有者 ID
- `ownerAvatar`: 所有者头像路径
- `size`: 数据包的总数据量（记录数）
  - **上传数据包** (`dataSource: "upload"`): 从 `dataRecords.recordCount` 计算
  - **活动数据** (`dataSource: "activity"`): 从 `snapshots` 中唯一用户数计算
- `price`: 数据包的价格（USDT）
- `description`: 数据资产简介
- `tags`: 标签数组，每个标签包含 `id` 和 `name` 字段

**说明**:
- 只返回已发布（`isPublished: true`）的 DataNFT
- 支持通过 `search` 参数对 DataNFT 名称、简介、商家名称、标签名进行模糊搜索
- 搜索结果会按关联度（命中字段优先级：名称 > 商家名称 > 简介 > 标签）降序排列
- 可与标签筛选（`tag`）同时使用
- 默认按创建时间降序排列（有搜索时按关联度排序）
- 图片路径支持 SVG 和 JPG/PNG 格式，前端可直接使用 `<img>` 标签显示

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
    "title": "Electronics Data Pack - North America",
    "coverImage": "/data-pack/Electronics Data Pack.svg",
    "owner": "DataDance Official",
    "ownerId": "merchant-uuid",
    "ownerAvatar": "/assets/avatars/org.png",
    "size": 1234,
    "price": 299.99,
    "description": "Discover high-quality Electronics data from the North America region—ideal for teams aiming to reach real buyers with accuracy. This data pack includes 1,234 fully verified records, complete with contact information and transaction details, offering reliable insights for smarter targeting and decision-making.",
    "tags": [
      { "id": "tag-uuid-1", "name": "Data Pack" },
      { "id": "tag-uuid-2", "name": "Electronics" }
    ],
    "sales": 5,
    "revenue": 1499.95
  }
}
```

**字段说明**:
- `id`: DataNFT 唯一标识符
- `title`: DataNFT 名称
- `coverImage`: 封面图片路径
  - 数据包格式：`/data-pack/{Category} Data Pack.svg` (SVG 矢量图)
  - 活动数据格式：`/assets/nfts/{filename}.jpg` (JPG/PNG 位图)
- `owner`: 所有者名称（字符串）
- `ownerId`: 所有者 ID
- `ownerAvatar`: 所有者头像路径
- `size`: 数据包的总数据量（记录数）
  - **上传数据包** (`dataSource: "upload"`): 从 `dataRecords.recordCount` 计算
  - **活动数据** (`dataSource: "activity"`): 从 `snapshots` 中唯一用户数计算
- `price`: 数据包的价格（USDT）
- `description`: 数据资产简介
- `tags`: 标签数组，每个标签包含 `id` 和 `name` 字段
- `sales`: 销量（购买次数）
- `revenue`: 总收入（销量 × 单价）

**错误响应**:
- `404 Not Found`: DataNFT 不存在或未发布

### 购买市场 NFT 数据资产

```
POST /nft-market/{id}/purchase
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体** (可选):
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
    "price": 299.99,
    "purchasedAt": "2024-06-01T12:00:00.000Z"
  }
}
```

**错误响应**:
- `404 Not Found`: DataNFT 不存在或未发布
- `403 Forbidden`: 不能购买自己发售的 DataNFT
- `400 Bad Request`: 已经购买过该 DataNFT

**说明**:
- 每个用户对同一个 DataNFT 只能购买一次
- 购买成功后会自动创建购买记录
- 购买时会自动生成交易流水记录

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
      "title": "Electronics Data Pack - North America",
      "coverImage": "/data-pack/Electronics Data Pack.svg",
      "price": 299.99,
      "purchasedAt": "2024-06-01T12:00:00.000Z"
    }
  ]
}
```

**字段说明**:
- `orderId`: 订单 ID（购买记录 ID）
- `nftId`: DataNFT ID
- `title`: DataNFT 名称
- `coverImage`: 封面图片路径（支持 SVG 和 JPG/PNG）
- `price`: 购买时的价格
- `purchasedAt`: 购买时间

**说明**:
- 返回当前用户购买的所有 DataNFT
- 按购买时间降序排列（最新的在前）

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
      "title": "Electronics Data Pack - North America",
      "coverImage": "/data-pack/Electronics Data Pack.svg",
      "sales": 5,
      "revenue": 1499.95
    }
  ]
}
```

**字段说明**:
- `nftId`: DataNFT ID
- `title`: DataNFT 名称
- `coverImage`: 封面图片路径（支持 SVG 和 JPG/PNG）
- `sales`: 销量（购买次数）
- `revenue`: 总收入（销量 × 单价）

**说明**:
- 只返回当前用户发售的已发布 DataNFT
- 包含每个 DataNFT 的销售统计信息

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

**接口分类**:
- `/nft-market` 相关接口为市场公开展示和购买入口，主要面向所有用户
- `/api/data-nfts` 相关接口为商家侧管理和个人资产查询
- 两者数据结构类似，但 `/nft-market` 只展示已发布（`isPublished=true`）的 DataNFT

**图片格式支持**:
- **DataNFT 封面图**:
  - **数据包** (`dataSource: "upload"`): 使用 SVG 格式，路径为 `/data-pack/{Category} Data Pack.svg`
    - 示例：`/data-pack/Electronics Data Pack.svg`
    - 支持所有常见类别：Automotive, Baby & Kids, Beauty & Personal Care, Books & Media, Electronics, Fashion & Apparel, Health & Wellness, Home & Kitchen, Sports & Outdoors, Other
  - **活动数据** (`dataSource: "activity"`): 使用 JPG/PNG 格式，路径为 `/assets/nfts/{filename}.jpg`
- **Owner 头像**:
  - 路径格式：`/assets/avatars/{filename}.jpg` 或 `/assets/avatars/{filename}.png`
  - 默认头像：`/assets/avatars/default-avatar.jpg`
- 所有图片都通过后端静态文件服务提供，可直接通过 HTTP 访问
- 前端使用 `<img src={coverImage} />` 和 `<img src={ownerAvatar} />` 即可显示，浏览器自动识别格式

**Size 字段计算**:
- **上传数据包** (`dataSource: "upload"`): `size = dataRecords.recordCount`（CSV 文件中的有效记录数）
- **活动数据** (`dataSource: "activity"`): `size = unique(snapshots[].userId).length`（参与活动的唯一用户数）

**数据来源标识**:
- `dataSource: "upload"` - 直接上传的 CSV 数据包，数据存储在 `dataRecords` 字段
- `dataSource: "activity"` - 来自活动快照的数据，数据关联到 `snapshots` 关系

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

所有API在发生错误时会返回一致的错误格式：

### 客户端错误 (400, 401, 403, 404)

```json
{
  "status": "fail",
  "message": "错误描述信息"
}
```

### 服务器错误 (500)

```json
{
  "status": "error",
  "message": "服务器错误",
  "error": "详细错误信息（仅在开发环境中返回）"
}
```

## 状态码说明

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
    }
  }
}
```

**Notes:**
- All transaction records use the `userId` field to indicate the organization (must be a user with `isOrganization: true`).
- Transaction types include:
  - `DEPOSIT`: Deposit (from system to organization)
  - `WITHDRAW`: Withdraw (from organization to system)
- Transaction status includes:
  - `PENDING`: Pending
  - `COMPLETED`: Completed
  - `FAILED`: Failed
- Only organization users can access these APIs
- The system will automatically verify if the balance is sufficient
- All transactions are recorded on-chain, and if available, `txHash` is stored in metadata
- When purchasing a DataNFT, transaction records are automatically generated, including:
  - Seller (merchant) DEPOSIT record (amount = price * quantity, metadata includes quantity)
  - Buyer (if organization user) WITHDRAW record (amount = price * quantity, metadata includes quantity)

### 创建充值交易

```
POST /api/organization/transactions/deposit
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "amount": 1000.000000,
  "description": "Deposit from bank",
  "metadata": {
    "txHash": "0x...",
    "note": "Deposit note"
  }
}
```

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "transaction-uuid",
    "amount": 1000.000000,
    "type": "DEPOSIT",
    "status": "PENDING",
    "description": "Deposit from bank",
    "userId": "org-uuid",
    "metadata": {
      "txHash": "0x...",
      "note": "Deposit note"
    },
    "createdAt": "2024-03-20T12:00:00.000Z",
    "updatedAt": "2024-03-20T12:00:00.000Z"
  }
}
```

### 创建提现交易

```
POST /api/organization/transactions/withdraw
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "amount": 500.000000,
  "description": "Withdraw to bank account",
  "metadata": {
    "walletAddress": "0x...",
    "note": "Withdraw note"
  }
}
```

**响应** (201 Created):
```json
{
  "status": "success",
  "data": {
    "id": "transaction-uuid",
    "amount": 500.000000,
    "type": "WITHDRAW",
    "status": "PENDING",
    "description": "Withdraw to bank account",
    "userId": "org-uuid",
    "metadata": {
      "walletAddress": "0x...",
      "note": "Withdraw note"
    },
    "createdAt": "2024-03-20T12:00:00.000Z",
    "updatedAt": "2024-03-20T12:00:00.000Z"
  }
}
```

### 获取组织余额

```
GET /api/organization/balance
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
    "balance": 1000.000000,
    "currency": "USDT",
    "lastUpdated": "2024-03-20T12:00:00.000Z"
  }
}
```

### 更新交易状态

```
PATCH /api/organization/transactions/{id}/status
```

**请求头**:
```
Authorization: Bearer <token>
```

**请求体**:
```json
{
  "status": "COMPLETED",
  "metadata": {
    "note": "Transaction completed note"
  }
}
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "id": "transaction-uuid",
    "status": "COMPLETED",
    "updatedAt": "2024-03-20T12:00:00.000Z"
  }
}
```

**说明**:
- 所有交易记录使用 `userId` 字段标识组织（必须是 `isOrganization: true` 的用户）
- 交易类型包括：
  - `DEPOSIT`: 充值（从系统到组织）
  - `WITHDRAW`: 提现（从组织到系统）
- 交易状态包括：
  - `PENDING`: 待处理
  - `COMPLETED`: 已完成
  - `FAILED`: 失败
- 只有组织用户可以访问这些 API
- 系统会自动验证余额是否充足
- 所有交易都会记录在链上，如果有 txHash 会存储在 metadata 中
- DataNFT 购买时会自动生成交易记录，包括：
  - 卖家（商家）的 DEPOSIT 记录
  - 买家（如果是组织用户）的 WITHDRAW 记录