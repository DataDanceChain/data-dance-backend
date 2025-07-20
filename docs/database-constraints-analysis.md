# 数据库唯一约束分析

## 潜在影响分析

### 1. 性能影响

**影响**：
- 插入操作会稍微变慢（需要检查唯一性）
- 索引会占用额外的存储空间

**评估**：
- 对于每天 1000 条的限制，性能影响可忽略不计
- 索引大小估算：假设 100 万条记录，每个索引约 50-100MB

**优化建议**：
```sql
-- 定期清理旧数据
DELETE FROM "CrawlerData" 
WHERE "createdAt" < NOW() - INTERVAL '6 months';

-- 分析索引使用情况
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename = 'CrawlerData';
```

### 2. 业务逻辑影响

**正面影响**：
- 彻底防止重复数据
- 数据一致性得到保证
- 减少积分超发风险

**潜在问题**：
1. **合法重复场景**：
   - 用户可能有合法的重复订单（如订阅商品）
   - 解决方案：在 contentHash 计算时加入时间戳或其他区分字段

2. **数据修正困难**：
   - 一旦插入错误数据，再次上传正确数据会被拒绝
   - 解决方案：提供数据删除/修正接口

3. **跨用户数据共享**：
   - 当前设计允许不同用户上传相同数据
   - 如需全局去重，可修改索引：
   ```sql
   CREATE UNIQUE INDEX "CrawlerData_sourceId_unique" 
   ON "CrawlerData"("sourceId") 
   WHERE "sourceId" IS NOT NULL;
   ```

### 3. 错误处理影响

**需要处理的新错误类型**：
```javascript
// 在 crawlerService.js 中添加错误处理
try {
  await tx.crawlerData.createMany({
    data: insertData,
    skipDuplicates: true
  });
} catch (error) {
  if (error.code === 'P2002') { // Prisma unique constraint violation
    // 分析具体是哪个字段违反约束
    if (error.meta?.target?.includes('sourceId')) {
      throw new Error('该订单已经上传过');
    } else if (error.meta?.target?.includes('contentHash')) {
      throw new Error('相同内容的数据已存在');
    }
  }
  throw error;
}
```

## 影响评估表

| 方面 | 影响程度 | 描述 | 缓解措施 |
|------|---------|------|----------|
| 写入性能 | 低 | 增加索引检查时间 | 使用批量插入 |
| 查询性能 | 正面 | 提升基于这些字段的查询速度 | - |
| 存储空间 | 低 | 每个索引约 50-100MB | 定期清理旧数据 |
| 数据完整性 | 高度正面 | 防止重复数据 | - |
| 灵活性 | 中等负面 | 某些场景可能需要重复数据 | 提供覆盖机制 |

## 建议

1. **逐步实施**：
   - 先在测试环境验证
   - 监控错误日志
   - 收集用户反馈

2. **提供管理接口**：
   ```javascript
   // 管理员接口：删除错误数据
   async function deleteUserCrawlerData(userId, dataId) {
     // 仅管理员可调用
   }
   
   // 用户接口：查看被拒绝的数据
   async function getRejectedUploads(userId) {
     // 返回因重复被拒绝的数据列表
   }
   ```

3. **监控指标**：
   - 唯一约束违反次数
   - 插入操作耗时
   - 索引使用频率