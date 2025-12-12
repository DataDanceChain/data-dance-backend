# 服务器环境添加新数据包操作指南

## 快速步骤

```bash
# 1. 拉取最新代码
git pull

# 2. 运行数据库迁移（添加区块链字段）
npx prisma migrate deploy

# 3. 准备数据包 CSV 文件（放到项目根目录）
# 例如: data-pack-3.csv

# 4. 清洗和分类数据（生成 cleaned-data/data-pack-3_groups.json）
node scripts/cleanAndCategorizeDataPack.js

# 5. 创建商家和 DataNFT（写入数据库）
node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-3_groups.json --publish

# 6. 上链操作
node scripts/recordDataNFTToBlockchain.js --all
```

## 注意事项

- ✅ 确保 `.env` 中配置了 `BACKEND_WALLET_PRIVATE_KEY`
- ✅ 确保后端钱包有足够的 ETH 支付 gas 费用
- ✅ 上链脚本会自动跳过已上链的 DataNFT
- ✅ Token ID 使用 serial 序号（从 3 开始，兼容 Activity NFT）

## 验证

- 检查数据库：查看 `DataNFT` 表中的 `blockchainTokenId` 和 `blockchainTxHash` 字段
- 检查链上：使用 tokenId 查询链上合约确认 mint 成功






