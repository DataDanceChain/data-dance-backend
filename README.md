# Data Dance Backend

一个基于Node.js的Web3数字身份和数据资产管理平台后端服务。

## 🚀 快速开始

### 环境要求
- Docker & Docker Compose
- Node.js 18+ (开发环境)
- PostgreSQL 数据库（可使用外部数据库或 Docker Compose 管理的数据库）

### 使用外部数据库（datadance-postgres）

如果您的 Docker Desktop 中已有运行中的 `datadance-postgres` 容器，按以下步骤配置：

1. **创建环境配置文件**
```bash
cp env.example .env
```

2. **配置数据库连接**

编辑 `.env` 文件，设置 `DATABASE_URL`：

**如果后端在 Docker 容器中运行**（推荐）：
```bash
DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/datadance?schema=public"
```

**如果后端在本地运行**：
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public"
```

3. **运行数据库迁移**
```bash
# 如果使用 Docker
docker compose exec ddc-backend-api npm run prisma:migrate

# 如果本地运行
npm run prisma:migrate
```

4. **启动后端服务**
```bash
# 使用 Docker Compose（推荐）
docker compose up -d

# 或本地运行
npm install
npm run dev
```

服务启动后：
- **API服务**: http://localhost:10000
- **数据库**: localhost:5432 (PostgreSQL - datadance-postgres 容器)

### 启动所有服务（包含数据库）

如果需要使用 Docker Compose 管理的数据库：

```bash
# 克隆仓库
git clone <repository-url>
cd data-dance-backend

# 启动所有服务（需要先取消 docker-compose.yaml 中数据库服务的注释）
docker compose up -d
```

服务启动后：
- **API服务**: http://localhost:10000
- **数据库**: localhost:15432 (PostgreSQL)

## 🎯 核心功能

### 数据NFT市场
- 数据资产创建和管理
- NFT铸造和交易
- 快照系统
- 市场订单管理

### 用户和组织管理
- 用户认证（传统/Web3）
- 组织账户支持
- 交易记录管理
- 推荐系统

### 活动系统
- 活动创建和管理
- 钱包Pass集成
- 奖励机制
- 标签分类

### 爬虫数据收集
- Amazon订单数据
- Luma事件数据
- 智能去重机制
- 数据质量评分

## 🛠 开发环境

### Docker开发（推荐）

**使用外部数据库（datadance-postgres）**：
```bash
# 1. 确保 .env 文件已配置正确的 DATABASE_URL
# DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/datadance?schema=public"

# 2. 启动开发环境
docker compose up --build

# 3. 运行数据库迁移（首次启动）
docker compose exec ddc-backend-api npm run prisma:migrate

# 4. 查看日志
docker compose logs -f ddc-backend-api
```

### 本地开发

**使用外部数据库（datadance-postgres）**：
```bash
# 1. 安装依赖
npm install

# 2. 创建环境配置文件
cp env.example .env

# 3. 配置 .env 文件中的 DATABASE_URL
# DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public"

# 4. 运行数据库迁移（首次启动）
npm run prisma:migrate

# 5. 启动开发服务器
npm run dev
```

## 🔧 技术栈

- **Node.js 22** + Express.js
- **PostgreSQL 17** + Prisma ORM
- **Docker** + Docker Compose
- **JWT** + Web3签名认证

## 📚 文档

- [API接口文档](api-doc.md) - 完整的API参考

## �� 许可证

MIT License
