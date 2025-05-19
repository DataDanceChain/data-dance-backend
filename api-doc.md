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
6. [Data Dance ID API](#data-dance-id-api)
7. [Award System API](#award-system-api)
    * [Referral System API](#referral-system-api)
    * [Task API](#task-api)
8. [X API](#x-api)
9. [Pass API](#pass-api)

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
  "invitationCode": "REF-ABCD1234" // 可选，新用户注册时可提供邀请码
}
```

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

### 生成钱包

```
POST /api/users/wallet/generate
```

**请求头**:
```
Authorization: Bearer <token>
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

## Data Dance ID API
<!-- TODO: Document routes from src/routes/dataDanceIdRoutes.js, mounted under /api/data-dance-ids -->
<!-- Example: -->
<!-- ### Get Data Dance ID Details -->
<!-- ``` -->
<!-- GET /api/data-dance-ids/{id} -->
<!-- ``` -->
<!-- Response (200 OK): -->
<!-- { -->
<!--   \"status\": \"success\", -->
<!--   \"data\": { ... } -->
<!-- } -->

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
