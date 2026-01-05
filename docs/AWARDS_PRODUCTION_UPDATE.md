# Awards Production Update Guide

## 概述

本指南说明如何在生产环境更新 awards 配置（包括新增的 Airbnb 和 Booking 数据采集任务）。

---

## 前提条件

1. ✅ **代码已更新**: 确保生产环境代码已拉取最新版本（包含 `awardService.js` 的 null 过滤修复和 `createAwards.js` 的 metadata 支持）
2. ✅ **配置文件已更新**: 确保 `config/awards.json` 包含最新的配置（Airbnb 和 Booking awards）
3. ✅ **数据库访问**: 确保可以连接到生产数据库
4. ✅ **环境变量**: 确保 `.env` 文件中的 `DATABASE_URL` 指向生产数据库

---

## 更新步骤

### Step 1: 备份数据库（推荐）

```bash
# 创建数据库备份
pg_dump -h <PRODUCTION_DB_HOST> -U <DB_USER> -d <DB_NAME> > backup_awards_$(date +%Y%m%d_%H%M%S).sql
```

---

### Step 2: 拉取最新代码

```bash
# 进入后端目录
cd /path/to/data-dance-backend

# 拉取最新代码
git fetch origin
git checkout wallet-pass  # 或你的生产分支
git pull origin wallet-pass
```

---

### Step 3: 安装依赖（如果需要）

```bash
npm install
```

---

### Step 4: 运行 Awards 创建脚本

**这是唯一需要运行的脚本：**

```bash
node scripts/createAwards.js
```

**脚本功能：**
- ✅ 创建/更新所有 awards（从 `config/awards.json`）
- ✅ 创建/更新所有 tasks
- ✅ 正确处理 `metadata` 字段
- ✅ 使用 `upsert`，安全（存在则更新，不存在则创建）

**预期输出：**
```
Award definitions seeded.
Task definitions seeded.
```

---

### Step 5: 验证更新

验证 awards 是否成功创建：

```bash
# 方法 1: 通过 API 验证（如果后端正在运行）
curl https://your-api-domain.com/api/awards

# 方法 2: 通过数据库查询
# 连接到数据库，查询：
# SELECT id, title, color, status FROM "Award" WHERE id IN ('amazon-data-collection', 'airbnb-data-collection', 'booking-data-collection', 'referral-rewards');
```

**预期结果：**
- 应该返回 4 个启用的 awards
- 不应该有 `null` 值
- 所有 awards 都包含完整的 `metadata`

---

### Step 6: 重启后端服务（可选）

**通常不需要重启**，因为：
- Awards 是从数据库读取的
- 代码修复（null 过滤）已经在运行中的服务中生效

**但如果需要确保所有更改生效，可以重启：**

```bash
# 如果使用 PM2
pm2 restart data-dance-backend

# 如果使用 Docker
docker compose restart ddc-backend-api

# 如果使用 systemd
sudo systemctl restart data-dance-backend
```

---

## 完整命令示例

```bash
# 1. 进入项目目录
cd /path/to/data-dance-backend

# 2. 拉取最新代码
git pull origin wallet-pass

# 3. 安装依赖（如果需要）
npm install

# 4. 运行 awards 创建脚本
node scripts/createAwards.js

# 5. 验证（可选）
curl https://your-api-domain.com/api/awards | jq '.data.awards | length'
# 应该返回 4

# 6. 重启服务（可选）
pm2 restart data-dance-backend
```

---

## 注意事项

### ⚠️ 重要提示

1. **数据库连接**: 确保 `.env` 文件中的 `DATABASE_URL` 指向**生产数据库**，而不是开发数据库
2. **代码版本**: 确保代码已包含以下修复：
   - `awardService.js` 的 null 过滤逻辑
   - `createAwards.js` 的 metadata 字段支持
3. **配置文件**: 确保 `config/awards.json` 包含最新的配置
4. **幂等性**: 脚本使用 `upsert`，可以安全地多次运行

### ✅ 安全特性

- **Upsert 操作**: 如果 award 已存在，会更新；如果不存在，会创建
- **不会删除数据**: 脚本只创建/更新，不会删除现有的 awards
- **事务安全**: Prisma 的 upsert 操作是事务安全的

---

## 故障排查

### 问题 1: 数据库连接失败

**错误信息:**
```
Can't reach database server at `localhost`:`5432`
```

**解决方案:**
1. 检查 `.env` 文件中的 `DATABASE_URL`
2. 确认数据库服务正在运行
3. 检查网络连接和防火墙设置

### 问题 2: 脚本运行成功但 API 仍返回 null

**可能原因:**
- 代码未更新（缺少 null 过滤逻辑）
- 需要重启后端服务

**解决方案:**
1. 确认代码已更新到最新版本
2. 重启后端服务

### 问题 3: 某些 awards 未创建

**可能原因:**
- `config/awards.json` 中缺少配置
- 数据库权限问题

**解决方案:**
1. 检查 `config/awards.json` 是否包含所有 awards
2. 检查数据库用户权限
3. 查看脚本输出的错误信息

---

## 验证清单

更新完成后，请验证：

- [ ] 脚本运行成功（无错误）
- [ ] `/api/awards` 返回 4 个 awards（无 null）
- [ ] 所有 awards 包含完整的 `metadata`
- [ ] `/api/users/awards` 正常工作
- [ ] 前端可以正常显示所有 awards

---

## 总结

**对于这次更新（Airbnb 和 Booking awards），只需要：**

```bash
node scripts/createAwards.js
```

**就这么简单！** 🎉

脚本会自动：
- ✅ 创建缺失的 awards
- ✅ 更新已存在的 awards
- ✅ 创建/更新所有相关的 tasks
- ✅ 处理 metadata 字段

**无需重启服务**（除非代码有更新）。
