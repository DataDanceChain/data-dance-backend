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

### Get User Reward List

- **GET** `/api/rewards`
- **Purpose**: Get the reward list for the currently authenticated user.
- **Authentication**: Bearer Token required.
- **Response (200 OK)**:
  ```json
  {
    "status": "success",
    "data": {
      "rewards": [
        {
          "id": "reward-uuid",
          "name": "Early Bird Reward",
          "description": "Thank you for your early participation!",
          "type": "POINTS",
          "value": 100,
          "isClaimed": false,
          "claimedAt": null
        }
      ]
    }
  }
  ```

### Claim Reward

- **POST** `/api/rewards/{rewardId}/claim`
- **Purpose**: Allows a user to claim a specific reward.
- **Authentication**: Bearer Token required.
- **Path Parameters**:
    - `rewardId`: The ID of the reward to be claimed.
- **Response (200 OK)**:
  ```json
  {
    "status": "success",
    "message": "Reward claimed successfully.",
    "data": {
      "reward": {
        "id": "reward-uuid",
        "name": "Early Bird Reward",
        "isClaimed": true,
        "claimedAt": "2023-07-15T10:00:00.000Z"
      },
      "pointsAwarded": 100 // If the reward type is points
    }
  }
  ```
- **Error Response (404 Not Found)**: If the reward does not exist or has already been claimed.
  ```json
  {
    "status": "error",
    "message": "Reward not found or already claimed."
  }
  ```

### Referral System API

### Use Referral Code

```
POST /api/referrals/use-code
```

**Request Headers**:
```
Authorization: Bearer <token>
```

**Request Body**:
```json
{
  "code": "REF-ABCD1234"
}
```

**Response** (200 OK):
```json
{
  "status": "success",
  "message": "Referral code used successfully",
  "data": {
    "referrerId": "referrer-user-id",
    "refereeId": "current-user-id",
    "code": "REF-ABCD1234"
  }
}
```

**Error Responses**:

400 Bad Request - Missing code:
```json
{
  "status": "fail",
  "code": "MISSING_CODE",
  "message": "Please provide a referral code"
}
```

409 Conflict - Already referred:
```json
{
  "status": "fail",
  "code": "ALREADY_REFERRED",
  "message": "You have already been referred and cannot use another code",
  "data": {
    "referrerId": "existing-referrer-id",
    "code": "REF-ABCD1234",
    "createdAt": "2025-05-16T..."
  }
}
```

404 Not Found - Invalid code:
```json
{
  "status": "fail",
  "code": "INVALID_CODE",
  "message": "Invalid referral code"
}
```

400 Bad Request - Self referral:
```json
{
  "status": "fail",
  "code": "SELF_REFERRAL_NOT_ALLOWED",
  "message": "Cannot use your own referral code"
}
```

### Claim Referral Rewards

```
POST /api/referrals/claim-rewards
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
    "claimedAt": "2025-05-17T12:00:00Z",
    "totalPoints": 150,
    "count": 3
  }
}
```

**Error Responses**:

400 Bad Request - No rewards to claim:
```json
{
  "status": "fail",
  "message": "No referral rewards to claim"
}
```

### Get Referral Status

Gets the detailed status of a user\'s referral relationships.

**URL** : `/api/referrals/status`

**Method** : `GET`

**Auth required** : Yes

**Permissions required** : None

#### Success Response

**Code** : `200 OK`

**Response examples**

For a user who has been invited and has invited others:

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

For a user who hasn\'t been invited:

```json
{
  "status": "success",
  "data": {
    "hasBeenInvited": false,
    "inviterInfo": null,
    "ownReferralCode": "REF-XYZ789",
    "invitedUsers": []
  }
}
```

#### Error Responses

**Code** : `500 INTERNAL SERVER ERROR`

```json
{
  "status": "error",
  "code": "SERVER_ERROR",
  "message": "Error getting referral status"
}
```

### Get Referral Overview

```
GET /api/referrals/overview
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
      "1": 3,  // Direct referrals
      "2": 2,  // Second-level referrals
      "3": 1,  // Third-level referrals
      "4": 0   // Fourth-level referrals
    },
    "earnedByLevel": [
      150,  // Points earned from level 1 referrals
      100,  // Points earned from level 2 referrals
      50,   // Points earned from level 3 referrals
      0     // Points earned from level 4 referrals
    ],
    "totalReferralPoints": 300,       // Total points earned from all levels
    "unclaimReferralAwards": 50,      // Points available to claim
    "networkActivity": 450            // Total network activity score
  }
}
```

**Response Details**:

- **referrals**: Nested tree structure of referrals up to 4 levels deep
  - **theirPoints**: Points earned by direct referees (50 points per direct referral)
  - **yourReward**: Commission earned from this referee\'s referrals (5/3/1 points per referral for levels 1/2/3)

- **levelCounts**: Number of referrals at each level (1-4)

- **earnedByLevel**: Points earned at each level, including both claimed and unclaimed points

- **totalReferralPoints**: Sum of all earned points across all levels

- **unclaimReferralAwards**: Points that are available but not yet claimed

- **networkActivity**: Overall network activity score, calculated as:
  - Total referral points
  - Plus additional activity points from level 2-4 referrals (50 points each)

**Commission Rates**:
- Level 1 (Direct): 5 points per referral
- Level 2: 3 points per referral
- Level 3: 1 point per referral
- Level 4: 0 points (tracking only)

### Task API

All Task API endpoints require authentication (Bearer Token). These routes are mounted under `/api`.

#### Get Tasks by Award

- **GET** `/api/awards/:awardId/tasks`
- **Purpose**: Retrieves a list of tasks associated with a specific award.
- **Authentication**: Bearer Token required.
- **Path Parameters**:
    - `awardId`: The ID of the award for which to fetch tasks.
- **Response (200 OK)**:
  ```json
  {
    "status": "success",
    "data": {
      "tasks": [
        {
          "id": "task-uuid-1",
          "awardId": "award-uuid",
          "name": "Complete Profile",
          "description": "Fill out all sections of your user profile.",
          "points": 50,
          "type": "PROFILE_COMPLETION", // Example type
          "status": "PENDING", // or COMPLETED, CLAIMED
          "metadata": { "requiredFields": ["bio", "avatar"] }
        }
        // ... other tasks
      ]
    }
  }
  ```
- **Error Response (404 Not Found)**: If the award ID is invalid or no tasks are found.
  ```json
  {
    "status": "error",
    "message": "Award not found or no tasks available for this award."
  }
  ```

#### Record Task Progress

- **POST** `/api/users/tasks/:taskId/progress`
- **Purpose**: Records the progress made by a user on a specific task. This might be used for tasks that have multiple steps or require specific actions to be tracked.
- **Authentication**: Bearer Token required.
- **Path Parameters**:
    - `taskId`: The ID of the task for which progress is being recorded.
- **Request Body**:
  ```json
  {
    "progress": {
      // Task-specific progress data, e.g.:
      "stepsCompleted": 2,
      "dataVerified": true
    }
  }
  ```
- **Response (200 OK)**:
  ```json
  {
    "status": "success",
    "message": "Task progress recorded successfully.",
    "data": {
      "taskProgress": {
        "taskId": "task-uuid-1",
        "userId": "user-uuid",
        "status": "IN_PROGRESS", // or COMPLETED
        "progressData": {
          "stepsCompleted": 2,
          "dataVerified": true
        },
        "updatedAt": "2025-05-17T14:30:00.000Z"
      }
    }
  }
  ```
- **Error Response (400 Bad Request)**: If the task ID is invalid or the progress data is malformed.
  ```json
  {
    "status": "fail",
    "message": "Invalid task ID or progress data."
  }
  ```

#### Claim Task Reward

- **POST** `/api/users/tasks/:taskId/claim`
- **Purpose**: Allows a user to claim the reward for a completed task.
- **Authentication**: Bearer Token required.
- **Path Parameters**:
    - `taskId`: The ID of the task to be claimed.
- **Response (200 OK)**:
  ```json
  {
    "status": "success",
    "message": "Task reward claimed successfully.",
    "data": {
      "claimedTask": {
        "id": "task-uuid-1",
        "status": "CLAIMED",
        "claimedAt": "2025-05-17T15:00:00.000Z"
      },
      "rewardDetails": { // Example: if points are awarded
        "pointsAwarded": 50
      }
    }
  }
  ```
- **Error Response (400 Bad Request)**: If the task is not yet completed, already claimed, or the task ID is invalid.
  ```json
  {
    "status": "fail",
    "message": "Task cannot be claimed. It might not be completed, already claimed, or the task ID is invalid."
  }
  ```

## X API

### 获取 X 帖子详情  

```
GET /api/x/posts/:postId
```

**参数**:
- `postId`: X 帖子 ID (必需)

**响应** (200 OK):

```json

  {

  "status": "success",

  "data": {

  "id" "1234567890",

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

### 1. X Account OAuth2 PKCE Binding Flow

This flow uses OAuth 2.0 with PKCE (Proof Key for Code Exchange) to securely bind a user's X (Twitter) account.

#### Step 1: Initiate Authorization

```http
GET /api/x/oauth2/authorize
```

**Description**:
Starts the X OAuth2.0 PKCE authorization flow. The backend generates PKCE parameters, constructs the X authorization URL, and redirects the user to X for authorization. This endpoint must be called by an authenticated user.

**Request Headers**:
```
Authorization: Bearer <token>
```

**Response**:
- `302 Found`: Redirects the user to the X authorization page.
  - `Location`: The X authorization URL.

**Error Responses**:
- `401 Unauthorized`: If the user is not authenticated.
- `500 Internal Server Error`: If the authorization URL generation fails.
  ```json
  {
    "status": "error",
    "code": "X_OAUTH_START_FAILED",
    "message": "Failed to start X OAuth2 authorization."
  }
  ```

#### Step 2: Handle X Callback

```http
GET /api/x/oauth2/callback
```

**Description**:
X redirects the user to this endpoint after they have authorized the application. The backend exchanges the received authorization `code` and `state` for an X access token and refresh token, retrieves the user's X profile information, and links the X account to the authenticated user in the system.

**Query Parameters**:
- `code`: The authorization code provided by X.
- `state`: The state parameter originally sent by the backend to X, used for CSRF protection and linking the callback to the correct user session.

**Response**:
- `302 Found`: Redirects the user to a frontend URL (e.g., `process.env.X_OAUTH_CALLBACK_URL`) indicating the outcome of the binding process.
  - `Location`: e.g., `https://yourfrontend.com/settings/connections?x_status=success` or `https://yourfrontend.com/settings/connections?x_status=error&code=STATE_INVALID`

**Error Responses Handled by Redirect**:
The endpoint typically redirects to the frontend with query parameters indicating success or failure. Common error scenarios include:
- Invalid or missing `state` parameter (e.g., `x_status=error&code=STATE_INVALID`).
- Invalid or missing `code` parameter (e.g., `x_status=error&code=CODE_INVALID`).
- Failure to exchange code for token (e.g., `x_status=error&code=TOKEN_EXCHANGE_FAILED`).
- Failure to fetch X user info (e.g., `x_status=error&code=USER_INFO_FETCH_FAILED`).
- X account already linked to another user (e.g., `x_status=error&code=X_ACCOUNT_ALREADY_BOUND`).
- Database update failure (e.g., `x_status=error&code=DATABASE_UPDATE_FAILED`).

#### Step 3: Get X Account Binding Status

```http
GET /api/x/status
```

**Description**:
Retrieves the X account binding status for the currently authenticated user.

**Request Headers**:
```
Authorization: Bearer <token>
```

**Response** (200 OK - X Account Bound):
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

**Response** (200 OK - X Account Not Bound):
```json
{
  "status": "success",
  "data": {
    "bound": false
  }
}
```

**Error Responses**:
- `401 Unauthorized`: If the user is not authenticated.
- `500 Internal Server Error`: If there's an issue fetching the status.
  ```json
  {
    "status": "error",
    "code": "STATUS_FETCH_FAILED",
    "message": "Failed to fetch X binding status."
  }
  ```