# 数据包上链状态清单

> **最后更新**: 2025-11-24  
> **合约地址**: `0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2`  
> **Base URL**: `https://api.datadance.ai/metadata/ddcnft`

## 📊 总体统计

### 数据包统计

| 数据包 | 分组数 | 数据记录数 | DataNFT 数 | 已上链 | 上链率 |
|--------|--------|------------|------------|--------|--------|
| **data-pack-1** | 19 | 38 | 19 | 13 | 68.42% |
| **data-pack-2** | 54 | 106,491 | 39 | 13 | 33.33% |
| **data-pack-3** | 54 | 138,732 | 0 | 0 | - |
| **总计** | **127** | **245,261** | **58** | **26** | **44.83%** |

### 三个数据包总数汇总

- **总分组数**: **127 个**
  - data-pack-1: 19 个
  - data-pack-2: 54 个
  - data-pack-3: 54 个

- **总数据记录数**: **245,261 条**
  - data-pack-1: 38 条
  - data-pack-2: 106,491 条
  - data-pack-3: 138,732 条

### 上链状态

- **已创建 DataNFT**: 58 个
- **已上链 DataNFT**: 26 个
- **上链进度**: 44.83%

---

## 📦 各数据包详情

### data-pack-1
- **分组数**: 19 个
- **数据记录数**: 38 条
- **DataNFT 数**: 19 个
- **已上链**: 13 个
- **待上链**: 6 个

### data-pack-2
- **分组数**: 54 个
- **数据记录数**: 106,491 条
- **DataNFT 数**: 39 个
- **已上链**: 13 个
- **待上链**: 26 个

### data-pack-3
- **分组数**: 54 个
- **数据记录数**: 138,732 条
- **DataNFT 数**: 0 个（待创建）
- **已上链**: 0 个
- **待上链**: 0 个

---

## 🔗 链上 Token ID 分配

### 已分配的 Token ID 范围

- **Token 1-2**: 预定义的系统 Token（合约配置）
- **Token 6-111**: DataNFT Token（已分配 26 个）
  - 最小 Token ID: **6**
  - 最大 Token ID: **111**
  - 已使用: **26 个**
  - 可用范围: **3-5, 8, 10, 12, 15-16, 24, 27-28, 30, 32, 35, 37-81, 83-96, 98, 101-109, 112+**

### Token ID 分配规则

1. **自增分配**: Token ID 从数据库和链上的最大值 + 1 开始分配
2. **唯一性保证**: 每次分配前会检查链上是否已存在该 Token ID
3. **冲突处理**: 如果冲突，自动递增直到找到可用 Token ID

---

## 📝 上链操作说明

### 批量上链

```bash
# 上链所有未上链的 DataNFT
node scripts/recordDataNFTToBlockchain.js --all

# 上链特定的 DataNFT
node scripts/recordDataNFTToBlockchain.js --nft-id <nft-id>
```

### 上链流程

1. **查询未上链的 DataNFT**: 筛选 `blockchainTokenId` 为 `null` 的记录
2. **生成 Token ID**: 从数据库和链上查询最大 Token ID，然后自增
3. **调用 SDK mint**: 使用 DDC Market SDK 的 `mint` 方法
4. **记录交易信息**: 保存 `blockchainTokenId`、`blockchainTxHash`、`blockchainRecordedAt`

### 上链配置

- **合约地址**: `0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2`
- **RPC URL**: `https://dev-exp-alpha.datadance.ai/eth/rpc`
- **Chain ID**: `44508`
- **Key Hash**: `0x0fa48222cf2df620b509b72b7fdc2119833dc7538ecdb07173d84174d095692d`
- **后端钱包**: 使用 `.env` 中的 `BACKEND_WALLET_PRIVATE_KEY`

---

## 🔍 查询链上 Metadata

### API 端点

```
GET /api/metadata/ddcnft/{tokenId}
```

### 示例

```bash
# 查询 Token 6 的 metadata
curl -X GET \
  https://api.datadance.ai/metadata/ddcnft/6 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### 响应格式

```json
{
  "status": "success",
  "data": {
    "name": "DDC NFT #6",
    "description": "DataDance Chain NFT Token #6",
    "image": "https://api.datadance.ai/metadata/ddcnft/6/image",
    "external_url": "https://api.datadance.ai/metadata/ddcnft/6",
    "attributes": [
      {
        "trait_type": "Token ID",
        "value": "6"
      },
      {
        "trait_type": "Contract Address",
        "value": "0xCcDfB99c5bb0328C4Ce3823d637F41d8687372E2"
      }
    ]
  }
}
```

---

## 📈 进度跟踪

### 上链进度

- **data-pack-1**: 13/19 (68.42%) ✅
- **data-pack-2**: 13/39 (33.33%) ⏳
- **data-pack-3**: 0/0 (-) ⏳ (DataNFT 尚未创建)
- **总计**: 26/58 (44.83%) ⏳

---

## ⚠️ 注意事项

1. **Token ID 唯一性**: 系统会自动确保 Token ID 的唯一性，避免冲突
2. **交易确认**: 上链操作需要等待交易确认，可能需要一些时间
3. **Gas 费用**: 上链操作需要消耗 Gas，确保后端钱包有足够的余额
4. **错误处理**: 如果上链失败，可以重新运行脚本，系统会跳过已上链的 DataNFT
5. **数据一致性**: 上链后，数据库中的 `blockchainTokenId`、`blockchainTxHash`、`blockchainRecordedAt` 字段会被更新

---

**最后更新**: 2025-11-24  
**维护者**: DataDance Backend Team

