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

### Web3Auth ID token verification
- `POST /api/auth/web3auth-login` verifies the Web3Auth ID token (`idToken` in the body) against the Web3Auth JWKS with `jose` and maps the user by the upstream identity pair (`User.web3authVerifier`, `User.web3authVerifierId`); e-mail / name / avatar on that path come only from the verified token. Sessions minted from a verified token carry `ver: 2`.
- `WEB3AUTH_VERIFY_MODE`: `off` (legacy client-asserted login only; refused at boot in production) → `log` → `enforce` (`idToken` required, token decides). In `log`, a **supplied token that is rejected fails closed exactly as under `enforce`** (`idtoken_rejected`, `outcome: refused`) — it is never downgraded to the legacy path; a request with **no** `idToken` is refused with `IDTOKEN_REQUIRED` unless `WEB3AUTH_ALLOW_LEGACY_FALLBACK=true`.
- `WEB3AUTH_ALLOW_LEGACY_FALLBACK` (default `false`) is the only switch that still lets a body-asserted identity (`userInfo.email` / `walletAddress` / `xid`) mint a session, and only in `log` with no `idToken`. Rollout: `log` + fallback on → watch the `legacy_login` warning count drop to zero as Wallet builds send the token → fallback off → `enforce` (test, then prod). Old App builds without `idToken` cannot log in once it is off.
- Legacy `web3auth` rows are linked lazily on first verified login by exactly two routes: (a) the token **proves the wallet the row already holds** (cryptographic; a row with a NULL wallet proves nothing and no longer counts as “wallet-consistent”), or (b) the row is found by the e-mail the token carries **and** the verifier is named in `WEB3AUTH_LEGACY_VERIFIERS` (empty = never) **and** the token asserts `email_verified === true` (`WEB3AUTH_EMAIL_VERIFIED_CLAIM`). The row must also be unlinked, `web3auth`, non-organization and free of a wallet mismatch. Anything else — password (`traditional`) accounts, already-linked rows, an unverified or non-allow-listed e-mail — answers `IDENTITY_CONFLICT` and is never merged. Rationale: the Web3Auth client id ships in the SPA bundle, so an IdP-asserted e-mail alone is not proof of ownership (plan §5 F03). An e-mail-shaped `verifierId` is lower-cased before it is stored as the identity key.
- **Accepted login connections — `WEB3AUTH_ALLOWED_VERIFIERS` (csv).** The identity key is read from whichever of `aggregateVerifier` / `verifier` / `groupedAuthConnectionId` / `authConnectionId` the token carries first, and that value used to be accepted whatever it said. It is a Web3Auth *connection name*, so anyone who can add a connection in the DataDance Web3Auth project — a console credential, a hijacked dashboard session — could mint a correctly signed token for our audience, choose any `verifierId`, and be that user; no signature check sees it, because the signature is genuine. The list is now the gate: **required under `enforce` (boot refuses an empty list, same shape as the `WEB3AUTH_CLIENT_ID` assertion)**, a token from an unlisted connection is `401 IDTOKEN_VERIFIER_NOT_ALLOWED`, and under `log` it is accepted but logged as `idtoken_verifier_not_allowed` on every request so the rollout cannot end quietly with the list wrong. Include `external-wallet` if sign-in-with-wallet is offered — the synthetic external-wallet identity is not exempt. The list also guards **every** lazy link into an existing account, the wallet-proven route included (that route set no reason and therefore skipped both this list and the `email_verified` requirement).
- Error codes: `IDTOKEN_REQUIRED` (400), `IDTOKEN_INVALID`, `IDTOKEN_EXPIRED`, `IDTOKEN_ISSUER`, `IDTOKEN_AUDIENCE`, `IDTOKEN_SIGNATURE`, `IDTOKEN_VERIFIER_NOT_ALLOWED`, `WALLET_NOT_IN_TOKEN` (401), `IDENTITY_CONFLICT` (409), `ORG_NOT_ALLOWED`, `ACCOUNT_DISABLED` (403). `ACCOUNT_DISABLED` (`User.disabledAt`) is also refused by `protect`, `authenticate`, password login and MCP tokens.
- Env (see `env.example`): `WEB3AUTH_VERIFY_MODE`, `WEB3AUTH_CLIENT_ID`, `WEB3AUTH_ALLOWED_VERIFIERS`, `WEB3AUTH_JWKS_URL`, `WEB3AUTH_ISSUERS`, `WEB3AUTH_EXTERNAL_JWKS_URL`, `WEB3AUTH_EXTERNAL_ISSUERS`, `WEB3AUTH_EXTERNAL_AUDIENCE`, `WEB3AUTH_ALGS`, `WEB3AUTH_MAX_TOKEN_AGE`, `WEB3AUTH_VERIFIER_CLAIM`, `WEB3AUTH_VERIFIER_ID_CLAIM`, `WEB3AUTH_EMAIL_CLAIM`, `WEB3AUTH_WALLETS_CLAIM`, `WEB3AUTH_WALLET_MATCH`, `WEB3AUTH_LEGACY_VERIFIERS`, `WEB3AUTH_EMAIL_VERIFIED_CLAIM`, `WEB3AUTH_ALLOW_LEGACY_FALLBACK`. `JWT_EXPIRES_IN` is mandatory in production.
- 迁移：`20260922100000_user_upstream_identity_and_disable`；单测：`npm test`（`test/unit/web3authIdentity.test.js` 和 `test/unit/web3authLogin.test.js`，本地 JWKS + supertest，无需数据库）

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

## 🛡 金融级加固：合作方 SSO（Partner SSO boot assertions）

TGE 页面这条链路上可能有很大金额，所以协议之外的"部署形态"也必须被程序本身卡死。以下三件事是
这次加固里最需要运维知道的：

### 1. 启动断言：`SSO_TGE_ENABLED=true` 时不满足就拒绝启动

`src/server.js` 在 `assertPartnerConfig()` 之后再调用 `assertFinancialGradeConfig()`，一次把所有问题
列全后抛错（摘要里不含任何密钥值）。必须同时满足：

| 条件 | 为什么 |
| --- | --- |
| `NODE_ENV=production` | 否则开发态 CORS、堆栈、`off` 验签模式都还够得着 |
| `WEB3AUTH_VERIFY_MODE=enforce` | `log` 模式下不在白名单里的登录方式只是"记一笔"，仍然放行 |
| `WEB3AUTH_ALLOW_LEGACY_FALLBACK=false` | 这是历史上的"请求体自报身份"接管路径 |
| `WEB3AUTH_CLIENT_ID` 非空 | ID token 的预期受众 |
| `WEB3AUTH_ALLOWED_VERIFIERS` 非空 | 见下一节，这是"谁能成为任何人"的那把锁 |
| `SSO_SESSION_SECRET` 已设且 ≠ `JWT_SECRET` | 这个差异就是"同意页会话打不开别的接口"的全部依据 |
| `PUBLIC_BASE_URL` / `APP_PUBLIC_URL` 已设且是 https | 签发方标识与同意页来源 |

没有开关可以关掉这组断言：要放松就把 `SSO_TGE_ENABLED` 关掉。启动日志会打印一行摘要
（`Partner SSO money-path assertions OK: …`），含模式、白名单条数、issuer、同意页来源、动态注册开关状态，不含密钥。

### 2. 登录方式白名单 `WEB3AUTH_ALLOWED_VERIFIERS`

身份键取自 ID token 里的连接名（`aggregateVerifier` / `verifier` / `groupedAuthConnectionId` /
`authConnectionId` 取第一个存在的）。以前这个值是什么都收：**谁能在 DDC 的 Web3Auth 项目里加一个连接
（一份控制台凭据、一次被盗的后台会话），谁就能签出对我们受众有效的 token、挑一个 `verifierId`，
成为那个用户**——签名是真的，所以验签永远看不出来。现在：

- `enforce`：不在白名单里的连接 → `401 IDTOKEN_VERIFIER_NOT_ALLOWED`；**白名单为空则拒绝启动**
  （与 `WEB3AUTH_CLIENT_ID` 同一形状的断言）。
- `log`：放行，但每一个 token 都打 `idtoken_verifier_not_allowed` 告警，灰度不会悄悄结束。
- 用外部钱包登录的话，`external-wallet` 也要显式写进白名单，它不是例外。
- 白名单同时守住**所有**懒绑定老账号的路径，包括"钱包被 token 证明"那条（那条以前不设 reason，
  于是既绕过了老账号白名单也绕过了 `email_verified` 要求）。

### 3. 授权请求绑定发起它的浏览器（没有开关）

`GET /oauth/authorize` 会种一个 `__Host-ddc_authz` Cookie（HttpOnly、Secure、SameSite=Lax、Path=/、
无 Domain），并把它的 sha256 存进授权请求行；`POST /api/oauth/consent` 的**批准**必须带回同一个值，
否则不签发授权码，返回 `409 AUTHZ_INITIATOR_MISMATCH`，同意页据此提示"这次登录是在另一台设备或另一个
浏览器里开始的，请从 {客户端} 重新开始"。**拒绝**不受影响（任何浏览器都能把请求作废）。

- 钱包同意页的请求必须带上 Cookie：`fetch(url, { credentials: 'include' })`。
  `app.datadance.ai → api.datadance.ai` 是同站（跨源），SameSite=Lax 不会拦，但不带 credentials 就收不到。
- App 交接（`/api/sso/*`）不受影响：票据在系统浏览器里兑换，合作方也在同一个系统浏览器里发起
  `/oauth/authorize`，Cookie 就落在那里，同意页从同一浏览器提交。WebView 从头到尾不需要这个 Cookie。
- 一个浏览器一个 nonce（不是一次授权一个），所以两个标签页同时登录都能完成。
- 行上另有 `initiatorBoundAt` / `initiatorMismatchCount`，加上 `oauth.authz_initiator_mismatch` 告警日志。
- 迁移：`20260922120000_authz_initiator_binding`（三个可空列，向前向后都安全）。

### 4. 合作方接口真正只读

`/partner/tge/*` 的处理函数运行在一个只读作用域里（`src/utils/prismaReadOnly.js`，AsyncLocalStorage +
包装写方法）：**请求进行中任何 Prisma 写操作直接抛错**，哪怕它发生在很深的 helper 里。`GET /status`
不再懒分配推荐码（那是一次 `$executeRaw` UPDATE），已有的展示码照常返回，没有就是 `null`。
唯一保留的写是认证阶段刷新 `McpToken.lastUsedAt`，它发生在只读作用域打开之前。

### 5. 活动期间关掉公共客户端注册

`OAUTH_PUBLIC_REGISTRATION_ENABLED=false` → `POST /oauth/register` 与 CIMD 客户端元数据抓取一律 403，
活动窗口内不会冒出新的客户端。默认 `true`，保持今天的 ChatGPT / Claude 行为。

## 🛡 运行加固 (Operational hardening)

- **反向代理与真实 IP**：`TRUST_PROXY_HOPS`（默认 **1**）设置 Express `trust proxy`，`req.ip` 取自 `X-Forwarded-For`，限流按真实客户端 IP 计。默认值是 1 而不是链路跳数：生产 nginx 只设 `Host`/`Upgrade`/`Connection`，**不追加** `X-Forwarded-For`，所以容器看到的只有 Cloudflare 写入的那一条，也就是真实客户端。设成 2 会让 Express 跳过那一条、退回到**客户端自己发的**值，于是任何人都能用伪造的 `X-Forwarded-For` 绕过所有按 IP 的限流。上线前必须用一次真实请求核对（启动摘要会打印该值）；源站若直连公网则设 `0`。
  - **上线前必须用一次真实请求核对这个值**（比如临时打一条 `req.ip` 日志，确认等于终端用户地址）：少算一跳时 `req.ip` 是 Cloudflare 边缘地址，同一个 PoP 后面的所有用户共用一个限流桶；多算一跳则 `X-Forwarded-For` 可伪造。
- **请求 ID**：`reqId` **永远由我们生成**（UUID），回写 `X-Request-Id` 响应头。上游送来的 `X-Request-Id` 只作为 `upstreamRequestId` 并排记录，用于和合作方系统对账。以前是"上游值合法就直接当 reqId"，等于审计记录的主键由被审计方挑选：合作方可以让两个请求共用一个 id，也可以撞上别人的 id，而日志会站在他们那边。
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
