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

### Connect AI (MCP + OAuth)
- Life Capsule 画像：`GET /api/life-context`，分享档 public / transparent / intimate
- MCP 工具：`POST /mcp`（`get_public_profile`、`get_boundaries`、`get_life_capsule`、`search_life_signals`）
- ChatGPT / Claude 走 **OAuth 2.1 + PKCE**（CIMD 或 `POST /oauth/register`），同意页用现有 Web3Auth 登录
- 发现文档：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`
- 环境变量：`PUBLIC_BASE_URL`（API / issuer）、`APP_PUBLIC_URL`（钱包同意页）
- 迁移：`20260903090000_add_mcp_oauth`；说明见 [docs/LIFE_CONTEXT_MCP.md](docs/LIFE_CONTEXT_MCP.md)
- Web3Auth 只负责人登录钱包，不当 ChatGPT / Claude 的授权服务器

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

## 🛡 运行加固 (Operational hardening)

- **反向代理与真实 IP**：`TRUST_PROXY_HOPS`（默认 1）设置 Express `trust proxy`，`req.ip` 取自 `X-Forwarded-For`，限流按真实客户端 IP 计。直连公网时设为 `0`，否则任何客户端都能用伪造的 `X-Forwarded-For` 绕过限流。
- **请求 ID**：每个请求带 `X-Request-Id`（透传上游的安全字符串，否则生成 UUID），回写响应头，`Request completed` / `Request failed` 日志带 `reqId`，一次登录可按 id 串起来查。
- **日志脱敏**（`src/utils/logger.js`）：访问日志（morgan）和 winston 日志里的 URL query 值 `access_token, token, code, ticket, id_token, idToken, client_secret, refresh_token, code_verifier, password, otp` 一律掩码（保留前 4 字符 + 长度；`password` / `otp` 及短值整体隐藏）；日志 meta 对象里同名键、`authorization` 头（保留 scheme）、`email`（只留域名）、`walletAddress`（前 6 + 后 4）递归掩码，含嵌套对象与数组。验收：跑一遍登录/授权流程后 `grep -r 'ddc_tge_\|ddc_code_\|ddc_tkt_\|client_secret=' logs/` 为零。
- **`/mcp` 不再接受 `?access_token=`**：只认 `Authorization: Bearer`，token 不再进入访问日志。
- **限流**（`src/middlewares/rateLimitMiddleware.js`，`rateLimiters.*`）：

  | 限流器 | 挂载 | 额度 | 键 |
  | --- | --- | --- | --- |
  | `auth` | `POST /api/auth/login`、`/register` | 15 分钟 5 次失败 | IP（不再按提交的 email） |
  | `web3authLogin` | `POST /api/auth/web3auth-login` | 每分钟 10 次 | IP |
  | `opsLogin` | `POST /api/ops/auth/login` | 15 分钟 5 次失败 | IP |
  | `oauthRegister` / `oauthAuthorize` / `oauthToken` / `oauthRevoke` | `/oauth/*`（由 OAuth 路由挂载） | 5 / 30 / 20 / 20 每分钟 | IP |
  | `consent` | `POST /api/oauth/consent` | 每分钟 10 次 | 用户 id，未登录按 IP |
  | `partner` | `/partner/tge/*` | 每分钟 120 次 | bearer token 的 sha256 |
  | `ssoTicket` / `ssoExchange` | `/api/sso/*`（Phase 3） | 5 / 10 每分钟 | 用户 id / IP |

  超限返回 429 并带 `Retry-After`（秒）；`/oauth/*`、`/partner/*` 下的 body 为 `{ error: 'slow_down', error_description }`，其它路径保持 `{ status: 'error', message, retryAfter }`。
- **单实例限制**：限流计数与 OAuth PKCE 状态都在进程内存里。**起第二个副本前必须换成共享存储**（`rate-limiter-flexible` + Redis 已在依赖里），否则每个副本各算一份额度，T16 不能签收。
- **日志留存**：`logs/*.log` 只滚动 5 × 5 MB；没有审计表时 stdout 必须接到有活动周期留存的日志平台，否则封禁/退出核对没有证据。
- **测试**：`npm test`（`node --test`）跑 `test/unit/*.test.js` 与 `src/**/*.test.js`，不需要数据库。

## 🔧 技术栈

- **Node.js 22** + Express.js
- **PostgreSQL 17** + Prisma ORM
- **Docker** + Docker Compose
- **JWT** + Web3签名认证

## 📚 文档

- [API接口文档](api-doc.md) - 完整的API参考
- [Connect AI / MCP](docs/LIFE_CONTEXT_MCP.md) - Life Capsule 工具、OAuth 2.1 + PKCE、ChatGPT / Claude 接入

## �� 许可证

MIT License
