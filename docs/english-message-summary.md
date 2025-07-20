# English Message Summary - Amazon Data Upload API

## Updated Message Formats

### 1. Duplicate Data Detection Messages

**Before**: 可能包含中文或不规范的英文
**After**: 标准化英文消息模板

```json
{
  "reason": "duplicate_data",
  "reasonText": "This {source} order has already been uploaded"
}
```

```json
{
  "reason": "duplicate_data", 
  "reasonText": "Identical content already exists in your data"
}
```

**Note**: `{source}` is dynamically replaced with the actual data source (e.g., "amazon", "luma").

### 2. Similarity Detection Messages

**Before**: "标题高度相似100%" (Chinese with dynamic percentage)
**After**: Professional English templates with dynamic values

```json
{
  "reason": "title_price_match",
  "details": "Product title and price match detected (XX% similarity, price: $XX.XX)"
}
```

```json
{
  "reason": "title_similarity", 
  "details": "Product title is highly similar (XX% match)"
}
```

**Note**: The percentages (XX%) and prices ($XX.XX) are dynamically calculated based on actual similarity scores and product prices.

### 3. Validation Error Messages

**Before**: 可能混合中英文
**After**: Clear English format

```json
{
  "reason": "validation_error",
  "reasonText": "Data validation failed: Data source must be amazon or luma"
}
```

### 4. Rate Limiting Messages

**Upload Rate Limit**:
```json
{
  "status": "error",
  "message": "Upload rate limit exceeded. Please wait before uploading more data.",
  "retryAfter": 60
}
```

**General Rate Limit**:
```json
{
  "status": "error", 
  "message": "Too many requests, please try again later.",
  "retryAfter": 60
}
```

### 5. Complete API Response Examples

**Successful Upload**:
```json
{
  "status": "success",
  "data": {
    "uploadedCount": 5,
    "pointsEarned": 50,
    "duplicatesCount": 2,
    "duplicateDetails": [
      {
        "index": 2,
        "reason": "duplicate_data",
        "reasonText": "This amazon order has already been uploaded",
        "sourceId": "123-1234567-1234567"
      }
    ],
    "message": "Successfully uploaded 5 items, earned 50 points",
    "amazonLimits": {
      "remainingDaily": 995,
      "remainingMonthly": 9995
    }
  }
}
```

**All Duplicates**:
```json
{
  "status": "success",
  "data": {
    "uploadedCount": 0,
    "pointsEarned": 0, 
    "duplicatesCount": 5,
    "duplicateDetails": [
      {
        "index": 0,
        "reason": "duplicate_data",
        "reasonText": "This amazon order has already been uploaded",
        "sourceId": "123-1234567-1234567"
      }
    ],
    "message": "All data items are duplicates"
  }
}
```

**Rate Limit Exceeded**:
```json
{
  "status": "error",
  "message": "Upload rate limit exceeded. Please wait before uploading more data.",
  "retryAfter": 60
}
```

**Idempotency Key Issues**:
```json
{
  "status": "error",
  "message": "Idempotency key already used with different request parameters"
}
```

## Key Changes Made

1. **Removed all Chinese characters** from user-facing messages
2. **Standardized similarity reporting** to use clear percentages and professional language
3. **Improved duplicate detection messages** to be more specific about the type of duplicate
4. **Enhanced validation error messages** to be more descriptive
5. **Maintained consistent JSON structure** across all responses

## Files Modified

- `/src/services/crawlerService.js` - Main upload logic and duplicate detection
- `/src/middlewares/rateLimitMiddleware.js` - Rate limiting messages
- `/src/middlewares/idempotencyMiddleware.js` - Idempotency error messages
- `/src/constants/messages.js` - Message constants (already in English)

## Notes

- All error messages now use standard HTTP status codes
- Response format is consistent across all endpoints
- Messages are professional and user-friendly
- No Chinese characters remain in API responses
- Similarity percentages are rounded to whole numbers for clarity