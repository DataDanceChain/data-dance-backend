# CSV 数据包上传 API 文档

## 📋 功能概述

后端新增了支持通过 CSV 文件上传创建独立数据包（Snapshot）的功能。数据包可以**不关联活动**，直接作为独立的数据资产存储在系统中，后续可以打包成 DataNFT 进行交易。

## 🎯 核心特性

- ✅ **无需关联活动**：数据包可以独立存在，`activityId` 为可选
- ✅ **灵活的 CSV 格式**：支持任意列结构，只需包含邮箱字段
- ✅ **自动数据验证**：自动识别邮箱字段，跳过无效记录
- ✅ **完整数据保留**：所有 CSV 字段都会被保存
- ✅ **自动标签**：自动添加 "Data Pack" 标签

## 📡 API 接口

### 上传 CSV 创建数据包

**接口地址：** `POST /api/snapshots/upload-csv`

**请求方式：** `multipart/form-data`

**认证要求：** 需要商家账号登录（Bearer Token）

**请求参数：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `file` | File | ✅ | CSV 文件（最大 20MB） |
| `name` | String | ✅ | 数据包名称 |
| `description` | String | ❌ | 数据包描述（可选） |
| `tags` | Array[String] | ❌ | 标签ID数组（可选） |

**请求示例：**

```javascript
// JavaScript (使用 FormData)
const formData = new FormData();
formData.append('file', csvFile); // csvFile 是 File 对象
formData.append('name', 'Order Data Pack 1');
formData.append('description', 'Customer orders from Q1 2025');
formData.append('tags', JSON.stringify(['tag-id-1', 'tag-id-2'])); // 可选

fetch('/api/snapshots/upload-csv', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
})
.then(response => response.json())
.then(data => console.log(data));
```

```bash
# cURL 示例
curl -X POST http://your-api-domain/api/snapshots/upload-csv \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@data-pack-1.csv" \
  -F "name=Order Data Pack 1" \
  -F "description=Customer orders from Q1 2025"
```

**成功响应（201 Created）：**

```json
{
  "id": "31459208-4553-436b-82b1-119692007192",
  "name": "Order Data Pack 1",
  "description": "Customer orders from Q1 2025",
  "merchantId": "db85cf2c-5b98-4815-a17a-d8233f2416e8",
  "activityId": null,
  "createdAt": "2025-11-10T16:14:45.103Z",
  "updatedAt": "2025-11-10T16:14:45.103Z",
  "claims": {
    "source": "/path/to/uploaded/file",
    "fileName": "data-pack-1.csv",
    "importDate": "2025-11-10T16:14:45.103Z",
    "recordCount": 39,
    "totalRecords": 39,
    "skippedRecords": 0,
    "headers": ["订单编号", "邮箱", "商品名称", "收件地址"],
    "emailField": "邮箱",
    "records": [
      {
        "recordId": 1,
        "email": "alice.williams@gmx.com",
        "订单编号": "105-7462910-4567890",
        "邮箱": "alice.williams@gmx.com",
        "商品名称": "Nike Running Shoes",
        "收件地址": "101 Elm St, Berlin, Germany"
      }
      // ... 更多记录
    ]
  },
  "merchant": {
    "id": "db85cf2c-5b98-4815-a17a-d8233f2416e8",
    "name": "DataDance Official",
    "email": "official@datadance.io"
  },
  "tags": [
    {
      "id": "tag-id-1",
      "name": "Data Pack"
    }
  ],
  "importSummary": {
    "totalRecords": 39,
    "validRecords": 39,
    "skippedRecords": 0,
    "emailField": "邮箱"
  }
}
```

**错误响应：**

```json
// 400 Bad Request - 缺少文件
{
  "error": "CSV file is required"
}

// 400 Bad Request - 缺少名称
{
  "error": "Name is required"
}

// 400 Bad Request - CSV格式错误
{
  "error": "CSV must contain an email field (邮箱/email/mail)"
}

// 400 Bad Request - 无有效记录
{
  "error": "No valid records with email found in CSV"
}

// 500 Internal Server Error
{
  "error": "Failed to create snapshot from CSV",
  "message": "详细错误信息"
}
```

## 📄 CSV 文件格式要求

### 必需字段

- **邮箱字段**：CSV 必须包含一个邮箱列，列名可以是：
  - `email` / `Email` / `EMAIL`
  - `邮箱`
  - `mail` / `Mail` / `MAIL`

### CSV 格式示例

```csv
订单编号,邮箱,商品名称,收件地址
105-7462910-4567890,alice.williams@gmx.com,Nike Running Shoes,"101 Elm St, Berlin, Germany"
107-4958372-6789012,david.miller@yandex.com,Lego Star Wars Set,"303 Cedar Blvd, Mumbai, India"
```

### 支持的格式特性

- ✅ **带引号的字段**：支持包含逗号的字段（用引号包裹）
- ✅ **任意列数**：可以包含任意数量的列
- ✅ **中英文字段名**：支持中文和英文字段名
- ✅ **灵活的字段结构**：不需要预定义 schema

### 数据验证规则

1. **邮箱字段识别**：自动识别包含 "email"、"邮箱" 或 "mail" 的列
2. **记录验证**：每条记录必须包含有效的邮箱地址
3. **自动跳过**：没有邮箱的记录会被自动跳过
4. **去重**：每个邮箱对应一条记录（如果 CSV 中有重复邮箱，会保留所有记录）

## 🔍 查询数据包

### 获取所有数据包

**接口：** `GET /api/snapshots`

**查询参数：**
- `page` (可选): 页码，默认 1
- `limit` (可选): 每页数量，默认 10
- `activityId` (可选): 如果提供，只返回关联到该活动的数据包
- `search` (可选): 搜索关键词（搜索名称和描述）

**示例：**

```javascript
// 获取所有数据包（包括独立数据包）
fetch('/api/snapshots?page=1&limit=10', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
})

// 只获取独立数据包（不关联活动的）
// 前端需要过滤 activityId 为 null 的数据包
```

**响应：**

```json
{
  "snapshots": [
    {
      "id": "31459208-4553-436b-82b1-119692007192",
      "name": "Order Data Pack 1",
      "description": "Customer orders from Q1 2025",
      "activityId": null,
      "merchantId": "...",
      "claims": { ... },
      "createdAt": "2025-11-10T16:14:45.103Z",
      "activity": null,
      "merchant": { ... },
      "tags": [ ... ]
    }
  ],
  "total": 1,
  "page": 1,
  "totalPages": 1
}
```

### 获取单个数据包详情

**接口：** `GET /api/snapshots/:id`

**示例：**

```javascript
fetch('/api/snapshots/31459208-4553-436b-82b1-119692007192', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
})
```

## 💡 前端实现建议

### 1. 文件上传组件

```javascript
// React 示例
const handleCSVUpload = async (file) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('name', 'Order Data Pack 1');
  formData.append('description', 'Customer orders from Q1 2025');

  try {
    const response = await fetch('/api/snapshots/upload-csv', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Upload failed');
    }

    const data = await response.json();
    console.log('Upload successful:', data);
    console.log('Import summary:', data.importSummary);
    
    // 显示成功消息
    // 刷新数据包列表
  } catch (error) {
    console.error('Upload error:', error);
    // 显示错误消息
  }
};
```

### 2. CSV 预览功能

建议在上传前提供 CSV 预览：

```javascript
const previewCSV = (file) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split('\n');
    const headers = lines[0].split(',');
    const preview = lines.slice(1, 6); // 预览前5行
    
    // 检查是否包含邮箱字段
    const hasEmail = headers.some(h => 
      h.toLowerCase().includes('email') || 
      h.toLowerCase().includes('邮箱') ||
      h.toLowerCase().includes('mail')
    );
    
    if (!hasEmail) {
      alert('CSV 必须包含邮箱字段（email/邮箱/mail）');
      return;
    }
    
    // 显示预览
    console.log('Headers:', headers);
    console.log('Preview:', preview);
  };
  reader.readAsText(file);
};
```

### 3. 数据包列表展示

```javascript
// 区分关联活动的数据包和独立数据包
const snapshots = response.snapshots.map(snapshot => ({
  ...snapshot,
  isStandalone: snapshot.activityId === null,
  recordCount: snapshot.claims?.recordCount || 0
}));

// 独立数据包显示
snapshots
  .filter(s => s.isStandalone)
  .map(snapshot => (
    <div key={snapshot.id}>
      <h3>{snapshot.name}</h3>
      <p>{snapshot.description}</p>
      <p>记录数: {snapshot.recordCount}</p>
      <p>类型: 独立数据包</p>
    </div>
  ));
```

## 🔗 后续功能

创建的数据包可以：

1. **打包成 DataNFT**：使用 `/api/data-nfts/merge` 接口
2. **在数据市场出售**：设置价格后发布
3. **查看数据详情**：通过 `claims.records` 字段访问所有记录
4. **编辑和删除**：使用现有的更新和删除接口

## 📝 注意事项

1. **文件大小限制**：最大 20MB
2. **文件格式**：只接受 CSV 文件
3. **邮箱验证**：每条记录必须包含有效的邮箱
4. **数据存储**：所有数据存储在 `claims` 字段（JSON 格式）
5. **自动清理**：上传的文件会在处理完成后自动删除

## 🧪 测试示例

参考项目中的 `data-pack-1.csv` 文件格式：

```csv
订单编号,邮箱,商品名称,收件地址
105-7462910-4567890,alice.williams@gmx.com,Nike Running Shoes,"101 Elm St, Berlin, Germany"
107-4958372-6789012,david.miller@yandex.com,Lego Star Wars Set,"303 Cedar Blvd, Mumbai, India"
```

## 📞 技术支持

如有问题，请联系后端开发团队。

