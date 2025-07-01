# Data Dance Backend 开发者指南

## 📋 目录

- [项目简介](#项目简介)
- [快速开始](#快速开始)
- [开发详细说明及指南](#开发详细说明及指南)
  - [项目架构](#项目架构)
  - [环境配置](#环境配置)
  - [开发工作流](#开发工作流)
  - [数据库管理](#数据库管理)
  - [API开发指南](#api开发指南)
  - [爬虫系统详解](#爬虫系统详解)
  - [测试指南](#测试指南)
  - [部署指南](#部署指南)
- [外部资源和工具](#外部资源和工具)
- [历史记录](#历史记录)

---

## 🚀 项目简介

**Data Dance** 是一个 **Web3 数字身份和数据资产管理平台**的后端服务，致力于将用户数据转化为可交易的数字资产，构建完整的数据价值流通生态。

### 核心目标
- **数据资产化**：将用户数据转化为可交易的 NFT 资产
- **身份数字化**：提供统一的 Web3 数字身份管理
- **价值流通**：构建数据资产交易市场生态
- **激励机制**：通过积分、徽章、活动等激励用户参与

### 技术栈
- **后端框架**：Node.js + Express.js
- **数据库**：PostgreSQL 17 + Prisma ORM
- **部署**：Docker + Docker Compose
- **认证**：JWT + Web3签名认证
- **区块链**：Ethers.js
- **移动集成**：Apple Wallet + Google Wallet

---

## 🏃‍♂️ 快速开始

### 环境要求
- Docker & Docker Compose
- Node.js 18+ (开发环境)

### 启动服务
```bash
# 克隆仓库
git clone <repository-url>
cd data-dance-backend

# 启动所有服务
docker compose up -d
```

服务启动后：
- **API服务**: http://localhost:10000
- **数据库**: localhost:15432 (PostgreSQL)

### 开发环境
```bash
npm install
cp .env.example .env
npm run dev
```

---

## 🔧 开发详细说明及指南

### 项目架构

#### 分层架构设计
```
前端层 (Mobile/Web)
    ↓
API 网关层 (Express.js)
    ↓
业务逻辑层 (Services)
    ↓
数据访问层 (Prisma ORM)
    ↓
存储层 (PostgreSQL)
```

#### 文件结构
```
data-dance-backend/
├── src/                    # 核心源代码
│   ├── app.js             # Express应用主入口
│   ├── controllers/       # 19个控制器，处理HTTP请求
│   ├── middlewares/       # 中间件(认证、验证、错误处理)
│   ├── routes/           # API路由定义
│   ├── services/         # 业务逻辑服务层
│   └── utils/            # 工具类(日志、数据库、JWT)
├── prisma/               # 数据库Schema和迁移
├── docs/                 # 项目文档
├── scripts/              # 数据库种子和工具脚本
├── keys/                 # 证书和密钥文件
├── public/               # 静态资源文件
├── config/               # 配置文件
├── logs/                 # 日志文件
└── db/                   # 本地数据库数据
```

#### 核心功能模块

1. **用户管理系统**
   - 多种登录方式(传统/Web3Auth/钱包)
   - 用户画像和组织管理
   - 权限和角色控制

2. **活动生态系统**
   - 活动创建和管理
   - NFT 活动和会员权益
   - 活动推广和营销

3. **数据资产市场**
   - 数据快照创建
   - DataNFT 生成和交易
   - 市场订单管理

4. **爬虫数据系统**
   - Amazon/Luma 数据采集
   - 数据质量评分(0-100分)
   - 多层去重机制

5. **数字钱包集成**
   - Apple Wallet Pass 生成
   - Google Wallet 支持
   - Push 通知系统

6. **激励系统**
   - 积分奖励机制
   - 徽章收集系统
   - 推荐奖励网络

### 环境配置

#### 开发环境
- **数据库**：PostgreSQL 17 (localhost:15432)
- **API服务**：Node.js Express (localhost:10000)
- **热重载**：Nodemon 支持
- **CORS**：开发环境启用

#### 生产环境
- **容器化**：Docker 多阶段构建
- **数据库**：生产级 PostgreSQL
- **环境变量**：安全的配置管理
- **CORS**：生产环境限制

#### 环境变量配置
```bash
# 复制环境变量模板
cp .env.example .env

# 主要配置项
DATABASE_URL=postgresql://user:password@localhost:15432/datadance
JWT_SECRET=your-jwt-secret
APNS_KEY_PATH=./keys/apns/DataDanceAppPushNotificationKey.p8
```

### 开发工作流

#### 1. 代码结构规范
- **Controllers**: 处理HTTP请求，参数验证
- **Services**: 业务逻辑实现
- **Middlewares**: 认证、权限、错误处理
- **Utils**: 通用工具函数

#### 2. API开发流程
1. 在 `routes/` 中定义路由
2. 在 `controllers/` 中实现控制器
3. 在 `services/` 中实现业务逻辑
4. 添加必要的中间件
5. 更新API文档

#### 3. 编码规范
- 使用 ES6+ 语法
- 统一的错误处理格式
- 详细的日志记录
- 安全的数据验证

### 数据库管理

#### Prisma 命令
```bash
# 生成客户端
npm run prisma:generate

# 数据库迁移
npm run prisma:migrate

# 数据库管理界面
npm run prisma:studio

# 种子数据
npm run seed:all
```

#### 核心数据模型
- **User/UserProfile**: 用户和档案管理
- **Activity/ActivityClaim**: 活动和参与记录
- **DataNFT/Snapshot**: 数据资产和快照
- **Badge/Award**: 徽章和奖励系统
- **Transaction**: 交易和积分记录
- **CrawlerData**: 爬虫数据存储

### API开发指南

#### 响应格式标准
```json
{
  "status": "success|fail|error",
  "data": {},
  "message": "描述信息"
}
```

#### 认证机制
- JWT Token 认证
- Web3 钱包签名验证
- 传统密码认证
- X(Twitter) OAuth

#### 中间件使用
```javascript
// 认证中间件
app.use('/api/protected', authMiddleware);

// 文件上传中间件
app.use('/api/upload', uploadMiddleware);

// 错误处理中间件
app.use(errorMiddleware);
```

#### Award System 状态管理

Award System 包含复杂的任务状态计算逻辑，主要通过 `finalStatus` 字段体现：

##### finalStatus 生成逻辑

Award 级别的 `finalStatus` 计算逻辑（位于 `awardService.js`）：

```javascript
let finalStatus;
if (claimedCount === total && total > 0) {
  finalStatus = 'CLAIMED';           // 所有任务已完成并领取奖励
} else if (completedCount === total && total > 0) {
  finalStatus = 'COMPLETED';         // 所有任务已完成，可领取奖励
} else if (completedCount > 0 || claimedCount > 0) {
  finalStatus = 'IN_PROGRESS';       // 部分任务已完成
} else if (award.status === 'LIVE' && ua.status === 'LOCKED') {
  finalStatus = 'PARTICIPATE';       // 可参与状态
} else if (award.status === 'LOCKED') {
  finalStatus = 'COMING_SOON';       // 即将开放
} else {
  finalStatus = 'PARTICIPATE';       // 默认可参与
}
```

Task 级别的 `finalStatus` 计算逻辑（位于 `taskService.js`）：

```javascript
// 基本状态判断
if (userTask.claimed) {
  finalStatus = 'CLAIMED';           // 已领取奖励
} else if (progress >= 1) {
  finalStatus = 'COMPLETED';         // 已完成，可领取
} else if (progress > 0) {
  finalStatus = 'IN_PROGRESS';       // 进行中
} else {
  finalStatus = 'LOCKED';            // 未开始
}

// 特殊处理：无限制任务（如Amazon数据采集）
if (taskHasNoLimit && progress > 0) {
  finalStatus = 'IN_PROGRESS';       // 始终显示进行中
}
```

##### Progress 计算规则

不同类型任务的进度计算方式：

1. **固定目标任务**（如收集NFT）：
   ```javascript
   progress = currentCount / targetCount
   ```

2. **无限制任务**（如Amazon数据采集）：
   ```javascript
   progress = totalSubmittedCount  // 整数，表示总提交量
   ```

3. **条件任务**（如早期注册）：
   ```javascript
   progress = condition ? 1 : 0    // 满足条件为1，否则为0
   ```

##### 状态优先级

状态优先级从高到低：
1. `CLAIMED` - 已领取奖励
2. `COMPLETED` - 已完成，待领取  
3. `IN_PROGRESS` - 进行中
4. `PARTICIPATE` - 可参与
5. `LOCKED` - 未解锁
6. `COMING_SOON` - 即将开放

### 爬虫系统详解

#### 系统概述

Crawler系统是一个用于收集、验证和管理用户提交数据（主要来自Amazon和Luma）的后端服务。系统包含数据验证、多层去重和积分奖励等功能。

#### 核心组件

- **服务层 (`crawlerService.js`)**: 核心服务，负责协调整个数据处理流程
- **验证模块**: 确保数据格式的完整性和正确性
- **去重引擎**: 在全局和用户两个层级防止重复数据
- **积分服务**: 为有效的数据提交计算和发放积分
- **数据存储**: 使用PostgreSQL数据库和Prisma ORM

#### 数据源与标识符

系统处理多种数据源，每种数据源都有其唯一的标识逻辑：

**Amazon 数据**
- **主标识符**: `orderid` (例如: `113-1234567-7890123`)
- **数据类型**: `order`
- **关键字段**: `orderid` 是必需的

**Luma 数据**
- **主标识符**: `eventId`、`taskId`或`id` (按此优先级)
- **数据类型**: `event`, `task`

#### 数据质量评分

为每条提交的数据计算一个0-100的分数，以评估其质量：

| 分类 | 评分标准 | 分数 |
| :--- | :--- | :--- |
| **官方标识符** | Amazon: 有`orderid`。Luma: 有`eventId`/`taskId`/`id`。 | **40** |
| **元数据** | 有`sourceUrl` (15), 有`category` (10)。 | **25** |
| **标准字段** | Amazon: `title`+`price` (15), `currency` (10)。Luma: `title` (15), `date` (10)。 | **25** |
| **格式规范** | 有效的`timestamp`。 | **10** |

#### 积分奖励

- **计算规则**: 每提交**10条**有效数据，用户获得**100积分**
- **上传限制**: 每日1,000条，每月10,000条
- **无效数据**: 重复或无效数据不计分

#### 数据处理流程

系统通过以下流水线处理数据：

```
用户提交数据 → 格式验证 → 质量评分 → 批次内去重 → 数据库去重 → 存储有效数据 → 计算并授予积分 → 返回API响应
```

#### 去重策略

采用三层防护机制来保证数据唯一性：

- **第1层：验证**: 验证数据源、类型、`payload`和标识符格式
- **第2层：批次内检查**: 扫描同一次提交的数据，通过`contentHash`和标题相似度进行检查
- **第3层：数据库检查**:
  - **全局去重**: `contentHash`全局唯一，防止任何用户提交完全相同的内容
  - **用户级去重**: `sourceId`在单个用户内唯一

#### 数据库设计

核心的 `CrawlerData` 表结构：

```prisma
model CrawlerData {
  id          String   @id @default(cuid())
  source      String   // 'amazon' or 'luma'
  type        String
  timestamp   DateTime
  payload     Json
  metadata    Json?
  contentHash String   @unique // 全局去重哈希
  sourceId    String?  // 用户级去重ID
  userId      String
  points      Int      @default(0)

  // 用户、数据源和sourceId的组合必须唯一
  @@unique([userId, source, sourceId])
  @@index([userId, source])
}
```

#### API 接口

**上传爬虫数据**
```
POST /api/crawler/upload
Authorization: Bearer <token>
```

**请求体格式**:
```json
[
  {
    "source": "amazon",
    "type": "order",
    "timestamp": "2025-06-02T11:58:00Z",
    "payload": {
      "orderid": "113-1234567-7890123",
      "title": "Wireless Bluetooth Headphones"
    },
    "metadata": { "category": "Electronics" }
  }
]
```

**获取爬虫任务列表**
```
GET /api/crawler-tasks?source=amazon&status=running&page=1&limit=10
```

**数据格式要求**:
```typescript
interface DataItem {
  source: 'amazon' | 'luma';
  type: 'order' | 'product' | 'event' | 'task' | 'custom';
  timestamp: string;  // ISO 8601 格式
  payload: Record<string, any>; // 主要数据对象
  metadata?: {
    sourceUrl?: string;
    category?: string;
    region?: string;
  };
}
```

### 测试指南

#### 测试账号
- 邮箱：test@example.com
- 密码：password123

#### API测试
```bash
# 使用测试脚本
node scripts/testPushNotification.js
node scripts/testWeb3Auth.js
```

### 部署指南

#### Docker 部署
```bash
# 构建镜像
docker compose build

# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f ddc-backend-api
```

#### 生产环境配置
1. 设置生产环境变量
2. 配置SSL证书
3. 设置数据库连接池
4. 配置日志轮转
5. 设置监控和告警

---

## 📚 外部资源和工具

### API 文档
> **详细内容**: 参见 [api-doc.md](../api-doc.md)

提供完整的 REST API 接口文档，包括：
- 认证 API (注册、登录、Web3Auth)
- 用户管理 API (档案、积分、钱包)
- 活动系统 API (创建、领取、管理)
- 数据资产 API (NFT、市场、交易)
- 通知系统 API (推送、消息)

### 区块链集成
> **技术栈**: Ethers.js + Web3Auth

核心功能：
- 钱包连接和签名验证
- 智能合约交互
- NFT 铸造和转账
- 多链支持 (Ethereum, Polygon)

### 移动钱包集成
> **支持平台**: Apple Wallet + Google Wallet

主要特性：
- Pass 生成和分发
- 会员卡管理
- Push 通知更新
- 过期和撤销机制

### 推送通知系统
> **服务**: Apple Push Notification Service (APNS)

功能包括：
- 设备注册管理
- 消息队列处理
- 批量推送支持
- 错误处理和重试

### 社交媒体集成
> **平台**: X (Twitter) API

集成功能：
- OAuth 登录认证
- 用户信息同步
- Token 管理和刷新

### 数据库设计
> **技术**: PostgreSQL + Prisma ORM

设计特点：
- 关系型数据模型
- 完整的审计日志
- 灵活的权限控制
- 可扩展的元数据存储

### 日志和监控
> **工具**: Winston + Morgan

监控功能：
- 结构化日志记录
- 性能指标追踪
- 错误堆栈跟踪
- 请求响应日志

### 安全机制
> **策略**: 多层安全防护

安全措施：
- JWT Token 管理
- 请求频率限制
- 文件上传验证
- SQL 注入防护
- 环境变量保护

---

## 📝 历史记录

### v1.0.0 - 初始版本 (2024-03)
- ✅ 基础用户管理系统
- ✅ 活动创建和领取功能
- ✅ Apple Wallet Pass 集成
- ✅ 基础NFT功能

### v1.1.0 - 数据资产系统 (2024-05)
- ✅ 数据快照功能
- ✅ DataNFT 市场
- ✅ 推广活动系统
- ✅ Google Wallet 支持

### v1.2.0 - 爬虫系统 (2024-06)
- ✅ Amazon 数据爬虫
- ✅ Luma 事件爬虫
- ✅ 数据质量评分
- ✅ 智能去重机制

### v1.3.0 - 激励系统 (2024-06)
- ✅ 奖励系统重构
- ✅ 推荐网络
- ✅ 积分交易
- ✅ 徽章收集

### 最新更新
- 🔧 .gitignore 文件优化
- 📚 开发者指南创建
- 🏗️ 项目结构分析和优化

### 计划功能
- 🔮 智能合约部署自动化
- 🔮 多链支持扩展
- 🔮 AI 数据分析功能
- 🔮 实时数据同步

---

## 🤝 贡献指南

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

MIT License

---

*最后更新: 2024-06-29*