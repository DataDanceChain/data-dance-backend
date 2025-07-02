# Data Dance API 文档 V1

> **最后更新**: 2025-05-20

## 核心概念

在使用本API之前，请先阅读以下核心概念，这将帮助您更好地与API交互。

#### **认证 (Authentication)**
所有需要授权的端点都必须在HTTP请求头中包含一个有效的Bearer Token。
`Authorization: Bearer <YOUR_JWT_TOKEN>`
Token可以通过**用户登录**或**注册**接口获取。

#### **成功响应-建议 (Success Response)**
所有成功的API请求都将返回一个包含 `status: "success"` 的JSON对象。
```json
{
  "status": "success",
  "data": { ... }
}
```
> **注意**: 在本文档的部分旧有端点示例中，可能存在 `{"success": true, ...}` 格式的响应。这属于历史格式，新功能将统一使用 `status` 字段。此差异将在未来版本中统一。

#### **错误响应 (Error Handling)**
API使用标准的HTTP状态码来指示请求的成功或失败。当请求失败时，响应体将包含一个标准化的错误对象。

**通用错误响应体**
```json
{
  "status": "fail" | "error",
  "code": "ERROR_CODE_STRING",
  "message": "A human-readable error description."
}
```
**常见状态码**:
- `400 Bad Request`: 请求参数无效。
- `401 Unauthorized`: 认证失败或未提供Token。
- `403 Forbidden`: 用户无权访问该资源。
- `404 Not Found`: 请求的资源不存在。
- `409 Conflict`: 资源冲突，例如尝试创建一个已存在的资源。
- `500 Internal Server Error`: 服务器内部错误。

#### **命名约定-建议 (Naming Conventions)**
为保证API的一致性，以下为全局统一的实体命名约定：
- **创建者 (Creator/Merchant)**: 在系统中，创建活动、资产或发布数据NFT的实体统一被称为"创建者"或"商家"。在API的不同上下文中，可能会使用 `creator`、`merchant` 或 `owner` 字段来指代。尽管字段名不同，但它们均指向同一个业务概念。此命名差异问题计划在未来版本中统一。

#### **分页 (Pagination)**
对于返回列表数据的 `GET` 端点，支持通过查询参数进行分页。

**请求参数**
| 参数 | 类型 | 描述 |
|:--- |:--- |:--- |
| `page` | `number` | 页码，默认为 `1`。 |
| `limit`| `number` | 每页数量，默认为 `10`。 |

**响应结构**
支持分页的端点会在 `data` 对象中返回一个 `pagination` 对象，包含分页信息。
```json
{
  "status": "success",
  "data": {
    "activities": [ ... ], // 列表数据
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 50,
      "pages": 5
    }
  }
}
```

#### 测试账号
为了方便测试，我们提供了一个测试账号，可以使用账号密码登录：
- 邮箱：test@example.com
- 密码：password123

该账号可以绕过 Web3Auth 的限制，直接使用账号密码登录，并返回 token。

---

## 目录

1. [认证 API](#认证-api)
2. [用户 API](#用户-api)
3. [活动 API](#活动-api)
4. [资产 API](#资产-api)
5. [通知 API](#通知-api)
6. [DataNFT 与市场 API](#datanft-与市场-api)
7. [推广 API](#推广-api)
8. [组织交易 API](#组织交易-api)
9. [通行证 API](#通行证-api)
10. [奖励任务 API](#奖励任务-api)
11. [X (Twitter) API](#x-twitter-api)
12. [爬虫与数据采集 API](#爬虫与数据采集-api)

---

## 认证 API

### 用户注册
> `POST /api/auth/register`

通过邮箱和密码注册一个新用户，成功后返回用户信息和JWT。

**请求体 (Body)**
| 字段 | 类型 | 是否必须 | 描述 |
|:--- |:--- |:--- |:--- |
| `email` | `string` | 是 | 用户的有效邮箱地址，必须唯一。 |
| `password`| `string` | 是 | 密码，最小长度8位。 |
| `name` | `string` | 否 | 用户的显示昵称。 |

**请求示例 (cURL)**
```bash
curl -X POST 'http://localhost:3000/api/auth/register' \
-H 'Content-Type: application/json' \
-d '{
    "email": "test@example.com",
    "password": "password123",
    "name": "Test User"
}'
```

**响应 (201 Created)**
```json
{
  "status": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "user-uuid",
      "email": "test@example.com",
      "name": "Test User"
    }
  }
}
```

**失败响应 (409 Conflict)**
```json
{
    "status": "fail",
    "code": "EMAIL_ALREADY_EXISTS",
    "message": "A user with this email already exists."
}
```

### 用户登录
> `POST /api/auth/login`

使用邮箱和密码登录，成功后返回用户信息和JWT。

**请求体 (Body)**
| 字段 | 类型 | 是否必须 | 描述 |
|:--- |:--- |:--- |:--- |
| `email` | `string` | 是 | 用户的注册邮箱地址。 |
| `password`| `string` | 是 | 用户的密码。 |

**响应 (200 OK)**
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
> `POST /api/auth/register-with-wallet`

通过验证钱包签名来注册或登录用户。如果钱包地址不存在，则创建新用户。

**请求体 (Body)**
| 字段 | 类型 | 是否必须 | 描述 |
|:--- |:--- |:--- |:--- |
| `walletAddress` | `string` | 是 | 用户的钱包地址 (e.g., "0x...")。 |
| `chainId` | `number` | 是 | 钱包所在的链ID (e.g., 1 for Ethereum Mainnet)。 |
| `signature` | `string` | 是 | 对特定消息的钱包签名。 |
| `message` | `string` | 是 | 用户签名的原始消息文本。 |

**响应 (200 OK or 201 Created)**
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
> `POST /api/auth/web3auth-login`

处理来自Web3Auth的登录请求，支持多种登录方式（社交、钱包等），并可关联邀请码。

**请求体 (Body)**
| 字段 | 类型 | 是否必须 | 描述 |
|:--- |:--- |:--- |:--- |
| `userInfo` | `object` | 是 | 从Web3Auth获取的用户信息对象。 |
| `userInfo.email` | `string` | 是 | 用户邮箱。 |
| `userInfo.name` | `string` | 是 | 用户名。 |
| `userInfo.profileImage` | `string` | 否 | 用户头像URL。 |
| `walletAddress`| `string` | 否 | 用户的钱包地址，如果通过钱包登录则为必须。 |
| `xid` | `string` | 否 | 用户的X (Twitter) ID，如果通过X登录则为必须。 |
| `xUsername` | `string` | 否 | 用户的X (Twitter) 用户名。 |
| `referralCode`| `string` | 否 | **邀请码，用于建立邀请关系（适用于新用户和未被邀请的现有用户）**。 |
| `...` | `...` | | *其他来自Web3Auth的字段* |

**邀请码功能说明**:
- `referralCode`: 用于记录**谁邀请了用户**，格式为 `DD-xxxxxxxx`
- 适用于新用户注册和未被邀请过的现有用户登录
- 每个用户拥有唯一的邀请码，在注册时自动生成
- 系统支持多级邀请奖励机制（最多4级）
- 该端点是用户进入应用的主要入口，智能处理新用户创建和老用户登录

**邀请码使用规则**:
- ✅ 邀请码必须存在于系统中
- ✅ 用户不能使用自己的邀请码（防止自我邀请）
- ✅ 用户只能被邀请一次（防止重复邀请）
- ✅ 仅未被邀请过的用户可以使用邀请码

**成功响应 (200/201)**

**现有用户登录**
```json
{
  "status": "success",
  "data": {
    "token": "<jwt_token>",
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "name": "User Name",
      "walletAddress": "0x...",
      "referralCode": "DD-xyz98765"
    }
  }
}
```

**新用户注册（无邀请码）**
```json
{
  "status": "success",
  "data": {
    "token": "<jwt_token>",
    "user": {
      "id": "new-user-uuid",
      "email": "newuser@example.com",
      "name": "New User",
      "referralCode": "DD-abc12345"
    }
  }
}
```

**新用户注册（使用邀请码）**
```json
{
  "status": "success",
  "data": {
    "token": "<jwt_token>",
    "user": {
      "id": "new-user-uuid",
      "email": "newuser@example.com",
      "name": "New User",
      "referralCode": "DD-abc12345"
    },
    "invitationStatus": {
      "success": true,
      "code": "REFERRAL_SUCCESSFUL",
      "message": "Successfully registered with referral code"
    }
  }
}
```

**邀请码相关错误响应**

**无效邀请码 (404 Not Found)**
```json
{
  "status": "fail",
  "code": "INVALID_CODE",
  "message": "Invalid referral code"
}
```

**自我邀请 (400 Bad Request)**
```json
{
  "status": "fail",
  "code": "SELF_REFERRAL_NOT_ALLOWED",
  "message": "Cannot use your own referral code"
}
```

**用户已被邀请 (400 Bad Request)**
```json
{
  "status": "fail",
  "code": "ALREADY_REFERRED",
  "message": "User has already been referred",
  "data": {
    "inviterId": "inviter-uuid",
    "inviterName": "Inviter Name",
    "code": "DD-existing123",
    "createdAt": "2025-07-02T10:30:00.000Z"
  }
}
```

**现有用户使用邀请码成功 (200 OK)**
```json
{
  "status": "success",
  "data": {
    "token": "<jwt_token>",
    "user": {
      "id": "existing-user-uuid",
      "email": "existinguser@example.com",
      "name": "Existing User",
      "referralCode": "DD-def56789"
    },
    "invitationStatus": {
      "success": true,
      "code": "REFERRAL_SUCCESSFUL",
      "message": "Successfully used referral code"
    }
  }
}
```

**失败响应 (409 Conflict)**
```json
{
  "status": "error",
  "code": "X_ACCOUNT_ALREADY_BOUND",
  "message": "This X account is already bound to another user."
}
```

---

## 用户 API

### 获取当前用户信息
> `GET /api/users/me`

获取当前已认证用户（通过JWT）的详细个人资料。

**请求头 (Headers)**
| Key | Value |
|:--- |:--- |
| `Authorization` | `Bearer <YOUR_JWT_TOKEN>` |

**请求示例 (cURL)**
```bash
curl -X GET 'http://localhost:3000/api/users/me' \
-H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

**响应 (200 OK)**
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
      "walletAddress": "0x...",
      "xid": "123...",
      "xUsername": "twitter_handle"
    }
  }
}
```

**失败响应 (401 Unauthorized)**
```json
{
    "status": "fail",
    "code": "UNAUTHORIZED",
    "message": "Invalid or expired token."
}
```

### 更新用户信息
> `PATCH /api/users/me`

更新当前已认证用户的部分信息。只传入需要修改的字段。

**请求体 (Body)**
| 字段 | 类型 | 是否必须 | 描述 |
|:--- |:--- |:--- |:--- |
| `name` | `string` | 否 | 新的显示昵称。 |
| `avatar`| `string` | 否 | 新的头像URL。 |

**响应 (200 OK)**
```json
{
  "status": "success",
  "data": {
    "user": {
      // ... 返回更新后的完整用户信息 ...
    }
  }
}
```

### 获取用户积分
> `GET /api/users/points`

获取当前用户的总积分。

**请求头 (Headers)**
| Key | Value |
|:--- |:--- |
| `Authorization` | `Bearer <YOUR_JWT_TOKEN>` |

**响应 (200 OK)**
```json
{
  "status": "success",
  "data": {
    "points": 1250
  }
}
```

### 获取用户推荐码
> `GET /api/users/referral-code`

获取当前用户的个人推荐码和推荐网络概览。

**请求头 (Headers)**
| Key | Value |
|:--- |:--- |
| `Authorization` | `Bearer <YOUR_JWT_TOKEN>` |

**响应 (200 OK)**
```json
{
    "status": "success",
    "data": {
        "referralCode": "DD-clwxbq1uc000008l363a93rkf",
        "referralCount": 10,
        "totalNetworkCount": 25,
        "referrals": [
            {
                "id": "user-uuid-1",
                "name": "Referral One",
                "level": 1
            }
        ]
    }
}
```

### 获取当前用户注册时间
GET /api/users/registered-at

**请求头**: Authorization: Bearer <token>

**响应** (200 OK):
```json
{
  "status": "success",
  "data": { "registeredAt": "2025-01-15T08:30:00.000Z" }
}
```

---

## 活动 API

### 获取活动列表
GET /api/activities

**请求头**: Authorization: Bearer <token>

**查询参数**:
- `category`: 活动分类ID
- `search`: 搜索关键词
- `page`: 页码 (默认为1)
- `limit`: 每页数量 (默认为10)
- `isPromoted`: 是否只返回推广活动 (true/false)

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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
GET /api/activities/{activityId}

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
GET /api/activities/featured

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
POST /api/activities/{activityId}/claim

**请求头**: Authorization: Bearer <token>

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
> `GET /api/activities/claimed`

> **注意**: 这是获取用户已领取活动列表的推荐方法。系统中可能存在一个名为 `/api/activities/user-claimed` 的相似端点，该端点已废弃或为历史版本保留，不建议使用。

**请求头**: Authorization: Bearer <token>

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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
GET /api/activities/user-claimed

**请求头**: Authorization: Bearer <token>

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
PATCH /api/activities/:id/contract

**请求头**: Authorization: Bearer <token>

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
POST /api/activities/:id/deploy-contract

**请求头**: Authorization: Bearer <token>

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
GET /api/activities/created-by-me

**请求头**: Authorization: Bearer <token>

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
POST /api/activities/new

**请求头**: Authorization: Bearer <token>
Content-Type: multipart/form-data

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
GET /api/tags

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
POST /api/tags

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
POST /api/activities/:id/tags

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
GET /api/assets

**请求头**: Authorization: Bearer <token>

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
GET /api/assets/points

**请求头**: Authorization: Bearer <token>

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
        "createdAt": "2023-06
      }
    ]
  }
}
```

### 获取徽章列表
GET /api/assets/badges

**请求头**: Authorization: Bearer <token>

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
GET /api/assets/badges/{badgeId}

**请求头**: Authorization: Bearer <token>

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
POST /api/assets/badges/{badgeId}/collect

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
GET /api/assets/transactions

**请求头**: Authorization: Bearer <token>

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

---

## 通知 API

### 获取通知列表
GET /api/notifications

**请求头**: Authorization: Bearer <token>

**查询参数**:
- `page`: 页码 (默认为1)
- `limit`: 每页数量 (默认为20)
- `unreadOnly`: 是否只返回未读通知 (true/false)

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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
PATCH /api/notifications/{notificationId}/read

**请求头**: Authorization: Bearer <token>

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
PATCH /api/notifications/read-all

**请求头**: Authorization: Bearer <token>

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

---

## DataNFT 与市场 API

本章节统一管理DataNFT的创建、管理、发布和购买相关的所有API。

### 核心概念

- **快照 (Snapshot)**: 对某个活动在特定时间点的参与用户（Claims）列表的永久记录。快照是生成数据资产的基础。
- **DataNFT**: 由一个或多个"快照"合并而成的数据资产包。商家可以对其进行定价、描述、配图，并发布到公开市场进行销售。
- **市场 (Marketplace)**: 面向所有用户的公开平台，用于发现、浏览和购买已发布的DataNFT。

### 商家管理接口 (Merchant-Facing Endpoints)

#### 快照管理 (Snapshot Management)

##### 创建快照
POST /api/snapshots

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

##### 获取快照列表（支持分页、筛选）
GET /api/snapshots?page=1&limit=10&activityId=xxx&merchantId=xxx&search=xxx

**响应** (200 OK):
```json
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

##### 获取单个快照
GET /api/snapshots/{id}

**响应** (200 OK):
```json
{
  "status": "success",
  "data": { "id": "snapshot-uuid", ... }
}
```

##### 更新快照
PUT /api/snapshots/{id}

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
  "data": { "id": "snapshot-uuid", ... }
}
```

##### 删除快照
DELETE /api/snapshots/{id}

**响应** (200 OK):
```json
{
  "status": "success",
  "message": "Snapshot deleted successfully"
}
```

##### 按活动/商家获取快照
GET /api/snapshots/activity/{activityId}?page=1&limit=10
GET /api/snapshots/merchant/{merchantId}?page=1&limit=10

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

**响应** (200 OK):
```json
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

#### DataNFT 管理 (DataNFT Management)

##### 合并快照生成 DataNFT（支持图片上传）
POST /api/data-nfts/merge

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

##### 获取 DataNFT 列表（支持分页、筛选、标签）
GET /api/data-nfts?page=1&limit=10&search=xxx&minPrice=0&maxPrice=100&tags=tag-uuid-1,tag-uuid-2

**响应** (200 OK):
```json
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

##### 获取单个 DataNFT
GET /api/data-nfts/{id}

**响应** (200 OK):
```json
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

##### 更新 DataNFT（支持图片上传）
PUT /api/data-nfts/{id}

**请求头**:
- Authorization: Bearer <token>
- Content-Type: multipart/form-data

**请求体**（multipart/form-data）同创建接口。

---

##### 发布/下架 DataNFT
POST /api/data-nfts/{id}/publish
POST /api/data-nfts/{id}/unpublish
```
**响应** (200 OK):
```json
{
  "status": "success",
  "data": { ... }
}
```

##### 按商家获取 DataNFT
GET /api/data-nfts/merchant/{merchantId}

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。
```
**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "data": [ { ... } ],
    "pagination": { ... }
  }
}
```

### 公开市场接口 (Public Marketplace Endpoints)

> **注意**: 市场接口只展示已发布 (`isPublished=true`) 的 DataNFT。

#### 获取市场 NFT 数据资产列表
GET /nft-market

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。支持 `tag`, `search` 等查询参数。

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
      "description": "数据资产简介",
      "tags": ["旅游", "高净值"],
      "sales": 123,
      "revenue": 456.78
    }
  ]
}
```

#### 获取市场 NFT 数据资产详情
GET /nft-market/{id}

**请求头**:
```
Authorization: Bearer <token>
```

#### 购买市场 NFT 数据资产
POST /nft-market/{id}/purchase

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

#### 获取我购买的 NFT 数据资产
GET /nft-market/my-purchases

**请求头**:
```
Authorization: Bearer <token>
```

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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

#### 获取我发售的 NFT 数据资产及销售情况
GET /nft-market/my-sales

**请求头**:
```
Authorization: Bearer <token>
```

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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

#### 购买 DataNFT (个人)
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

#### 获取我已购买的 DataNFT
GET /api/data-nfts/purchased

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。
```
**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "data": [ { ... } ],
    "pagination": { ... }
  }
}
```

---

> 其余原有接口文档可保留，建议在目录和相关章节补充"新版快照与DataNFT API"说明。

## 推广 API

### 获取标签相关的 DataNFT 列表

GET /api/promotions/data-nfts/by-tags

**请求头**:
```
Authorization: Bearer <token>
```

**查询参数**:
- `tags`: 标签ID数组，用逗号分隔 (例如: tag-uuid-1,tag-uuid-2)
- `page`: 页码 (默认为1)
- `limit`: 每页数量 (默认为10)

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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

POST /api/promotions

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

GET /api/promotions

**请求头**:
```
Authorization: Bearer <token>
```

**查询参数**:
- `page`: 页码 (默认为1)
- `limit`: 每页数量 (默认为10)
- `status`: 状态筛选 (可选: "active", "ended", "all")

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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

GET /api/promotions/{id}

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

## 组织交易 API

### 获取组织交易记录

GET /api/organization/transactions

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

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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
### 获取奖励任务列表

GET /api/awards/:awardId/tasks

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

### 记录任务进度

POST /api/awards/tasks/:taskId/progress

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

### 领取任务奖励

POST /api/awards/tasks/:taskId/claim

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

---

### 邀请码系统 API

> **功能状态**: ✅ 已实现并测试  
> **邀请码格式**: `DD-xxxxxxxx`  
> **支持功能**: 多级邀请奖励（最多4级）

#### 核心概念
- **邀请关系建立**: 通过Web3Auth登录时使用邀请码，或通过手动绑定邀请码
- **使用条件**: 新用户注册或未被邀请过的现有用户均可使用邀请码
- **验证规则**: 防止自我邀请、重复邀请，每个用户只能被邀请一次
- **奖励机制**: 支持多级邀请奖励，最多追溯4级关系

#### 手动绑定邀请码

POST /api/referrals/use-code

允许未被邀请过的用户手动输入邀请码来建立邀请关系。

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

#### 领取推荐奖励

POST /api/referrals/claim-rewards

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

#### 获取邀请状态

GET /api/referrals/status

获取当前用户的详细邀请状态信息，包括是否被邀请、邀请人信息和已邀请的用户列表。

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

#### 获取邀请奖励概览

GET /api/referrals/overview

获取用户的邀请网络和奖励统计信息，包含多级邀请数据和奖励统计。

**Headers**:
```
Authorization: Bearer <token>
```

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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

## 通行证 API

> **注意**: 系统中存在两套与通行证相关的API。`/assets/passes` 主要用于生成实际的钱包文件（如 Apple `.pkpass` 或 Google Wallet 链接），而 `/api/passes` 用于管理数据库中的通行证记录。请根据需求选择合适的端点。

### 钱包文件生成接口 (`/assets`)

#### 生成钱包通行证文件
POST /assets/passes/generate

**请求头**: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

**请求体**:
```json
{
  "creatorId": "creator-uuid",
  "creatorName": "Creator Name",
  "creatorLogo": "/assets/logos/creator-logo.png",
  "userId": "user-uuid",
  "userName": "User Name",
  "userWalletAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "platform": "apple"
}
```

**Apple Wallet 响应** (`platform: "apple"`) (200 OK):
```json
{
  "status": "success",
  "data": {
    "passUrl": "https://api.datadance.app/assets/passes/1234567890.pkpass",
    "expiresAt": "2024-12-31T23:59:59.000Z"
  }
}
```

**Google Wallet 响应** (`platform: "google"`) (200 OK):
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

**Pass 显示说明**:
- **Apple Wallet**: Pass 背景图片会根据用户拥有的NFT数量动态展示。正面显示会员信息和NFT总数，背面显示详细信息。
- **Google Wallet**: Pass 类型为会员卡，会显示用户在该创作者下的所有NFT信息。

**错误响应**:
- `400 Bad Request`: 请求参数无效。
- `500 Internal Server Error`: 服务器内部错误，生成失败。

### 通行证记录管理接口 (`/api`)

### 创建通行证

POST /api/passes

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

### 获取用户通行证

GET /api/passes

**Request Headers**:
```
Authorization: Bearer <token>
```

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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

### 获取通行证详情

GET /api/passes/:passId

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

### 更新通行证推送Token

PUT /api/passes/:passId/push-token

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

### 删除通行证

DELETE /api/passes/:passId

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

## X (Twitter) API

### 获取 X (Twitter) 帖子详情

GET /api/x/posts/:postId

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

### X (Twitter) 账户 OAuth2 PKCE 绑定流程

#### 步骤 1: 发起授权

GET /api/x/oauth2/authorize

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

#### 步骤 2: 处理 X (Twitter) 回调

GET /api/x/oauth2/callback

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

#### 步骤 3: 获取 X (Twitter) 账户绑定状态

GET /api/x/status

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

## 爬虫与数据采集 API

> 详细的系统架构、去重逻辑、数据质量评分等说明请参考：`docs/crawler-system-overview.md`

### 核心接口

#### 获取爬虫任务列表

GET /api/crawler-tasks

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

**说明**: 该端点支持分页，详情请参考"核心概念"中的"分页"一节。

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

GET /api/crawler-tasks/{taskId}

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

POST /api/crawler/upload

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
- 400 Bad Request: Data format validation failed
- 401 Unauthorized: Authentication failed
- 429 Too Many Requests: Upload limit exceeded

#### Amazon Collection Award Integration

上传爬虫数据接口现已集成Amazon数据采集奖励系统的业务规则。当提交`source: "amazon"`的数据时，系统会自动：

- 应用每日/每月提交限制（1,000/10,000条）
- 执行重复数据检测和去重
- 按照"每10条有效数据获得100积分"的规则计算奖励
- 返回剩余配额信息

**Amazon数据格式示例**:
```json
[
  {
    "source": "amazon",
    "type": "order",
    "timestamp": "2025-01-01T12:00:00Z",
    "payload": {
      "orderid": "12345",
      "date": "2025-01-01",
      "amount": 99.99,
      "title": "Product Name",
      "currency": "USD"
    },
    "metadata": {
      "sourceUrl": "https://amazon.com/orders",
      "category": "Electronics"
    }
  }
]
```

**增强的响应** (当source为amazon时):
```json
{
  "status": "success",
  "data": {
    "uploadedCount": 2,
    "pointsEarned": 0,
    "duplicatesCount": 0,
    "message": "Data uploaded successfully",
    "amazonLimits": {
      "remainingDaily": 998,
      "remainingMonthly": 9998
    }
  }
}
```

**Amazon限制错误响应**:
```json
{
  "status": "error",
  "message": "Daily submission limit reached (1,000 items), please try again tomorrow",
  "data": {
    "remainingDaily": 0,
    "remainingMonthly": 8000
  }
}
```

#### Amazon Collection Status

GET /api/data-collection/amazon/status

**请求头**:
```
Authorization: Bearer <token>
```

**说明**: 获取用户Amazon数据采集规则和当前状态

**响应** (200 OK):
```json
{
  "status": "success",
  "data": {
    "rules": {
      "pointsPer10Items": 100,
      "dailyLimit": 1000,
      "monthlyLimit": 10000,
      "rewardRule": "Earn 100 points for every 10 valid data items submitted",
      "validationRules": [
        "Duplicate data will not be counted",
        "Invalid data will not be counted"
      ]
    },
    "userStatus": {
      "dailySubmitted": 2,
      "monthlySubmitted": 2,
      "remainingDaily": 998,
      "remainingMonthly": 9998
    }
  }
}
```

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

