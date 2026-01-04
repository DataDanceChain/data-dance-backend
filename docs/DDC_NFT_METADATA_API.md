# DDC NFT Metadata API 文档

## 概述

DDC NFT Metadata API 提供了获取 DDC (DataDance Chain) NFT 元数据的接口。所有接口都需要后端权限控制（JWT 认证）。

## 配置信息

- **合约地址**: `0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2`
- **Base URL**: `https://api.datadance.ai/metadata/ddcnft`
- **支持的 Token IDs**: `1`, `2`
- **Key Hash**: `0x0fa48222cf2df620b509b72b7fdc2119833dc7538ecdb07173d84174d095692d`

## 认证

所有接口都需要在请求头中携带 JWT token：

```
Authorization: Bearer <your-jwt-token>
```

## API 接口

### 1. 获取特定 Token 的 Metadata

获取指定 token ID 的 NFT 元数据。

**请求**

```
GET /metadata/ddcnft/:tokenId
```

**路径参数**

- `tokenId` (number, required): Token ID，当前支持 `1` 或 `2`

**响应示例**

```json
{
  "status": "success",
  "data": {
    "name": "DDC NFT #1",
    "description": "DataDance Chain NFT Token #1",
    "image": "https://api.datadance.ai/metadata/ddcnft/1/image",
    "external_url": "https://api.datadance.ai/metadata/ddcnft/1",
    "attributes": [
      {
        "trait_type": "Token ID",
        "value": "1"
      },
      {
        "trait_type": "Contract Address",
        "value": "0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2"
      },
      {
        "trait_type": "Key Hash",
        "value": "0x0fa48222cf2df620b509b72b7fdc2119833dc7538ecdb07173d84174d095692d"
      },
      {
        "trait_type": "Owner",
        "value": "user@example.com"
      }
    ]
  }
}
```

**错误响应**

- `400 Bad Request`: Token ID 格式无效
- `404 Not Found`: Token ID 不支持或未找到
- `401 Unauthorized`: 未提供有效的认证 token
- `500 Internal Server Error`: 服务器错误

### 2. 获取支持的 Token IDs 列表

获取所有支持的 token IDs 和配置信息。

**请求**

```
GET /metadata/ddcnft/list/supported
```

**响应示例**

```json
{
  "status": "success",
  "data": {
    "supportedTokenIds": [1, 2],
    "contractAddress": "0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2",
    "baseUrl": "https://api.datadance.ai/metadata/ddcnft",
    "keyHash": "0x0fa48222cf2df620b509b72b7fdc2119833dc7538ecdb07173d84174d095692d"
  }
}
```

## 使用示例

### cURL

```bash
# 获取 Token 1 的 metadata
curl -X GET \
  https://api.datadance.ai/metadata/ddcnft/1 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 获取支持的 token IDs
curl -X GET \
  https://api.datadance.ai/metadata/ddcnft/list/supported \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### JavaScript (Fetch API)

```javascript
const token = 'YOUR_JWT_TOKEN';

// 获取 Token 1 的 metadata
fetch('https://api.datadance.ai/metadata/ddcnft/1', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
})
  .then(response => response.json())
  .then(data => console.log(data));

// 获取支持的 token IDs
fetch('https://api.datadance.ai/metadata/ddcnft/list/supported', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
})
  .then(response => response.json())
  .then(data => console.log(data));
```

## 权限控制

所有接口都使用 `protect` 中间件进行权限控制：

1. 请求必须包含有效的 JWT token
2. Token 必须未过期
3. 用户必须存在于数据库中

如果未提供 token 或 token 无效，将返回 `401 Unauthorized` 错误。

## 元数据结构

返回的 metadata 遵循 ERC721 Metadata 标准，包含以下字段：

- `name`: NFT 名称
- `description`: NFT 描述
- `image`: NFT 图片 URL
- `external_url`: 外部链接 URL
- `attributes`: 属性数组，包含各种特征

## 注意事项

1. 当前只支持 token ID `1` 和 `2`
2. 所有接口都需要认证
3. 如果访问不支持的 token ID，将返回 `404 Not Found`
4. 如果用户已登录，metadata 中会包含用户信息（如 Owner 属性）

## 未来扩展

- 支持更多 token IDs
- 从数据库动态获取 metadata
- 集成 DDC-Market-SDK 进行链上操作
- 支持图片上传和存储












