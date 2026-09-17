# Data Pack 功能测试清单

## 🧪 测试前准备

- [ ] 数据库已运行
- [ ] 已执行数据库迁移：`npx prisma migrate deploy`
- [ ] 已生成 Prisma Client：`npx prisma generate`
- [ ] 准备测试 CSV 文件：`data-pack-1.csv`

---

## 📋 功能测试

### 1. CSV 导入脚本测试

#### 1.1 基本导入
```bash
node scripts/importDataPackAsDataNFT.js data-pack-1.csv
```

**预期结果：**
- [ ] 成功解析 CSV
- [ ] 识别邮箱字段
- [ ] 创建 DataNFT（dataSource='upload'）
- [ ] 添加 "Data Pack" 标签
- [ ] 状态为未发布

#### 1.2 带参数导入
```bash
node scripts/importDataPackAsDataNFT.js data-pack-1.csv \
  --name "Test Data Pack" \
  --price 99.99 \
  --description "Test description"
```

**预期结果：**
- [ ] DataNFT name = "Test Data Pack"
- [ ] DataNFT price = 99.99
- [ ] DataNFT description = "Test description"

#### 1.3 自动发布
```bash
node scripts/importDataPackAsDataNFT.js data-pack-1.csv \
  --name "Published Pack" \
  --price 199.99 \
  --publish
```

**预期结果：**
- [ ] DataNFT 创建成功
- [ ] isPublished = true
- [ ] 在市场中可见

---

### 2. DataNFT API 测试

#### 2.1 获取所有 DataNFT（市场）
```bash
curl http://localhost:3000/api/datanfts
```

**预期结果：**
- [ ] 返回所有已发布的 DataNFT
- [ ] 包含活动来源和上传来源的 DataNFT
- [ ] 每个 DataNFT 都有正确的 size 值
- [ ] 上传的 DataNFT 的 snapshots = []

#### 2.2 获取单个 DataNFT
```bash
curl http://localhost:3000/api/datanfts/{id}
```

**预期结果：**
- [ ] 返回 DataNFT 详情
- [ ] 包含 dataSource 字段
- [ ] 上传类型有 dataRecords 数据
- [ ] size 计算正确

#### 2.3 获取商家的 DataNFT
```bash
curl http://localhost:3000/api/merchant/datanfts?allMine=true \
  -H "Authorization: Bearer {token}"
```

**预期结果：**
- [ ] 返回当前商家的所有 DataNFT
- [ ] 包含未发布的 DataNFT

---

### 3. Size 计算测试

#### 3.1 活动数据 DataNFT
**测试步骤：**
1. 创建活动
2. 用户参与
3. 创建 Snapshot
4. 合并为 DataNFT
5. 查看 DataNFT

**预期结果：**
- [ ] size = 参与用户的唯一数量
- [ ] dataSource = 'activity'
- [ ] snapshots.length > 0

#### 3.2 上传数据 DataNFT
**测试步骤：**
1. 导入 CSV（39条记录）
2. 查看 DataNFT

**预期结果：**
- [ ] size = 39
- [ ] dataSource = 'upload'
- [ ] snapshots.length = 0
- [ ] dataRecords.recordCount = 39

---

### 4. 购买流程测试

#### 4.1 购买上传数据 DataNFT
```bash
POST http://localhost:3000/api/datanfts/{id}/purchase
Authorization: Bearer {buyer-token}
{
  "quantity": 1
}
```

**预期结果：**
- [ ] 购买成功
- [ ] 创建交易记录
- [ ] 商家收到款项
- [ ] 买家可以访问数据

#### 4.2 数据访问验证
```bash
GET http://localhost:3000/api/merchant/purchases
Authorization: Bearer {buyer-token}
```

**预期结果：**
- [ ] 返回购买的 DataNFT
- [ ] 包含 dataRecords 数据
- [ ] 可以访问所有记录

---

### 5. 边界情况测试

#### 5.1 无邮箱字段的 CSV
创建一个没有邮箱列的 CSV，导入

**预期结果：**
- [ ] 抛出错误："CSV must contain an email field"
- [ ] 不创建 DataNFT

#### 5.2 部分记录无邮箱
CSV 中某些行的邮箱为空

**预期结果：**
- [ ] 显示警告
- [ ] 跳过无邮箱的记录
- [ ] 成功创建 DataNFT
- [ ] recordCount = 有效记录数

#### 5.3 包含特殊字符的 CSV
CSV 中包含引号、逗号、换行符

**预期结果：**
- [ ] 正确解析
- [ ] 数据完整保存
- [ ] 特殊字符不被转义

#### 5.4 中文字段名
CSV 使用中文列名

**预期结果：**
- [ ] 正确识别邮箱字段
- [ ] 中文字段名保存正确
- [ ] 可以正常显示

---

### 6. 市场展示测试

#### 6.1 混合展示
市场中同时有活动数据和上传数据的 DataNFT

**预期结果：**
- [ ] 两种类型都正确显示
- [ ] size 值正确
- [ ] 价格显示正确
- [ ] 可以筛选和搜索

#### 6.2 来源标识
前端显示 DataNFT 时

**预期结果：**
- [ ] 活动数据：显示活动信息
- [ ] 上传数据：显示文件名和记录数
- [ ] 有清晰的视觉区分

---

### 7. 性能测试

#### 7.1 大文件导入
导入包含 1000+ 记录的 CSV

**预期结果：**
- [ ] 成功导入（<5秒）
- [ ] 数据完整
- [ ] 内存使用合理

#### 7.2 市场加载
市场中有 100+ DataNFT

**预期结果：**
- [ ] 分页正常工作
- [ ] 加载速度 <2秒
- [ ] size 计算不影响性能

---

### 8. 安全测试

#### 8.1 权限验证
尝试访问他人的 DataNFT 数据

**预期结果：**
- [ ] 未购买：无法访问数据
- [ ] 已购买：可以访问
- [ ] 商家：可以访问自己的

#### 8.2 SQL 注入防护
在 CSV 中包含 SQL 注入语句

**预期结果：**
- [ ] 数据安全存储（JSON）
- [ ] 不执行任何 SQL
- [ ] 查询时正确转义

---

### 9. 数据库验证

#### 9.1 DataNFT 表
```sql
SELECT * FROM "DataNFT" WHERE "dataSource" = 'upload';
```

**预期结果：**
- [ ] dataSource 字段存在
- [ ] dataRecords 字段为 JSON
- [ ] 现有数据 dataSource = 'activity'

#### 9.2 Snapshot 表
```sql
SELECT * FROM "Snapshot" WHERE "activityId" IS NULL;
```

**预期结果：**
- [ ] 返回空（activityId 必填）
- [ ] 所有 Snapshot 都有活动关联

---

### 10. 回归测试

#### 10.1 原有活动数据流程
1. 创建活动
2. 创建 Snapshot
3. 创建 DataNFT

**预期结果：**
- [ ] 流程不受影响
- [ ] 功能正常工作
- [ ] 数据正确

#### 10.2 原有 DataNFT 功能
- [ ] 发布/取消发布
- [ ] 更新价格
- [ ] 删除 DataNFT
- [ ] 购买流程
- [ ] 商家收益

---

## 📊 测试报告模板

### 测试信息
- **测试日期：** _______
- **测试人员：** _______
- **环境：** Development / Staging / Production

### 测试结果

| 测试项 | 状态 | 备注 |
|-------|------|------|
| 1. CSV 导入 | ⬜ Pass ⬜ Fail | |
| 2. API 功能 | ⬜ Pass ⬜ Fail | |
| 3. Size 计算 | ⬜ Pass ⬜ Fail | |
| 4. 购买流程 | ⬜ Pass ⬜ Fail | |
| 5. 边界情况 | ⬜ Pass ⬜ Fail | |
| 6. 市场展示 | ⬜ Pass ⬜ Fail | |
| 7. 性能测试 | ⬜ Pass ⬜ Fail | |
| 8. 安全测试 | ⬜ Pass ⬜ Fail | |
| 9. 数据库验证 | ⬜ Pass ⬜ Fail | |
| 10. 回归测试 | ⬜ Pass ⬜ Fail | |

### 发现的问题

1. **问题描述：** _______
   - 严重程度：🔴 Critical / 🟡 Major / 🟢 Minor
   - 重现步骤：_______
   - 预期 vs 实际：_______

### 总体评估

- **通过率：** ____ / 10
- **是否通过：** ⬜ Yes ⬜ No
- **建议：** _______

---

## ✅ 验收标准

功能可以上线的条件：

- [ ] 所有核心功能测试通过
- [ ] 无 Critical 级别的 bug
- [ ] 性能测试达标
- [ ] 安全测试通过
- [ ] 文档完整
- [ ] 代码审查通过
- [ ] 数据库迁移测试通过

---

## 🚀 上线后验证

- [ ] 生产环境数据库迁移成功
- [ ] 监控指标正常
- [ ] 无错误日志
- [ ] 用户反馈正常

---

祝测试顺利！🎉

