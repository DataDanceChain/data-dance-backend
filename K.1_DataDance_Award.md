---
Create Time: 2025-04-20T13:59:00
Creator:
  - K
Path_0420-0428: |-
  反向学习项目开发:
  - [x] 可视化数据库
  - [x] 创建本地数据库
  - [x] 前后端对接
  - [x] 用户信息替换成服务层函数
  - [x] 用服务层函数替换1 2使用到的假数据，活动信息暂时用mock
  - [x] 查找链上信息功能（4 5 6）的服务层函数，替换到ui中，活动信息暂时用mock
Path_0429-0430: |-
  - [x] 后端：设计环境变量，启动db+api的Dokcer，启动prismastuido，schema.prisma定义数据结构，script/create***.js设计标准数据，数据迁移，controller+service设计API功能，route+app定义api路径，以上写成说明书写在api-doc.md中
Path_0501: |-
  - [x] 开发文档和思路整理：需求和背景 - 环境（docker, git) - 数据库 - 后端 - 后端服务层 - apidoc - 前端服务层 - 前端组件  - 自动化测试
Path_0502-0511: |-
  - [x] 后端: 实现任务 `requirementCount` 和 `doneCount` 字段及相关逻辑.
  - [x] 后端: Referral系统增强 (增加 `networkActivity`, `theirPoints`, `yourReward` 字段, 修正计算).
  - [x] 后端: `UserAward` 状态在所有子任务完成后自动更新.
  - [x] 后端: 构建活动信息结构及API，替换mock数据.
  - [x] 前端: 对接任务进度显示新逻辑 (`doneCount/requirementCount`).
  - [x] 前端: 对接Referral数据显示新字段.
  - [x] 前端: 优化Claim操作后的UI反馈和状态刷新 (包括Toast提示, Modal关闭).
  - [x] 前端: 优化数据请求策略 (静态/动态分离, 按需加载任务详情, 解决无限刷新).
  - [x] 前端: Referral页面还原 "Rewards Structure" 静态说明.
  - [x] 前端: 修复Claim后按钮状态未及时更新问题.
  - [x] 前端: 进度条和Claim按钮样式根据状态调整.
Path_0512_onwards: |-
  - [ ] DDC功能集成: 由于本任务需要在传统数据库中写入积分和任务状态，建议在后端统一进行链上余额校验（调用RPC获取DDC余额、写入UserTask.doneCount并更新progress/status），前端仅展示结果；若未来业务为纯链上功能（无需持久化），则可直接在前端通过 `web3Service.getBalance` 完成校验。
  - [ ] X (Twitter)功能集成: 调研X (Twitter) API可行性，设计后端验证，实现社交任务进度更新，考虑OAuth.
  - [ ] 前端性能与状态管理: 审查API调用，考虑引入Zustand/Redux，优化/拆分 `UserAwards.tsx`.
  - [ ] 错误处理与日志: 解决现有控制台错误 (如MutationObserver)，完善错误边界和日志.
  - [ ] 后端健壮性: 完善用户注册邀请流程，增加数据一致性校验与测试.
  - [ ] 全面测试: 为DDC、X (Twitter)等新功能编写单元/集成测试，执行E2E测试.
  - [ ] DevOps: 规范 `.gitignore` (如 `docker-compose.override.yml`, `.env`)，优化Docker配置.
  - [ ] 后端: 实现DDC持有量校验功能，并集成到任务和奖励系统中。
    - [x] 安装 `ethers.js` 库。
    - [x] 配置RPC Provider连接到DDC网络。
    - [x] 在 `Task` 定义中，使用 `requirementCount` 表示DDC持有任务所需的目标数量。
    - [x] 实现 `taskService.checkDDCBalance(userId, taskId)` 函数：
      - 获取用户钱包地址。
      - 通过RPC查询DDC余额。
      - 将余额更新到 `UserTask` 的 `doneCount` 字段。
    - [x] 在 `awardService.getUserAwards` 中调用 `checkDDCBalance`，确保返回给前端的数据包含最新的DDC持有状态。
    - [ ] 考虑DDC余额检查的触发机制（例如，每次调用 `/api/users/awards` 时实时检查，或通过定时任务更新）
Path_0514_onwards: |-
  - [x] 现在根据task和usertask中的status计算finaltask的逻辑是什么？为什么我在用一个通过web3auth的x渠道登陆的新用户的所有task都是locked？
  - [x] award卡片上的一个显示逻辑需要改，如果finalstatus时comingsoon，那么卡片上的reward信息（原来是要把所有其下task的奖励points都加起来的或者显示无限的）就只显示‘-’表示无，
  - [ ] 在socialengament其下的task中，后端返回数据中会提供metadata（例如 {"type":"X_RETWEET","targetPostId":"1902066485000122785"} ），前端需要根据targetPostId显示post内容，然后这个task的按钮直接显示claim状态，点击会返回 claimed或者错误返回，这里需要做一个弹窗。请参考apple ios的风格渲染显示post卡片以及claim按钮
  - [ ] 几个task的领取badge功能
  - [ ] 错误情况穷举Debug

---

## 1 需求与背景
### 目的
实现「奖励系统（Awards Hub [DataDance Award Hub本地npm](http://localhost:8100/user/awards)）」，鼓励用户通过完成任务获取积分奖励，提升平台用户参与度：
- 社交参与（Social Engagement）
- 资料完善（Profile Awards）
- 早鸟注册（Early Registration）
- 邀请好友（Referral Rewards）：邀请机制支持最高 4 级返佣（用户自身为第0级，可从其下1-3级用户处获得收益，对应任务为referral-1到referral-4），自动计算多级收益。新增网络活跃度总览。
- NFT 收集（Assets Collection）
- 徽章收集（Badge Collection）
- DDC 持有（DDC Holdings）
### 设计理念和系统架构
- **后端**：
    - **技术栈**: Node.js + Express + PostgreSQL + VM (用于 DDC 代币、NFT 等集成)
    - **数据库 ORM**: Prisma
    - **部署**: Docker / Docker Compose
- **前端**：
    - **技术栈**: React + Ionic
    - **移动端打包**: Capacitor
- **API 风格**: RESTful，提供扁平化 JSON 数据供前端消费。
- **前后端职责**：后端负责数据计算和状态判断，提供扁平化 JSON 数据；前端仅负责视图渲染，不处理复杂业务逻辑。
- **数据驱动**：奖励规则存储在平台定义表（如 `Award`, `Task`），用户进度和状态存储在用户关联表（如 `UserAward`, `UserTask`）。Task表增加 `requirementCount` 以支持更灵活的进度计算。UserTask表增加 `claimed` 缓存字段优化查询。
- **自动化与可扩展性**：利用种子脚本初始化数据，设计上支持未来轻松扩展新的奖励类别和任务类型。

### 开发流程

1. [x] **数据库设计**：定义奖励和任务的数据模型，区分平台规则和用户状态。增加 `Task.requirementCount` 和 `UserTask.claimed` 字段。
2. [x] **后端实现**：开发服务层逻辑（状态计算、进度更新、返佣计算、`networkActivity`等新字段计算）和 API 接口。数据结构设计完成，API 定义完成，服务逻辑已实现并根据新需求调整。
3. [x] **前端对接**：替换 Mock 数据，调用后端 API 渲染 UI，实现各奖励模块，包括新字段的显示和进度条逻辑更新。Claim后即时刷新。
4. [ ] **测试与优化**：通过单元测试和端到端测试验证功能，优化性能和用户体验。重点关注DDC和X (Twitter)集成。

### 参考链接
Git
	[DataDance Git 仓库 后端](https://git.magipop.xyz/melito/data-dance-backend)
	[DataDance Git 仓库 前端](https://git.magipop.xyz/melito/data-dance-frontend)

正式环境
	[DataDance Activities](https://business.datadance.ai/activities)
	[DataDance IP Market](https://business.datadance.ai/ip-market)

---

## 2 后端数据库（基于 `schema.prisma`）
### **2.1 环境配置与启动**

| 组件               | 作用                  | 关键配置与命令                                               |
| ---------------- | ------------------- | ----------------------------------------------------- |
| Docker / Compose | 一键启动 DB + 后端 + 依赖服务 | `docker-compose.yml` (配置 volume 挂载以支持热更新)             |
| Git              | 版本管理 & CI/CD 触发     | `git checkout <branch>`, `git pull`                   |
| Node.js (18 LTS) | 运行 Express API 服务   | 环境变量文件 (`backend.env`) 存储端口、私钥等敏感信息                   |
| PostgreSQL (15)  | 关系型数据库              | `DATABASE_URL` 环境变量配置数据库连接；Prisma 管理数据库迁移             |
| Prisma           | ORM 与数据库迁移工具        | `schema.prisma` 定义模型；`npx prisma migrate deploy` 应用迁移 |

**后端服务启动流程**:

```bash
# 1. 切换到目标分支
git checkout <branch>

# 2. 拉取最新代码
git pull

# 3. 进入后端项目目录
cd data-dance-backend

# 4. 停止并移除旧容器 (如果存在)
docker compose down

# 5. 构建镜像并以后台模式启动服务 (-d)
docker compose up -d --build
```

### **2.2 数据库设计 (`schema.prisma`)**
- **核心模型**:
    - `Award`: 定义奖励类别（标题, 描述, 图标, 颜色, 状态 `LOCKED`/`LIVE`/`INVALID`/`COMING_SOON` 等）。
    - `Task`: 增加 `requirementCount: Int?` 字段，用于定义任务完成所需的具体数量（如：需要3个NFT，需要填写3项资料等）。`claimLimit` 为 `null` 代表可无限次完成，为 `1` 代表一次性任务。
    - `UserTask`: 增加 `claimed: Boolean @default(false)` 字段作为缓存，表示该用户此任务的所有可领取次数是否都已领取完毕。
    - `Referral`: 记录多级（最高4级，但主要计算3级下线收益）邀请关系（邀请人, 被邀请人, 邀请码），用于返佣计算。

### **2.3 种子数据脚本 (Seed Data)**

- **目的**: 初始化平台定义的奖励规则和任务，并生成测试用户数据。
- **平台定义脚本 (`scripts/createAwards.js`)**:
    - 负责创建 `Award` 和 `Task` 记录，定义七大奖励类别及其子任务。
    - 为需要的Task增加 `requirementCount` 条目。
    - 任务示例：`social-1` (DataDance Launch, claimLimit:1, 50积分), `profile-1` (Complete Profile, claimLimit:1, requirementCount:3, 100积分)。

### 2.4 数据库管理
```
# 开发新迁移

docker compose exec ddc-backend-api npx prisma migrate dev --name <migration_name>

# 应用已有迁移

docker compose exec ddc-backend-api npx prisma migrate deploy

# 迁移完成后重新生成prisma client
docker compose exec ddc-backend-api npx prisma generate

# 危险操作: 重置数据库（删除所有数据），重新应用所有迁移

docker compose exec ddc-backend-api npx prisma migrate reset --force

# 本地重置 (需配置好 DATABASE_URL)：

DATABASE_URL=postgresql://ddc:ddc@localhost:15432/ddc npx prisma migrate reset --force

# 连接Prisma Studio**
    - 连接到 Docker 中的数据库 (需要端口 15432 已映射到宿主机)：  

DATABASE_URL=postgresql://ddc:ddc@localhost:15432/ddc npx prisma studio
```

**初始化数据**
```
# 运行所有seed数据
    
docker compose exec ddc-backend-api npm run seed:all   
    
# 单独生成有邀请关系的测试用户
    
docker compose exec ddc-backend-api npm run seed:testusers

# 在本地运行单个脚本 (需配置好 DATABASE_URL 环境变量)：

node scripts/createAwards.js
```

> Tip：`createAwards.js` 负责 **平台定义**；`seedTestUserData.js` 负责 **测试环境数据**（多用户、邀请码、UserAward/UserTask）

---

## 3 后端服务层与结构
### **3.1 后端代码结构 (`src/`)**
```
src/
 ├─ controllers/       # 控制器层: 接收HTTP请求, 调用Service, 格式化响应, 异常处理
 |    ├─ awardController.js
 |    ├─ taskController.js
 |    └─ referralController.js
 ├─ services/          # 服务层: 封装核心业务逻辑 (状态计算, 进度更新, 返佣等)
 |    ├─ awardService.js  (负责UserAward汇总统计, 阶梯解锁逻辑 - 部分待完成)
 |    ├─ taskService.js   (读写UserTask, 判断完成/领取状态)
 |    └─ referralService.js (递归构建推荐树, 批量结算返佣)
 ├─ routes/            # 路由层: 定义API端点, 挂载中间件, 关联Controller
 |    ├─ awardRoutes.js   (TODO: 待拆分)
 |    ├─ taskRoutes.js
 |    └─ referralRoutes.js
 └─ utils/prisma.js    # Prisma Client 实例工具
db/                     # 数据库配置与数据文件 (如在本地运行)
scripts/                # 各种一次性脚本 (seed, migrate, debug)
prisma/
 ├─ schema.prisma      # 数据库模型定义
 └─ migrations/        # 数据库迁移历史
app.js                  # Express 应用入口: 注册路由, 全局中间件 (鉴权, 日志, 解析, 错误处理)
server.js               # HTTP 服务器启动入口
api-doc.md              # API 文档 (应与前端约定保持一致)
backend.env             # 环境变量配置文件
docker-compose.yml      # Docker Compose 配置
Dockerfile              # Docker 镜像构建文件
```

- **业务原则**: Service 层只关心数据库和纯粹的业务逻辑；Controller 层负责处理 HTTP 请求与响应的适配。

### **3.2 Service 层职责与典型流程**
- **TaskService**:
    - 处理 `UserTask` 的读写操作，根据输入（如 `delta`）自动判断任务是否完成，并更新状态。
    - 根据 `Task.requirementCount` 和用户实际完成数量（如 `doneCount`，由具体策略计算）计算任务进度 `progress`。
    - `claimTask` 逻辑：在用户领取任务后，检查对应 `Award` 下的所有 `Task` 是否均已 `claimed`，如果是，则更新 `UserAward` 的 `claimed` 为 `true` 和 `status` 为 `INVALID`。
    - 对于X_RETWEET类型的任务，会进行X (Twitter)转发/引用验证，并使用`XPostCache`缓存API响应。
- **ReferralService**:
    - 递归查询构建最多 4 层的推荐网络树（但前端主要展示和计算到L3的收益）。
    - 计算总收益 (`totalReferralPoints`)、可领取收益 (`unclaimReferralAwards`)、新增 `networkActivity`（网络总贡献点数）。
    - 为邀请树中的每个节点（L1-L3）计算 `theirPoints`（该节点下线为其贡献的点数）和 `yourReward`（你从该节点获得的分成）。
    - 执行批量结算（更新相关 `UserTask`）。

### 3.3 **典型任务进度更新流程**
1. 用户在前端完成某个动作（如完善资料）。
2. 前端调用 `POST /api/users/tasks/:taskId/progress` API。
3. `taskController.recordTaskProgress` 接收请求，调用 `taskService.recordTaskProgress`。
4. `taskService` 更新对应的 `UserTask` 记录（例如，通过 `upsert`），判断任务是否完成（基于 `doneCount` 和 `requirementCount` 或其他逻辑），并更新 `UserTask.status` (e.g., 从 `LOCKED` 到 `LIVE`) 和 `UserTask.claimed` (如果所有可领取次数已完成)。
5. _(如果适用阶梯奖励)_ 如果任务完成触发了某个 `Award` 的解锁条件，`taskService` 或相关逻辑会调用 `awardService` 来更新 `UserAward.status`。当一个Award下的所有Task的UserTask记录都为`claimed=true`时，对应的UserAward记录也会被标记为`claimed=true`和`status='INVALID'`。

## 4 API摘要与全链路映射
- 后端集中处理所有状态计算。前端只需在特定用户操作（更新资料、收集NFT/徽章、完成社交任务等）后，重新调用 `GET /api/users/awards` 即可获取完整的最新状态。
- 七大奖励类型（Profile, Early Reg, Referral, NFT, Badge, DDC, Social）的触发条件判断已在后端 `awardService.getUserAwards` 或相关 Service 中实现。

| 功能             | 方法 & 路径                                                           | Controller 方法                              | Service 方法(主要)                                           | 说明                                                                                                                |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 获取平台奖励定义列表     | `GET /api/awards`                                                 | `awardController.getAwards`                | `awardService.getAwardDefinitions` (直接查询 `prisma.award`) | 返回所有平台定义的 `Award` 规则 (id, title, description, icon, color, status, metadata)。                                     |
| 获取用户所有奖励与任务状态  | `GET /api/users/awards` (需认证)                                     | `awardController.getUserAwards`            | `awardService.getUserAwards(userId)`                     | **核心接口**：聚合用户所有 `Award` 和 `Task` 的最新状态。返回数据包括 `Award.finalStatus`, `Award.progress`, `Task.finalStatus`, `Task.progress`, `Task.requirementCount`, `Task.doneCount`。内部会触发7大场景的进度检查与更新，然后查询并组装所有 `LIVE` 状态的 `Award` 及其 `Task` 详情。               |
| 获取指定奖励的子任务列表   | `GET /api/awards/:awardId/tasks` (需认证)                            | `taskController.getTasksByAward`           | `taskService.getTasksByAward(userId, awardId)`           | 返回特定 `Award` 下所有 `Task` 的详细信息 (id, title, description, points, status, claimRecords, claimable, `requirementCount`, `doneCount`, `progress`, `finalStatus`)。            |
| 记录子任务进度        | `POST /api/users/tasks/:taskId/progress` (需认证, Body: `{ delta }`) | `taskController.recordTaskProgress`        | `taskService.recordTaskProgress(userId, taskId, delta)`  | 用于后端事件触发或持续型任务进度更新。将 `UserTask.status` 更新为 `LIVE` (如果之前是 `LOCKED`)。**注意**: Controller 返回体需确认是否符合新版协议（只返回 status）。 |
| 领取子任务奖励        | `POST /api/users/tasks/:taskId/claim` (需认证)                       | `taskController.claimTask`                 | `taskService.claimTask(userId, taskId)`                  | 校验任务状态 (`LIVE` 且 `claimable`)，记录领取时间戳到 `claimRecords`，发放积分（写 Point 流水），根据 `claimLimit` 更新 `status`。对于X_RETWEET类型的任务，会进行X (Twitter)转发/引用验证，并使用`XPostCache`缓存API响应。               |
| 查看邀请网络概览       | `GET /api/users/referrals` (需认证)                                  | `referralController.getReferralOverview`   | `referralService.getReferralOverview(userId)`            | 返回 1-4 级邀请网络树结构（L4仅基本信息）、网络总人数 (`levelCounts`)、总收益 (`totalReferralPoints`)、未领取奖励统计 (`unclaimReferralAwards`)、网络总活跃点数 (`networkActivity`)。每个L1-L3节点包含 `theirPoints` 和 `yourReward`。 |
| 一键领取所有邀请奖励     | `POST /api/users/referrals/claim` (需认证)                           | `referralController.claimReferralRewards`  | `referralService.claimReferralRewards(userId)`           | 批量领取所有可领取的邀请相关任务奖励（调用 `taskService.claimTask` 或直接更新 `UserTask` 并写 Point 流水）。                                      |
| (待实现) 触发注册邀请处理 | `POST /api/users/referrals/process` (需认证, Body: `{ inviterId }`)  | `referralController.processReferral` (待添加) | `referralService.processReferral(newUserId, inviterId)`  | **关键**: 用户注册时，如果带有邀请码，应调用此接口。创建 `Referral` 记录，并触发邀请人和上线的相关邀请任务 (`ref-1`, `ref-2` 等) 的进度更新 (`recordTaskProgress`)。 |

- **响应格式 (示例 `/api/users/awards` task 部分)**:
```json
// ... award data ...
"tasks": [
  {
    "id": "profile-1",
    "title": "Complete Profile",
    "description": "Fill in name, email, avatar",
    "points": 100,
    "claimLimit": 1,
    "requirementCount": 3, // 新增
    "doneCount": 2,        // 新增
    "prerequisiteTaskId": null,
    "claimRecords": [],
    "claimed": false,
    "progress": 0.67,      // (doneCount / requirementCount)
    "finalStatus": "IN_PROGRESS"
  }
  // ...更多任务
]
// ...
```
- **响应格式 (示例 `/api/users/referrals` 部分)**:
```json
{
  "status": "success",
  "data": {
    "referrals": [
      {
        "id": "user_level1_id",
        "email": "test_user_1@example.com",
        "nickname": "Test_user_1",
        "level": 1,
        "theirPoints": 150, // 新增: L1用户从其下线赚取的总点数
        "yourReward": 15,   // 新增: 你从L1用户这里获得的分成
        "referrals": [
          // ... L2 users with theirPoints, yourReward ...
          // L4 users will only have basic info (id, email, nickname, level)
        ]
      }
    ],
    "levelCounts": {"1":1,"2":3,"3":12,"4":44}, // L4까지 카운트
    "earnedByLevel": [50,15,36,44], // 4단계 수익 포함
    "totalReferralPoints": 145,
    "unclaimReferralAwards": 145,
    "networkActivity": 3095 // 新增: totalReferralPoints + (L2+L3+L4 count)*50
  }
}
```


## 5 前端服务层与结构
### **5.1 环境配置与启动**

- **技术栈**: React + Ionic
- **依赖安装**: `npm install`
- **开发模式启动**: `npm run dev`
    - **重要**: 确保开发服务器的 API 代理配置正确指向后端服务地址（例如，如果后端通过 Docker 运行在 `http://localhost:10000`，则代理目标应为 `http://localhost:10000/api`）。
- **移动端同步与构建**:
    1. 构建 Web 资源: `npm run build`
    2. 同步 Web 资源到原生平台: `npx cap sync`
    3. 在 Xcode 或 Android Studio 中打开原生项目: `npx cap open ios` 或 `npx cap open android`
### 5.2 **前端代码结构 (`src/`)**
```
src/
 ├─ pages/
 |    └─ UserAwards/
 |         ├─ UserAwards.tsx     # 奖励中心页面主组件
 |         └─ UserAwards.css     # 页面样式
 ├─ components/                # 可复用的UI组件
 ├─ services/                  # API服务层: 封装HTTP请求
 |    ├─ awards.ts            # 调用奖励和任务相关API
 |    ├─ referrals.ts         # 调用邀请相关API
 |    ├─ asset.ts             # 调用资产(NFT, DDC)相关API (可能需要)
 |    ├─ badge.ts             # 调用徽章相关API (可能需要)
 |    ├─ user.ts              # 调用用户资料相关API
 |    └─ web3.ts              # Web3相关操作 (如查询链上余额)
 ├─ hooks/                     # 自定义React Hooks
 ├─ contexts/                  # React Contexts (如认证状态)
 ├─ utils/                     # 工具函数
 └─ ... (其他标准React项目结构)
docs/
 └─ rewards-system.md        # (可能的前端侧奖励系统理解文档)
api-doc.md                    # (与后端共享或复制的API契约文档)
```

### **5.3 前端 Service 层 (`src/services/`)**
- **职责**: 只负责发起 HTTP 请求并对返回的数据进行基础解包（例如，从 `{ status: 'success', data: ... }` 中提取 `data`）。不包含任何业务逻辑或状态判断。
- **主要函数 (示例)**:
    - `awards.ts`:
        - `fetchDefinitions()`: 调用 `GET /api/awards` (获取平台定义的奖励规则)
        - `fetchUserAwards()`: 调用 `GET /api/users/awards` (获取用户所有奖励和任务的聚合状态)
        - `fetchAwardTasks(awardId)`: 调用 `GET /api/awards/:awardId/tasks` (按需获取特定奖励的子任务列表)
        - `claimTask(taskId)`: 调用 `POST /api/users/tasks/:taskId/claim`
    - `referrals.ts`:
        - `fetchReferrals()`: 调用 `GET /api/users/referrals` (获取邀请网络概览)
        - `claimReferrals()`: 调用 `POST /api/users/referrals/claim` (一键领取邀请奖励)
    - `user.ts`:
        - `fetchCurrentUser()`: 调用 `GET /users/me`
        - `fetchUserPoints()`: 调用 `GET /users/points`
        - `fetchUserInviteCode()`: 调用 `GET /users/invite-code`
    - `asset.ts`, `badge.ts`: (可能需要) 提供获取 NFT 数量、徽章列表、DDC 余额等的函数。
    - `web3.ts`: (可能需要) Web3相关操作。

### **5.4 社交互动模块前端展示逻辑**
- 数据来源：
  - `GET /api/awards`（公开接口，获取平台定义social-engagement的title、description、icon）
  - `GET /api/users/awards`（鉴权接口，获取当前用户social-engagement任务状态及claimRecords）
- 卡片渲染：
  - 列表页面中根据 `awardId==='social-engagement'` 渲染卡片，展示 `title`、`description`、固定文案“50 Points per Share”及LIVE/LOCKED状态
- 详情弹窗：
  - 点击卡片打开 Modal，遍历 `userAwards.tasks` 列表
  - 每个任务显示：
    - 标题（`task.title`）
    - 说明（`task.description`）
    - 状态徽章（根据 `task.finalStatus`/`task.claimable` 映射为Locked/In Progress/Completed）
    - 领取按钮：
      - `IN_PROGRESS` 且无 `claimRecords`：显示“Claim 50 Points”，可点击
      - 已领取 (`claimRecords.length>0`)：按钮置灰“50 Points Claimed”
      - 其他状态：按钮置灰“不符合条件`（Not Eligible）`
- 交互流程：
  1. 用户点击领取后，调用前端服务 `claimTask(taskId)` → `POST /api/users/tasks/:taskId/claim`
  2. 后端校验用户XID和转发记录（利用`XPostCache`），发放积分并更新数据库
  3. 前端收到成功响应后，重新调用 `GET /api/users/awards` ，刷新任务状态并弹Toast提示

## X (Twitter) 功能集成方案
### 目的与背景
- 为了实现社交分享任务的完整性，需要先收集并存储用户的X账号标识 (xid)、授权令牌等，以便后端能够校验转发记录

### 实现思路与步骤规划
#### 前端
1. 在用户使用 Web3Auth 或社交登录完成注册／登录后，获取 `userInfo.xid`／`twitterUserId`（由 `web3auth` 或授权回调返回）
2. 调用新增接口 `POST /api/users/me/social-account` （或 `PATCH /api/users/me`）
   - 请求体：`{ xid: string, accessToken?: string }`
3. 接口调用成功后，将最新用户信息（包括XID）保存在前端状态或 localStorage 中，供后续分享校验时使用

#### 后端
1. 数据库模型扩展：在 `User` 表/模型中新增字段 `xid String?` 和可选的 `xAccessToken String?`，并生成对应 Prisma 迁移
2. 路由与Controller：新增 `POST /api/users/me/social-account` 接口，Controller 从请求中提取 `xid` 和 `accessToken` 并调用 Service
3. Service 逻辑：`userService.linkSocialAccount(userId, xid, accessToken)`
   - 验证 xID 格式
   - 更新 `prisma.user.update`，写入对应字段
   - 返回更新后的用户信息
4. 在社交任务校验（`taskService.claimTask` 的 X_RETWEET 分支）中，直接使用存储在 `User.xid` 和 `xAccessToken` 去调用X API（通过`xClient`，其内部使用`XPostCache`），校验转发并决定是否发放奖励

### 接口文档更新
- `POST /api/users/me/social-account`
  - **目的**: 记录用户X账号信息
  - **请求体**: `{ xid: string, accessToken?: string }`
  - **响应**: `{ status: 'success', data: { user: { id, xid, ... } } }`

---

### 5.5 DDC持有量校验功能集成

为了实现根据用户持有的DDC（Data Dance Coin）数量来完成特定任务并获得奖励，我们集成了链上余额校验功能。

#### 5.5.1 后端实现

1.  **环境准备**:
    *   在后端项目中安装 `ethers.js` 库：`npm install ethers` 或 `yarn add ethers`。
    *   在配置文件或环境变量中设置DDC网络的RPC节点URL。
    *   初始化一个 `ethers.providers.JsonRpcProvider` 实例，用于连接到DDC网络。

2.  **任务定义 (`prisma/schema.prisma` & `scripts/createAwards.js`)**:
    *   对于DDC持有类型的任务（例如任务ID为 `ddc-holdings`），在其 `Task` 定义中，`requirementCount` 字段用于指定完成该任务所需要持有的最少DDC数量。例如，如果任务要求持有1000个DDC，则 `requirementCount` 设置为 `1000`。

3.  **链上余额查询与状态更新 (`src/services/taskService.js`)**:
    *   新增或修改 `taskService` 中的一个函数，例如 `async checkDDCBalance(userId, taskId)`。
    *   **获取用户钱包地址**: 从数据库中获取与 `userId` 关联的钱包地址。如果用户未绑定钱包，则此任务无法完成。
    *   **查询DDC余额**:
        *   使用 `ethers.js` 和配置好的RPC Provider。
        *   需要DDC Token的合约地址和ABI（至少包含 `balanceOf` 函数）。
        *   调用DDC合约的 `balanceOf(userWalletAddress)` 方法来获取用户的DDC余额。
    *   **更新任务进度**:
        *   将查询到的DDC余额（处理好小数位数）作为 `doneCount` 更新到该用户此任务的 `UserTask` 记录中。
        *   例如，如果用户持有500 DDC，则 `UserTask.doneCount` 更新为 `500`。

4.  **API集成 (`src/services/awardService.js` & `src/controllers/awardController.js`)**:
    *   在获取用户所有奖励及其任务状态的核心服务函数 `awardService.getUserAwards(userId)` 中（对应API `GET /api/users/awards`）：
        *   在组合最终的奖励和任务数据之前，遍历所有需要DDC校验的任务。
        *   对每个此类任务，调用 `taskService.checkDDCBalance(userId, taskId)` 来确保其 `doneCount` 是最新的。
        *   后续的 `progress` (`doneCount / requirementCount`) 和 `finalStatus` (LOCKED, IN_PROGRESS, COMPLETED) 的计算将基于这个最新的 `doneCount`。

5.  **触发机制**:
    *   **实时检查**: 当前主要考虑的方案是在每次调用 `GET /api/users/awards` 接口时，实时触发DDC余额的检查和 `UserTask.doneCount` 的更新。这确保了用户获取奖励状态时，DDC任务的进度总是最新的。
    *   **定时任务 (可选未来优化)**: 对于性能敏感或RPC调用频率需要控制的场景，可以考虑引入定时任务（例如，每小时或用户登录时）来批量更新用户的DDC持有任务状态。此时，`/api/users/awards` 将返回最近一次定时任务更新的状态。

#### 5.5.2 前端处理

*   前端无需进行任何特殊的链上交互来校验DDC余额。
*   当用户访问奖励页面或相关组件时，前端像往常一样调用 `GET /api/users/awards` 接口。
*   API返回的数据中，DDC持有任务的 `doneCount` 字段会包含用户当前（或最近校验的）DDC余额，`requirementCount` 包含任务要求的DDC数量。
*   前端可以直接使用这些字段以及计算好的 `progress` 和 `finalStatus` 来展示DDC任务的完成情况（例如，通过进度条显示 `doneCount / requirementCount`）。

#### 5.5.3 API变更总结 (`api-doc.md`)

*   `GET /api/users/awards`:
    *   其响应中，针对DDC持有类型的任务，`doneCount` 字段将反映用户钱包中DDC的实时（或最近校验的）余额。
    *   `requirementCount` 字段表示完成该任务所需的DDC数量。
    *   这些字段的说明已在 `api-doc.md` 中更新。


## 6 前端组件
### **组件实现 (`UserAwards.tsx` 关键点)**

- **数据获取**:
    - 组件加载时 (`useEffect`)：
        1.  首先调用服务层函数（如 `fetchStaticData`）并行获取用户基本信息、积分、邀请码以及平台定义的奖励规则 (`definitions`)。这些数据相对稳定，仅在初次加载时获取。
        2.  待 `definitions` 获取成功后，再调用服务层函数（如 `refreshAwards`）获取用户所有奖励 (`UserAward`) 的当前状态和推荐系统概览 (`referralOverview`)。这些数据会根据用户操作动态变化。
    - 按需加载：当用户点击某个奖励卡片打开模态框时，如果该奖励的详细任务列表 (`tasks`) 尚未加载，则此时再调用 `fetchAwardTasks(awardId)` 获取。
- **状态管理**: 使用 `useState` 存储从 API 获取的数据（如 `currentUser`, `pointsBalance`, `awardCategories`, `referralStats`, `selectedCategory` 等）。
- **UI 状态派生**: **关键原则** - 所有 UI 显示的状态（如“已锁定”、“进行中”、“可领取”、“已领取”、进度百分比）都应该根据从后端获取的数据 **在前端动态计算** 得出。
    - 例如，根据 `task.finalStatus` 和 `task.claimRecords` 来决定按钮的文本和状态。
    - 进度条根据 `task.progress` (后端计算的小数) 或 `task.doneCount` 和 `task.requirementCount` (前端显示为 `doneCount/requirementCount` 文本) 计算。Award卡片进度条根据 `award.progress`。
- **视觉映射**: 定义静态映射对象（如 `awardVisuals`），根据 `award.id` 查找对应的图标和颜色。
- **交互操作**:
    - 点击“领取”按钮时，调用对应的 Service 函数（如 `claimTask(taskId)` 或 `claimReferrals()`）。
    - 领取成功/失败后，**必须** 调用刷新函数（如 `refreshAwards()`）来获取最新的数据状态，更新组件 state 以刷新 UI，并显示Toast提示用户操作结果。模态框在成功领取后应关闭，避免 stale data 问题。
- **Referral 树渲染**:
    - 使用递归组件 (`renderReferralTree`) 渲染从 `referralOverview.referrals` 获取的嵌套数据结构。
    - 直接显示 `referralOverview.networkActivity`。
    - L1-L3 用户节点显示 `theirPoints` 和 `yourReward`。L4 用户仅显示基本信息。
    - 还原之前被删除的 “Rewards Structure” (Level 1: 10%, Level 2: 5%, Level 3: 2%) 的静态文本说明。

## 7.测试

### **测试用户与 Token**
- **测试用户**:
    - 主用户: `sloan_test@sloantest.com`
    - 其他: 所有以 `test_` 开头的用户 (e.g., `test_user1@example.com`)
- **通用密码**: `sloantest`
- **示例 Token** (可能会过期，需要重新登录获取):  
`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjllY2UyODA4LTc4NDY2Ny1hZWU0LTgxYjk5NmJjMmVlZiIsImlhdCI6MTc0NjQ0NTE2NiwiZXhwIjoxNzQ3MDQ5OTY2fQ.FN-ogLrBOEzqzBTNVyYxLWsYT_wXFtIzF1C2HVDFyBU`

### **API 手动测试 (curl)**

1. **登录获取 Token**:    
```bash
curl -X POST http://localhost:10000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sloan_test@sloantest.com","password":"sloantest"}'
```

```bash
curl -X POST 'http://localhost:10000/api/auth/web3auth-login' \
-H 'Content-Type: application/json' \
-d '{
  "walletAddress": "0xC2CBA29602fCe82c587Da368682629F3F83a7A7A"
}'
```

1. **设置环境变量 (可选, 方便后续命令)**:
```bash
export API_BASE="http://localhost:10000/api"
export TOKEN="<在此处粘贴获取到的Token>"
```

export API_BASE="http://localhost:10000/api"
export TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImE4NjJjYTVlLWIzM2QtNGYwMC04OWM4LTMwMjlmZmY3NmYyNSIsImlhdCI6MTc0NzI5ODU1NSwiZXhwIjoxNzQ3OTAzMzU1fQ.R4wILOULGHinkyqPIz3H9NXARiVVbhK-mOTxz4LgDF8"
    
2. **调用 API 示例**:
- 获取当前用户信息:
```bash
curl -H "Authorization: Bearer $TOKEN" "$API_BASE/users/me"
```
- 获取用户奖励状态:
```bash
curl -H "Authorization: Bearer $TOKEN" "$API_BASE/users/awards"
```
- 获取邀请网络信息:
```bash
curl -H "Authorization: Bearer $TOKEN" "$API_BASE/users/referrals"
```
        
- 领取任务奖励 (假设任务 ID 为 `profile-complete`):
```bash
	curl -X POST -H "Authorization: Bearer $TOKEN" "$API_BASE/users/tasks/profile-complete/claim"
```

获取某个任务的奖励信息
```bash
curl -H "Authorization: Bearer $TOKEN" \
    http://localhost:10000/api/users/referrals
```

## 8.回到正式环境
不应该git的文件

前端
	app.js
		登录页改回web3 Route exact path="/login" component={SignIn} 改成web3auth <Route exact path="/login" component={SignIn} />
		去掉 import UserawardsOrigin from './pages/user/UserAwardsOrigin';
		去掉origin页面
	
后端
	api里develop端口改为10000
	docker yaml不git

建议把这一行加到注册流程里（`authController.register` 在创建完 [prisma.user.create](vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) 后）：

await initializeUserAwards(user.id);

将前端的web3脚本搬到后端web3services中

## 9 过程记录摘要

### 1. 环境搭建与调试

- **后端启动**：尝试 Docker Compose（镜像无数据）和本地 Node + Docker 数据库组合，最终选择 Docker 本地 build 挂载 volume 实现热更新。
- **数据库**：初始化并生成测试数据，使用可视化工具（如 DBeaver, pgAdmin）确认运行状态。
- **接口对接**：确保前后端开发环境端口和API地址一致（如 `localhost:3000` vs `localhost:10000`）。
### 2. 功能实现过程

- **起点**：从个人资料奖励功能开始，替换用户信息和资料完整性检查的数据源。
- **问题发现**：Awards Hub 未接入后端，开始接口对接。
- **后端依赖**：实现 `claimAward` 时发现后端逻辑缺失，部分功能暂搁置。
- **Git问题**：主仓库推送权限不足，Fork 至个人仓库后推送新分支并发起 Merge 

| 日期   | 里程碑                           | 难点 & 解决方案                                                      |
|  ---- | ----------------------------- | -------------------------------------------------------------- |
| 4-20 | 初步规划奖励系统                      | 明确 7 类奖励与两级数据模型                                                |
| 4-28 | Prisma 模型 & Seed 完成           | 通过 `createAwards.js` 一键生成规则；`createTestReferrals.js` 生成 4 级邀请树 |
| 4-29 | 后端 Task / Referral Service 编写 | 使用 `upsert + progress` 自动完结任务；递归查询 referral 递增计数               |
| 4-30 | 前端接入真实 API                    | 把 Mock 全部替换为 Service 函数；处理 Token、错误映射                          |
| 5-01 | 完成 AwardService 与阶梯解锁         |                                                                |
| 5-02 | Referral & Task 增强              | 后端增加 `requirementCount`, `doneCount`, `networkActivity`, `theirPoints`, `yourReward`。修正分成算法。  |
| 5-06 | Award 状态联动                  | 后端实现 `UserAward` 在所有子任务 `claimed` 后自动更新其状态。                               |
| 5-08 | 前端对接新字段与进度显示             | 前端更新任务进度条为 `doneCount/requirementCount`，显示新Referral字段。                         |
| 5-10 | 前端 Claim 交互优化              | Claim后即时刷新数据，增加提示，修复按钮状态。还原Referral静态说明。进度条和按钮颜色根据状态调整。 |

---

## 10 总结

- 采用 **平台定义 + 用户进度** 双表范式，可在不迁移老数据的情况下快速扩充奖励。
- 前后端通过 **纯数据接口** 对接，UI 所有状态都由前端计算，可最大化重用组件。
- 邀请返佣通过 `Referral` 表 + 递归 Service 实现，无需复杂 SQL。
- Docker & Seed 脚本让新开发者可在几分钟内启动完整环境，有利于协作与 CI/CD。

## 11 关键概念

*  **服务层**：专注于通信，负责API交互并格式化数据，供其他组件使用，业务逻辑和用户交互由其他组件处理。
* **状态管理**：`locked` 状态用于资产类阶梯任务（如NFT/Badge/DDC），当前级未完成时后续级别锁定；进度0%不等于锁定。
* **React数据放置**：动态数据通常会随刷新等操作实时变化，放在主函数体内可以让 React 组件自动响应（user用户，在 `useState`），平台静态规则数据放组件外部，不会因用户操作而变化，节省内存和性能。（awardCategories）。
*  **Docker volumes挂载**: 通过 [docker-compose.yml](vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) 配置 volumes`volumes` 挂载实现代码热更新。适用于前端和后端开发（如 Node.js），但数据库（如 PostgreSQL）一般不需要挂载代码，只挂载数据目录用于持久化。
* MVC**架构理解**: Model-View-Controller是一种经典的软件分层架构思想，最初用于后端，但其理念可以延伸到整个全栈项目，强调将应用分为三大核心部分：
	- Model（模型）：负责与数据库直接交互，处理数据的增删改查、业务规则等。前端也有“Model”概念（如TypeScript类型、前端状态管理），但主要的数据Model在后端。比如在本项目中，数据库prisma/schema.prisma定义了数据结构，Prisma ORM负责数据结构和与数据库的交互。
	- View（视图）：前端React页面、组件就是View层，负责将数据渲染成用户可见的界面，与用户交互。
	- Controller（控制器）：负责接收用户输入、处理与数据库Model相关的业务逻辑，再将结果返回给View。后端的controllers目录下的各个控制器文件就是Controller层。
	一个典型全栈项目通常包含（前端 View, 后端 Controller+Model）：
	1. **前端**（View）：负责UI和用户交互。
	2. **后端**（Controller + Model）：负责业务逻辑、API、数据处理。
	3. **数据库**（Model）：持久化存储数据，主要在后端（数据库/ORM），前端有轻量的Model（类型、状态）
	4. **API**：前后端的连接桥梁（RESTful、GraphQL等）。
*   **AI 协作**: 
	* 明确需求而非功能
	* 多与 不同AI 沟通不同层级问题
	* 确保 AI 理解上下文（文件结构）