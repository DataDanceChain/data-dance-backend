# Production Update Guide - Multi-Task Awards Support

## 更新内容

本次更新支持一个 Award 包含多个 Tasks，特别是 Crawler 类型的 Award 可以包含多个子任务（对应多个 Crawler Tasks）。

---

## 更新步骤

### 1. 备份数据库

```bash
# 备份 PostgreSQL 数据库
pg_dump -h <host> -U <user> -d datadance > backup_$(date +%Y%m%d_%H%M%S).sql
```

### 2. 拉取最新代码

```bash
git pull origin <branch-name>
# 或
git pull github <branch-name>
```

### 3. 安装依赖（如有更新）

```bash
npm install
```

### 4. 运行数据库迁移

```bash
# 应用新的 migration（添加 taskId 字段到 CrawlerTask 表）
npx prisma migrate deploy
```

**Migration 内容：**
- 在 `CrawlerTask` 表中添加 `taskId` 字段（String?, 可选）
- 该字段用于关联 `TASK_TEMPLATES` 中的 `taskId`（如 `booking_past_trips`）

### 5. 更新 Awards 配置

```bash
# 运行脚本更新数据库中的 Awards 和 Tasks
node scripts/createAwards.js
```

**配置更新内容：**
- Airbnb: 从 1 个 task 增加到 2 个 tasks
- Booking: 从 1 个 task 增加到 3 个 tasks
- 所有 crawler tasks 添加 `crawlerTaskId` 字段

### 6. 重启服务

```bash
# 如果使用 PM2
pm2 restart data-dance-backend

# 如果使用 Docker
docker compose restart ddc-backend-api

# 如果使用 systemd
sudo systemctl restart data-dance-backend
```

### 7. 验证更新

```bash
# 检查 API 是否正常返回多个 tasks
curl -H "Authorization: Bearer <token>" \
  https://your-api-domain.com/api/awards

# 应该看到：
# - airbnb-data-collection: 2 个 tasks
# - booking-data-collection: 3 个 tasks
# - 每个 task 的 metadata 中包含 crawlerTaskId
```

---

## 回滚方案

如果更新后出现问题，可以回滚：

### 1. 回滚代码

```bash
git checkout <previous-commit>
npm install
```

### 2. 回滚数据库（如果需要）

```bash
# 恢复备份
psql -h <host> -U <user> -d datadance < backup_<timestamp>.sql
```

### 3. 重启服务

```bash
pm2 restart data-dance-backend
```

---

## 注意事项

1. **向后兼容性**：
   - 代码保持向后兼容，如果 `crawlerTaskId` 不存在，会回退到按 `source` 统计
   - 现有的 CrawlerTask 记录如果没有 `taskId`，仍然可以正常工作

2. **数据迁移**：
   - 现有的 CrawlerTask 记录不会自动填充 `taskId`
   - 新的 CrawlerTask 创建时会自动保存 `taskId`
   - 如果需要为现有记录填充 `taskId`，可以运行数据迁移脚本（可选）

3. **API 变更**：
   - `/api/awards` 返回格式保持不变
   - 每个 task 的 `metadata` 中新增 `crawlerTaskId` 字段
   - 前端需要适配显示多个 tasks

---

## 更新检查清单

- [ ] 数据库备份完成
- [ ] 代码已拉取最新版本
- [ ] 依赖已安装
- [ ] 数据库迁移已应用
- [ ] Awards 配置已更新（运行 `createAwards.js`）
- [ ] 服务已重启
- [ ] API 验证通过
- [ ] 前端已适配新格式

---

**最后更新**: 2025-01-06
