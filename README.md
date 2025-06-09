# Data Dance Backend

一个基于Node.js的Web3数字身份和活动管理平台后端服务。

## 🚀 快速开始

### 环境要求
- Docker & Docker Compose
- Node.js 18+ (开发环境)
- PostgreSQL 17 (已通过Docker提供)

### 启动服务
```bash
# 克隆仓库
git clone <repository-url>
cd data-dance-backend

# 启动所有服务
docker compose up -d

# 查看服务状态
docker compose ps
```

服务启动后：
- **API服务**: http://localhost:10000
- **数据库**: localhost:15432 (PostgreSQL)

## 📁 项目结构

```
data-dance-backend/
├── src/                      # 源代码
│   ├── controllers/          # 控制器层
│   ├── services/            # 业务逻辑层
│   ├── middlewares/         # 中间件
│   ├── routes/              # 路由定义
│   └── utils/               # 工具函数
├── scripts/                 # 工具脚本
├── docs/                    # 文档
├── prisma/                  # 数据库模式
├── config/                  # 配置文件
└── docker-compose.yaml      # Docker配置
```

## 🎯 核心功能

### 1. 用户身份管理
- 传统账号注册/登录
- Web3钱包连接
- 用户资料管理
- 推荐系统

### 2. 活动和NFT管理
- 活动创建和管理
- NFT铸造和分发
- 数字徽章系统
- 积分奖励机制

### 3. **爬虫数据系统** 🆕
- **Amazon订单数据收集** (使用orderid)
- **Luma事件数据管理** (使用eventId/taskId)
- 智能去重检测
- 数据质量评分
- 积分奖励机制



## 📚 文档

- [API接口文档](api-doc.md) - 完整的API接口说明
- [爬虫系统概述](docs/crawler-system-overview.md) - 数据收集系统架构


## 🛠 开发环境

### 本地开发
```bash
# 安装依赖
npm install

# 环境配置
cp env.example .env

# 数据库迁移
npx prisma migrate dev

# 启动开发服务
npm run dev
```

### Docker开发
```bash
# 构建和启动
docker compose up --build

# 查看日志
docker compose logs -f ddc-backend-api

# 进入容器
docker compose exec ddc-backend-api bash
```

## 🔧 核心技术栈

- **运行时**: Node.js 22
- **框架**: Express.js
- **数据库**: PostgreSQL 17 + Prisma ORM
- **认证**: JWT + Web3签名验证
- **容器化**: Docker + Docker Compose
- **API文档**: 自定义格式

## 🔍 爬虫系统亮点

### Amazon数据处理
- **唯一标识**: 使用`orderid`代替ASIN
- **用户级去重**: 同用户不能重复，不同用户可共享
- **数据验证**: 严格的订单号格式检查
- **质量评分**: 基于字段完整性的智能评分

### Luma事件管理
- **标识符优先级**: `eventId` > `taskId` > `id`
- **事件类型支持**: events, tasks
- **灵活验证**: 建议性而非强制性字段

### 查重机制
```
全局内容哈希去重 (防刷数据)
        +
用户级sourceId去重 (防重复上传)
        =
智能且用户友好的去重系统
```

## 🚦 API状态

| 模块 | 状态 | 说明 |
|------|------|------|
| 用户认证 | ✅ 稳定 | 支持传统和Web3登录 |
| 活动管理 | ✅ 稳定 | NFT和活动完整流程 |
| **爬虫系统** | ✅ **最新** | **Amazon orderid + Luma事件** |
| 推送通知 | ✅ 稳定 | APNs集成 |
| 文件上传 | ✅ 稳定 | 多种存储后端 |

## 💡 使用示例

### 上传Amazon订单
```bash
curl -X POST http://localhost:10000/api/crawler/upload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{
    "source": "amazon",
    "type": "order", 
    "payload": {
      "orderid": "113-1234567-7890123",
      "title": "iPhone 15 Pro",
      "price": "999.99",
      "currency": "USD"
    }
  }]'
```

### 上传Luma事件
```bash
curl -X POST http://localhost:10000/api/crawler/upload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{
    "source": "luma",
    "type": "event",
    "payload": {
      "eventId": "evt_123456",
      "title": "Tech Conference 2024", 
      "date": "2024-12-20T10:00:00Z"
    }
  }]'
```

## 🤝 贡献指南

1. Fork项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 运行测试确保功能正常
4. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
5. 推送到分支 (`git push origin feature/AmazingFeature`)
6. 开启Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🆘 支持

如遇问题：
1. 查看 [API文档](api-doc.md)
2. 运行测试脚本诊断问题
3. 检查Docker日志
4. 提交Issue
