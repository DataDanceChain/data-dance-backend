# 分润系统测试指南

本文档介绍如何运行分润系统的各种测试，确保系统的正确性和稳定性。

## 📋 测试概览

### 测试文件结构
```
scripts/
├── test-distribution-quick.js           # 快速验证测试
├── test-distribution-suite.js           # 主测试运行器
├── test-distribution-service.js         # 分润服务单元测试
├── test-task-distribution-integration.js # 任务分润集成测试
├── test-distribution-edge-cases.js      # 边界条件测试
├── test-distribution-performance.js     # 性能压力测试
├── test-distribution-data-consistency.js # 数据一致性测试
└── README-distribution-tests.md          # 本文档
```

### 测试类型说明

| 测试类型 | 文件 | 必要性 | 描述 |
|---------|------|--------|------|
| 快速验证 | `test-distribution-quick.js` | 🔥 高 | 5分钟内验证核心功能 |
| 单元测试 | `test-distribution-service.js` | ✅ 必要 | 测试分润服务核心逻辑 |
| 集成测试 | `test-task-distribution-integration.js` | ✅ 必要 | 测试真实任务完成流程 |
| 边界测试 | `test-distribution-edge-cases.js` | ✅ 必要 | 测试异常和边界情况 |
| 一致性测试 | `test-distribution-data-consistency.js` | ✅ 必要 | 验证数据完整性 |
| 性能测试 | `test-distribution-performance.js` | 📊 可选 | 测试高并发性能 |

## 🚀 快速开始

### 1. 环境准备

确保以下服务正在运行：

```bash
# 数据库 (必需)
docker-compose up -d postgres

# API服务器 (集成测试需要)
npm run dev
```

### 2. 快速验证

运行最基本的功能验证：

```bash
node scripts/test-distribution-quick.js
```

这个测试会在5分钟内完成，验证分润系统的核心功能是否正常。

### 3. 完整测试

运行所有必要测试：

```bash
node scripts/test-distribution-suite.js
```

## 📖 详细使用指南

### 主测试运行器 (`test-distribution-suite.js`)

这是推荐的测试方式，提供了灵活的测试选项：

#### 基本使用

```bash
# 运行所有必要测试
node scripts/test-distribution-suite.js

# 运行所有测试（包含性能测试）
node scripts/test-distribution-suite.js --include-optional

# 遇到失败立即停止
node scripts/test-distribution-suite.js --stop-on-failure
```

#### 选择性测试

```bash
# 只运行单元测试
node scripts/test-distribution-suite.js --suites unit

# 运行单元测试和集成测试
node scripts/test-distribution-suite.js --suites unit,integration

# 只运行性能测试
node scripts/test-distribution-suite.js --suites performance
```

#### 参数说明

| 参数 | 短参数 | 描述 |
|------|--------|------|
| `--help` | `-h` | 显示帮助信息 |
| `--include-optional` | `-o` | 包含可选测试（如性能测试） |
| `--stop-on-failure` | `-s` | 遇到必要测试失败时停止 |
| `--suites <list>` | | 只运行指定的测试套件（逗号分隔） |

### 单独运行测试

如果需要单独运行某个测试模块：

```bash
# 单元测试
node scripts/test-distribution-service.js

# 集成测试（需要API服务器运行）
node scripts/test-task-distribution-integration.js

# 边界条件测试
node scripts/test-distribution-edge-cases.js

# 数据一致性测试
node scripts/test-distribution-data-consistency.js

# 性能测试
node scripts/test-distribution-performance.js
```

## 🔍 测试内容详解

### 1. 快速验证测试 (`test-distribution-quick.js`)

**目的**: 快速验证系统基本功能  
**时间**: ~2分钟  
**验证项目**:
- 分润配置正确性
- 基础分润计算 (10%, 5%, 2%)
- 积分更新正确性
- 数据库记录完整性

### 2. 单元测试 (`test-distribution-service.js`)

**目的**: 测试分润服务的核心逻辑  
**时间**: ~5分钟  
**测试场景**:
- 配置验证
- 三级分润计算
- 小数精度处理
- 分润链中断处理
- 无上级用户处理
- 数据库记录验证

### 3. 集成测试 (`test-task-distribution-integration.js`)

**目的**: 测试真实任务完成流程  
**时间**: ~10分钟  
**前置要求**: API服务器运行 (localhost:10000)  
**测试流程**:
- 通过API创建用户邀请链
- 模拟真实任务完成
- 验证积分API响应
- 检查分润数据一致性

### 4. 边界条件测试 (`test-distribution-edge-cases.js`)

**目的**: 测试异常和边界情况  
**时间**: ~8分钟  
**测试场景**:
- 零积分任务分润
- 极小积分处理
- 大数值积分处理
- 长邀请链处理
- 事务回滚测试
- 并发操作测试
- 精度边界测试

### 5. 数据一致性测试 (`test-distribution-data-consistency.js`)

**目的**: 验证数据完整性和一致性  
**时间**: ~12分钟  
**验证项目**:
- 分润数学计算准确性
- 积分记录完整性
- 分润链正确性
- 时序一致性
- 积分守恒定律

### 6. 性能测试 (`test-distribution-performance.js`)

**目的**: 测试高并发和大量数据场景  
**时间**: ~20分钟  
**测试规模**:
- 小规模: 50用户, 10并发, 100次操作
- 中规模: 200用户, 20并发, 500次操作
- 大规模: 1000用户, 50并发, 1000次操作

## 🎯 推荐的测试流程

### 开发阶段

1. **代码修改后**: 运行快速验证
   ```bash
   node scripts/test-distribution-quick.js
   ```

2. **提交前**: 运行必要测试
   ```bash
   node scripts/test-distribution-suite.js
   ```

### 部署前验证

1. **完整测试**: 包含性能测试
   ```bash
   node scripts/test-distribution-suite.js --include-optional
   ```

2. **生产环境**: 只运行数据安全测试
   ```bash
   node scripts/test-distribution-suite.js --suites unit,edge,consistency
   ```

## 📊 测试结果解读

### 成功标志

```
🎉 所有必要测试通过！分润系统可以安全部署。
```

### 失败处理

如果测试失败，会显示详细的错误信息：

```
❌ 数据一致性测试失败
错误: Level 1 分润计算: expected 10, got 9.99 (tolerance: 0.001)
```

根据错误信息检查：
1. 配置文件 (`config/business-rules.json`)
2. 分润服务实现 (`src/services/distributionService.js`)
3. 数据库状态

## 🛠️ 故障排除

### 常见问题

1. **数据库连接失败**
   ```
   确保PostgreSQL在localhost:15432运行
   检查DATABASE_URL环境变量
   ```

2. **API连接失败** (集成测试)
   ```
   确保API服务器在localhost:10000运行
   检查API服务状态: npm run dev
   ```

3. **测试数据残留**
   ```
   测试会自动清理数据，如有问题可手动清理：
   DELETE FROM referral WHERE code LIKE 'TEST-%';
   DELETE FROM point WHERE source = 'upline_reward';
   DELETE FROM "user" WHERE email LIKE '%test%';
   ```

### 性能问题

如果性能测试运行缓慢：

1. 检查数据库性能
2. 减少测试规模
3. 使用SSD存储
4. 增加数据库连接池

## 📝 自定义测试

### 添加新测试

1. 创建新的测试文件
2. 在 `test-distribution-suite.js` 中注册
3. 遵循现有的测试模式

### 修改测试参数

编辑对应测试文件中的配置常量：

```javascript
// test-distribution-performance.js
const PERFORMANCE_CONFIG = {
  SMALL_SCALE: {
    users: 50,      // 修改用户数量
    concurrent: 10, // 修改并发数
    iterations: 100 // 修改迭代次数
  }
};
```

## 🔒 安全考虑

- 所有测试使用独立的测试数据
- 测试完成后自动清理数据
- 不会影响生产数据
- 使用事务确保数据一致性

## 📞 支持

如果遇到测试相关问题：

1. 检查本文档的故障排除部分
2. 查看测试日志中的详细错误信息
3. 验证环境配置是否正确
4. 联系开发团队获取支持

---

*本测试套件确保分润系统的可靠性和正确性，建议在每次重要更改后运行完整测试。*