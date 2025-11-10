# CSV 数据包上传功能 - 前端开发说明

## 🎯 功能概述

后端已新增支持通过 CSV 文件上传创建**独立数据包（Snapshot）**的功能。数据包**不需要关联活动**，可以直接作为独立的数据资产存储，后续可以打包成 DataNFT 进行交易。

---

## 📡 API 接口

### 上传 CSV 创建数据包

**接口地址：** `POST /api/snapshots/upload-csv`

**请求方式：** `multipart/form-data` (文件上传)

**认证：** 需要商家账号登录（Bearer Token）

**请求参数：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `file` | File | ✅ | CSV 文件（最大 20MB） |
| `name` | String | ✅ | 数据包名称 |
| `description` | String | ❌ | 数据包描述（可选） |
| `tags` | String | ❌ | JSON 字符串数组，标签ID列表（可选） |

**请求示例（JavaScript）：**

```javascript
const formData = new FormData();
formData.append('file', csvFile); // csvFile 是 File 对象
formData.append('name', '订单数据包1');
formData.append('description', '2025年第一季度订单数据');

const response = await fetch('/api/snapshots/upload-csv', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
});

const data = await response.json();
console.log('创建成功:', data);
console.log('导入统计:', data.importSummary);
```

**成功响应（201）：**

```json
{
  "id": "snapshot-id-xxx",
  "name": "订单数据包1",
  "description": "2025年第一季度订单数据",
  "activityId": null,
  "merchantId": "merchant-id",
  "createdAt": "2025-11-10T16:14:45.103Z",
  "claims": {
    "recordCount": 39,
    "totalRecords": 39,
    "skippedRecords": 0,
    "emailField": "邮箱",
    "records": [
      {
        "recordId": 1,
        "email": "alice.williams@gmx.com",
        "订单编号": "105-7462910-4567890",
        "商品名称": "Nike Running Shoes",
        "收件地址": "101 Elm St, Berlin, Germany"
      }
      // ... 更多记录
    ]
  },
  "importSummary": {
    "totalRecords": 39,
    "validRecords": 39,
    "skippedRecords": 0,
    "emailField": "邮箱"
  }
}
```

**错误响应：**

- `400` - CSV 文件缺失：`{ "error": "CSV file is required" }`
- `400` - 名称缺失：`{ "error": "Name is required" }`
- `400` - 缺少邮箱字段：`{ "error": "CSV must contain an email field (邮箱/email/mail)" }`
- `400` - 无有效记录：`{ "error": "No valid records with email found in CSV" }`
- `500` - 服务器错误：`{ "error": "Failed to create snapshot from CSV", "message": "..." }`

---

## 📄 CSV 文件格式要求

### ✅ 必需字段

CSV 文件**必须包含一个邮箱列**，列名可以是以下任意一种：
- `email` / `Email` / `EMAIL`
- `邮箱`
- `mail` / `Mail` / `MAIL`

### ✅ CSV 格式示例

```csv
订单编号,邮箱,商品名称,收件地址
105-7462910-4567890,alice.williams@gmx.com,Nike Running Shoes,"101 Elm St, Berlin, Germany"
107-4958372-6789012,david.miller@yandex.com,Lego Star Wars Set,"303 Cedar Blvd, Mumbai, India"
```

### ✅ 支持的格式

- ✅ 带引号的字段（处理包含逗号的字段）
- ✅ 任意列数
- ✅ 中英文字段名
- ✅ 灵活的字段结构

### ⚠️ 数据验证

- 每条记录必须包含有效的邮箱
- 没有邮箱的记录会被自动跳过
- 每个邮箱对应一条记录（保留所有记录，不去重）

---

## 🔍 查询数据包

### 获取所有数据包

**接口：** `GET /api/snapshots`

**查询参数：**
- `page` (可选): 页码，默认 1
- `limit` (可选): 每页数量，默认 10
- `search` (可选): 搜索关键词

**注意：** 独立数据包的 `activityId` 字段为 `null`

**示例：**

```javascript
// 获取所有数据包
const response = await fetch('/api/snapshots?page=1&limit=10', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();

// 筛选独立数据包（不关联活动的）
const standalonePacks = data.snapshots.filter(s => s.activityId === null);
```

---

## 💻 前端实现示例

### React 组件示例

```jsx
import React, { useState } from 'react';

function CSVUploadForm() {
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!file || !name) {
      alert('请选择CSV文件并输入数据包名称');
      return;
    }

    setLoading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name);
    formData.append('description', description);

    try {
      const response = await fetch('/api/snapshots/upload-csv', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '上传失败');
      }

      setResult(data);
      alert(`上传成功！共导入 ${data.importSummary.validRecords} 条有效记录`);
      
      // 重置表单
      setFile(null);
      setName('');
      setDescription('');
    } catch (error) {
      alert(`上传失败: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <label>CSV 文件：</label>
        <input
          type="file"
          accept=".csv"
          onChange={(e) => setFile(e.target.files[0])}
          required
        />
      </div>
      
      <div>
        <label>数据包名称：</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：订单数据包1"
          required
        />
      </div>
      
      <div>
        <label>描述（可选）：</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="数据包描述"
        />
      </div>
      
      <button type="submit" disabled={loading}>
        {loading ? '上传中...' : '上传CSV'}
      </button>
      
      {result && (
        <div>
          <h3>导入结果：</h3>
          <p>总记录数: {result.importSummary.totalRecords}</p>
          <p>有效记录: {result.importSummary.validRecords}</p>
          <p>跳过记录: {result.importSummary.skippedRecords}</p>
        </div>
      )}
    </form>
  );
}
```

### CSV 预览功能（可选）

```javascript
// 上传前预览CSV
const previewCSV = (file) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split('\n').filter(line => line.trim());
    const headers = lines[0].split(',');
    
    // 检查是否包含邮箱字段
    const hasEmail = headers.some(h => {
      const lower = h.toLowerCase().trim();
      return lower.includes('email') || 
             lower.includes('邮箱') || 
             lower.includes('mail');
    });
    
    if (!hasEmail) {
      alert('❌ CSV 必须包含邮箱字段（email/邮箱/mail）');
      return false;
    }
    
    // 显示预览（前5行）
    const preview = lines.slice(0, 6);
    console.log('CSV 预览:', preview);
    return true;
  };
  reader.readAsText(file);
};
```

---

## 📊 数据包数据结构

### Snapshot 对象结构

```typescript
interface Snapshot {
  id: string;
  name: string;
  description?: string;
  activityId: string | null;  // 独立数据包为 null
  merchantId: string;
  createdAt: string;
  updatedAt: string;
  claims: {
    fileName: string;
    recordCount: number;
    totalRecords: number;
    skippedRecords: number;
    emailField: string;
    headers: string[];
    records: Array<{
      recordId: number;
      email: string;
      [key: string]: any;  // 其他所有CSV字段
    }>;
  };
  merchant: User;
  tags: Tag[];
  activity: Activity | null;  // 独立数据包为 null
}
```

---

## 🔗 后续功能

创建的数据包可以：

1. **打包成 DataNFT**：使用 `/api/data-nfts/merge` 接口
2. **在数据市场出售**：设置价格后发布
3. **查看数据详情**：通过 `claims.records` 访问所有记录
4. **编辑和删除**：使用现有的更新和删除接口

---

## ⚠️ 注意事项

1. **文件大小**：最大 20MB
2. **文件格式**：只接受 `.csv` 文件
3. **邮箱验证**：每条记录必须包含有效邮箱
4. **数据存储**：所有数据存储在 `claims` 字段（JSON格式）
5. **独立数据包**：`activityId` 为 `null`，表示不关联活动

---

## 📝 快速开始

1. **准备 CSV 文件**：确保包含邮箱字段
2. **调用上传接口**：`POST /api/snapshots/upload-csv`
3. **处理响应**：显示导入统计信息
4. **刷新列表**：调用 `GET /api/snapshots` 获取最新数据包列表

---

## 🧪 测试数据

可以使用项目中的 `data-pack-1.csv` 作为测试文件：

```csv
订单编号,邮箱,商品名称,收件地址
105-7462910-4567890,alice.williams@gmx.com,Nike Running Shoes,"101 Elm St, Berlin, Germany"
```

---

## 📞 技术支持

如有问题，请联系后端开发团队。

