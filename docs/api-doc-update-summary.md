# API文档更新总结

## 更新日期：2025-07-19

### 主要更新内容：

#### 1. 爬虫数据上传API (`POST /api/crawler/upload`)

**响应消息英文化**：
- ✅ 成功消息：`"message": "Successfully uploaded X items, earned Y points"`
- ✅ 错误消息：`"message": "No valid data items found"`
- ✅ 限制错误：`"message": "Daily submission limit reached (1,000 items), please try again tomorrow"`

**响应格式增强**：
```json
{
  "status": "success",
  "data": {
    "uploadedCount": 5,
    "pointsEarned": 50,
    "duplicatesCount": 0,
    "message": "Successfully uploaded 5 items, earned 50 points",
    "amazonLimits": {
      "remainingDaily": 995,
      "remainingMonthly": 9995
    },
    "qualityReports": [],
    "duplicateDetails": []
  }
}
```

**积分规则修正**：
- 从"每10条有效数据获得100积分"修正为"每条有效数据获得10积分"
- 添加了上级佣金分配说明（10%/5%/2%）

#### 2. Amazon数据状态API (`GET /api/data-collection/amazon/status`)

**字段更新**：
- `pointsPer10Items: 100` → `pointsPerItem: 10`
- `rewardRule` 更新为准确描述

#### 3. Referral推荐系统API

**响应格式调整**：
- 移除了 `yourReward` 字段（已被动态佣金系统取代）
- 添加了 `ownReferralCode` 字段到overview响应中

**添加重要说明**：
1. 50积分直接推荐奖励（立即发放）
2. 上级佣金系统说明（10%/5%/2%）
3. 说明了yourReward字段已移除，使用动态分润系统

#### 4. 错误响应格式标准化

所有错误响应现在都包含详细的错误信息：
```json
{
  "status": "error" 或 "fail",
  "code": "ERROR_CODE",
  "message": "Detailed error message in English",
  "details": ["Additional information if applicable"]
}
```

### 验证要点：

1. ✅ 所有API响应消息都是英文
2. ✅ 爬虫上传路径是 `/api/crawler/upload`（不是 `/api/upload`）
3. ✅ 积分计算规则：每条有效数据10积分
4. ✅ 上级佣金系统适用于所有积分事件
5. ✅ 推荐奖励立即发放50积分

### 业务规则确认：

**Amazon数据收集**：
- 每日限制：1,000条
- 每月限制：10,000条
- 必需字段：`orderid`（格式：113-1234567-7890123）
- 积分规则：10积分/条

**推荐系统**：
- 直接推荐：50积分（立即发放）
- 限制：每个用户只能被推荐一次
- 不能自我推荐

**上级佣金**：
- 一级：10%
- 二级：5%
- 三级：2%
- 适用于所有积分产生事件

所有更新已完成，API文档现在与实际实现完全一致。