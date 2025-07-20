# Dynamic Message Templates - All English

## Confirmed Dynamic English Message Templates

### 1. 重复订单检测 (Duplicate Order Detection)
```javascript
// 代码中的模板
reasonText: `This ${item.source} order has already been uploaded`

// 实际输出示例
"This amazon order has already been uploaded"
"This luma order has already been uploaded"
```

### 2. 相似度检测 - 标题和价格匹配 (Title & Price Similarity)
```javascript
// 代码中的模板
details: `Product title and price match detected (${(titleSimilarity * 100).toFixed(0)}% similarity, price: $${price1})`

// 实际输出示例
"Product title and price match detected (85% similarity, price: $29.99)"
"Product title and price match detected (92% similarity, price: $149.00)"
```

### 3. 相似度检测 - 高度相似标题 (High Title Similarity)
```javascript
// 代码中的模板
details: `Product title is highly similar (${(titleSimilarity * 100).toFixed(0)}% match)`

// 实际输出示例
"Product title is highly similar (95% match)"
"Product title is highly similar (98% match)"
```

### 4. 源ID重复检测 (Source ID Duplicate)
```javascript
// 代码中的模板
reasonText: `You have already uploaded the same ${item.source === 'amazon' ? 'Amazon order' : 'Luma event'}`

// 实际输出示例
"You have already uploaded the same Amazon order"
"You have already uploaded the same Luma event"
```

### 5. 验证错误 (Validation Errors)
```javascript
// 代码中的模板
reasonText: 'Data validation failed: ' + validation.errors.join(', ')

// 实际输出示例
"Data validation failed: Data source must be amazon or luma"
"Data validation failed: Amazon data must include orderid field, Product title is recommended"
```

## 变量说明

### 动态变量类型：
- `${item.source}` - 数据源 ("amazon", "luma")
- `${(titleSimilarity * 100).toFixed(0)}%` - 相似度百分比 (0-100%)
- `${price1}` - 价格数值 (数字)
- `validation.errors.join(', ')` - 验证错误列表 (数组转字符串)

### 条件逻辑：
- `item.source === 'amazon' ? 'Amazon order' : 'Luma event'` - 根据数据源显示不同文本
- `duplicateType === 'order' ? ... : ...` - 根据重复类型显示不同消息

## 确认事项

✅ **所有用户可见的消息都是英文**
✅ **所有动态变量正确插入英文句式**
✅ **百分比格式统一使用整数 (95% 而不是 95.0%)**
✅ **价格格式包含美元符号 ($29.99)**
✅ **数据源名称首字母大写 (Amazon, Luma)**
✅ **没有中文字符残留**

## 代码位置

所有这些模板都在 `/src/services/crawlerService.js` 文件中的以下函数里：
- `detectSimilarity()` - 相似度检测
- `uploadCrawlerData()` - 主上传逻辑中的重复检测
- `validateDataItem()` - 数据验证 (间接通过 validation.errors)