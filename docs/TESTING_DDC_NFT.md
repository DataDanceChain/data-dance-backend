# DDC NFT Metadata API 测试指南

## 当前状态

### ✅ 已完成
1. **SDK 安装**: `@ddcmarket/sdk` 已安装
2. **Ethers 集成**: 直接使用 `ethers v6` 与合约交互（SDK 的 dist 目录不存在，但功能完整）
3. **API 接口**: `/metadata/ddcnft/:tokenId` 已实现
4. **权限控制**: 所有接口都需要 JWT 认证

### ⚠️ 注意事项
- SDK 的 `dist` 目录不存在，无法直接使用 SDK 的封装方法
- 当前实现直接使用 `ethers` 与合约交互，功能完整
- 如果需要使用 SDK 的高级功能，需要先构建 SDK

## 测试方法

### 方法 1: 使用测试脚本（推荐）

运行测试脚本，测试链上交互：

```bash
# 确保后端服务未运行，或者使用独立的测试环境
node scripts/testDDCNFTMetadata.js
```

这个脚本会测试：
- ✅ Provider 连接
- ✅ 合约实例创建
- ✅ Token 查询（ownerOf, tokenURI）
- ✅ Metadata 服务
- ✅ 链上信息查询

### 方法 2: 启动后端服务并测试 API

#### 步骤 1: 启动后端服务

```bash
# 确保数据库已启动
# 确保 .env 文件配置正确

# 启动开发服务器
npm run dev
# 或
yarn dev
```

#### 步骤 2: 获取 JWT Token

首先需要登录获取 token：

```bash
# 使用现有的登录接口获取 token
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your-email@example.com",
    "password": "your-password"
  }'
```

#### 步骤 3: 测试 Metadata API

```bash
# 设置 token 变量
export TOKEN="your-jwt-token-here"

# 测试获取 Token 1 的 metadata
curl -X GET http://localhost:3000/metadata/ddcnft/1 \
  -H "Authorization: Bearer $TOKEN"

# 测试获取 Token 2 的 metadata
curl -X GET http://localhost:3000/metadata/ddcnft/2 \
  -H "Authorization: Bearer $TOKEN"

# 测试获取支持的 token IDs
curl -X GET http://localhost:3000/metadata/ddcnft/list/supported \
  -H "Authorization: Bearer $TOKEN"
```

### 方法 3: 使用 Postman 或类似工具

1. **创建请求**:
   - Method: `GET`
   - URL: `http://localhost:3000/metadata/ddcnft/1`
   - Headers:
     - `Authorization: Bearer <your-token>`

2. **测试不同场景**:
   - ✅ 有效的 token ID (1, 2)
   - ❌ 无效的 token ID (3, 999)
   - ❌ 未认证的请求（不提供 token）
   - ❌ 无效的 token

## 环境变量配置

确保 `.env` 文件中包含以下配置：

```env
# DDC RPC 配置（可选，有默认值）
DDC_RPC_URL=https://dev-exp-alpha.datadance.ai/eth/rpc
DDC_CHAIN_ID=44508

# JWT 配置（必需）
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d

# 数据库配置（必需）
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/datadance?schema=public
```

## 预期结果

### 成功的响应示例

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
        "trait_type": "On-chain Owner",
        "value": "0x..."
      },
      {
        "trait_type": "Requested By",
        "value": "user@example.com"
      }
    ]
  }
}
```

### 错误响应示例

```json
{
  "status": "fail",
  "code": "TOKEN_NOT_FOUND",
  "message": "Token ID 999 is not supported",
  "supportedTokenIds": [1, 2]
}
```

## 测试检查清单

- [ ] Provider 连接成功
- [ ] 合约实例创建成功
- [ ] Token 1 查询成功
- [ ] Token 2 查询成功
- [ ] Metadata API 返回正确格式
- [ ] 权限控制正常工作（未认证请求被拒绝）
- [ ] 无效 token ID 返回正确错误
- [ ] 链上信息查询成功（如果合约支持）

## 故障排查

### 问题 1: Provider 连接失败

**症状**: `Cannot connect to RPC`

**解决方案**:
- 检查 `DDC_RPC_URL` 环境变量
- 确认网络连接正常
- 检查 RPC 节点是否可访问

### 问题 2: 合约查询失败

**症状**: `Contract function not available`

**解决方案**:
- 这是正常的，如果合约未实现某些函数
- 代码会自动降级使用默认 metadata
- 检查合约地址是否正确

### 问题 3: 认证失败

**症状**: `401 Unauthorized`

**解决方案**:
- 检查 JWT token 是否有效
- 确认 token 未过期
- 检查请求头格式: `Authorization: Bearer <token>`

### 问题 4: SDK 无法加载

**症状**: `Cannot find module '@ddcmarket/sdk/dist/cjs/index.js'`

**解决方案**:
- 这是正常的，SDK 的 dist 目录不存在
- 当前实现直接使用 ethers，功能完整
- 如果需要 SDK，需要先构建 SDK

## 下一步

1. ✅ 运行测试脚本验证链上交互
2. ✅ 启动后端服务测试 API
3. ✅ 验证权限控制
4. 🔄 根据实际需求调整 metadata 内容
5. 🔄 集成数据库查询（如果需要）

## 相关文件

- `scripts/testDDCNFTMetadata.js` - 测试脚本
- `src/services/ddcNFTMetadataService.js` - 服务层
- `src/controllers/ddcNFTMetadataController.js` - 控制器
- `src/routes/ddcNFTMetadataRoutes.js` - 路由










