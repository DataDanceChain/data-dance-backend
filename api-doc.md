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
6. [奖励 API](#奖励-api)
7. [邀请系统 API](#邀请系统-api)

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
GET /api/users/me
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
PATCH /api/users/me
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

### 获取当前用户邀请码

```
GET /api/users/invite-code
```

**请求头**:
```
Authorization: Bearer <token>
```

**响应** (200 OK):
```json
{
  "status": "success",
  "data": { "code": "INVITE12345" }
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
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
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

## 资产 API

### 获取资产总览

```
GET /api/assets
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
GET /api/assets/points
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
GET /api/assets/badges
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
GET /api/assets/badges/{badgeId}
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
POST /api/assets/badges/{badgeId}/collect
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

## 通知 API

### 获取通知列表

```
GET /api/notifications
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
PATCH /api/notifications/{notificationId}/read
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
PATCH /api/notifications/read-all
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

## 奖励 API

### 获取所有平台奖励定义
```
GET /api/awards
```
描述：返回平台上所有奖励的元数据定义。
**请求头**:
```
Authorization: Bearer <token>  // 可选：公开接口，可不传
```
**响应字段说明**:
- id (string): 奖励唯一标识
- title (string): 奖励标题
- description (string): 奖励描述
- icon (string): 奖励图标名称
- color (string): 奖励颜色值（十六进制）
- status (string): 奖励状态，取值 ["LIVE","LOCKED","INVALID"]
- metadata (object): 扩展属性

**响应示例** (200 OK):
```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "id": "profile-awards",
        "title": "Profile Awards",
        "description": "Complete your profile to earn rewards",
        "icon": "people-outline",
        "color": "#34C8B9",
        "status": "LIVE",
        "metadata": {}
      }
      // ...更多奖励定义
    ]
  }
}
```

### 获取指定奖励下的子任务列表
```
GET /api/awards/:awardId/tasks
```
描述：返回某个奖励（award）下所有任务的当前状态。
**请求头**:
```
Authorization: Bearer <token>
```
**路径参数**:
- awardId (string): 奖励 ID

**响应字段说明** (`data.tasks` 数组中的对象):
- id (string): 任务ID
- title (string): 任务标题
- description (string): 任务描述
- points (number): 完成任务可获得积分数
- claimLimit (number|null): 领取上限次数
- requirementCount (number|null): 任务达成所需的数量，如果定义则返回
- doneCount (number): 已完成的数量（用于前端显示已完成 x/y）
- prerequisiteTaskId (string|null): 前置任务ID，未完成前置任务时此任务为 LOCKED
- claimRecords (array): 已领取记录列表，包含时间戳
- claimed (boolean): 是否已达领取上限
- progress (number): 任务进度，0~1
- finalStatus (string): 任务当前状态，取值 ["LOCKED","IN_PROGRESS","COMPLETED","CLAIMED"]

**响应示例** (200 OK):
```json
{
  "status": "success",
  "data": {
    "tasks": [
      {
        "id": "profile-1",
        "title": "Complete Profile",
        "description": "Fill in name, email, avatar",
        "points": 100,
        "claimLimit": 1,
        "requirementCount": 3,
        "doneCount": 2,
        "prerequisiteTaskId": null,
        "claimRecords": [],
        "claimed": false,
        "progress": 0.67,
        "finalStatus": "IN_PROGRESS"
      }
      // ...更多任务
    ]
  }
}
```

### 记录子任务进度
```
POST /api/users/tasks/:taskId/progress
```
描述：向指定任务记录进度，触发解锁逻辑。
**请求头**:
```
Authorization: Bearer <token>
```
**路径参数**:
- taskId (string): 任务 ID
**请求体**:
```json
{ "delta": 1 }
```
- delta (number): 增量，>=1 表示可解锁或累积进度

**响应示例** (200 OK):
```json
{
  "status": "success",
  "data": {
    "taskId": "profile-1",
    "status": "IN_PROGRESS"
  }
}
```

### 领取子任务奖励
```
POST /api/users/tasks/:taskId/claim
```
描述：领取已完成的任务奖励，发放积分并解锁下游任务。
**请求头**:
```
Authorization: Bearer <token>
```
**路径参数**:
- taskId (string): 任务 ID

**响应示例** (200 OK):
```json
{
  "status": "success",
  "data": {
    "taskId": "profile-1",
    "claimedAt": "2025-05-07T12:00:00.000Z",
    "points": 100
  }
}
```

### 获取当前用户所有奖励和任务状态
```
GET /api/users/awards
```
描述：返回当前用户的所有奖励及每个奖励下子任务的状态，并附带邀请概览。
**请求头**:
```
Authorization: Bearer <token>
```

**响应字段说明**:
- awards (array): 奖励列表，每项对象包含：
  - awardId (string)
  - title (string)
  - description (string)
  - icon (string)
  - color (string)
  - metadata (object)
  - totalTasks (number): 奖励下总任务数
  - claimedTasks (number): 已领取的任务数
  - progress (number): 奖励整体进度(0~1)
  - finalStatus (string): 奖励状态，取值 ["COMING_SOON","PARTICIPATE","IN_PROGRESS","COMPLETED","CLAIMED","INVALID"]
  - tasks (array): 任务对象数组，与“获取指定奖励下的子任务列表”一致，含 `requirementCount` 和 `doneCount`
- referralOverview (object): 邀请概览，包含：
  - referrals (array): 嵌套邀请列表，对象包含 id, email, nickname, level, referrals
  - levelCounts (object): 各层级邀请人数统计
  - earnedByLevel (array): 各层级已获积分
  - totalReferralPoints (number): 推荐总积分
  - unclaimReferralAwards (number): 未领取邀请奖励积分

**响应示例** (200 OK):
```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "awardId": "profile-awards",
        "title": "Profile Awards",
        "description": "Complete your profile",
        "icon": "people-outline",
        "color": "#34C8B9",
        "metadata": {},
        "totalTasks": 2,
        "claimedTasks": 1,
        "progress": 0.5,
        "finalStatus": "IN_PROGRESS",
        "tasks": [
          {
            "id": "profile-1",
            "title": "Complete Profile",
            "description": "Fill in name, email, avatar",
            "points": 100,
            "claimLimit": 1,
            "requirementCount": 3,
            "doneCount": 2,
            "prerequisiteTaskId": null,
            "claimRecords": [],
            "claimed": false,
            "progress": 0.67,
            "finalStatus": "IN_PROGRESS"
          }
        ]
      }
    ],
    "referralOverview": {
      "referrals": [
        {
          "id": "user-123",
          "email": "ref@example.com",
          "nickname": "RefUser",
          "level": 1,
          "referrals": []
        }
      ],
      "levelCounts": { "1": 1, "2": 0, "3": 0, "4": 0 },
      "earnedByLevel": [50,0,0,0],
      "totalReferralPoints": 50,
      "unclaimReferralAwards": 0
    }
  }
}
```

## 邀请系统 API

### 获取当前用户邀请码
```
GET /api/users/invite-code
```
**请求头**:
```
Authorization: Bearer <token>
```
**响应** (200 OK):
```json
{
  "status": "success",
  "data": { "code": "INVITE12345" }
}
```

### 获取邀请概览
```
GET /api/users/referrals
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
    "referrals": [ /* 多级邀请列表 */ ],
    "levelCounts": { "1": 5, "2": 3, "3": 1, "4": 1 },
    "earnedByLevel": [50, 5, 3, 1],
    "totalReferralPoints": 59,
    "unclaimReferralAwards": 0
  }
}
```

### 领取邀请奖励
```
POST /api/users/referrals/claim
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
    "claimedAt": "2025-05-07T12:00:00.000Z",
    "totalPoints": 100,
    "count": 2
  }
}
```

### 处理新邀请
```
POST /api/users/referrals/process
```
**请求头**:
```
Authorization: Bearer <token>
```
**请求体**:
```json
{ "inviterId": "user-uuid" }
```
**响应** (200 OK):
```json
{
  "status": "success",
  "data": { "processed": true }
}
```

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