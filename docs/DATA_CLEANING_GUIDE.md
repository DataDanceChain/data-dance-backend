# 数据清洗和分类指南

## 概述

数据清洗脚本用于将原始 CSV 数据按照**地域**、**人群**、**商品种类**进行分类和打标签，为后续创建商家账户和上架 DataNFT 做准备。

## 功能特性

### 1. 地域分类
- **大洲级别**: North America, Europe, Asia, South America, Oceania, Middle East
- **国家级别**: 识别 20+ 个国家
- **城市级别**: 提取城市信息

### 2. 人群分类
根据邮箱域名和商品类型识别：
- **General Consumer** - 普通消费者
- **Parents** - 父母群体
- **Beauty Enthusiasts** - 美妆爱好者
- **Fitness Enthusiasts** - 健身爱好者
- **Book Lovers** - 图书爱好者
- **Tech Enthusiasts** - 科技爱好者
- **Privacy-Conscious** - 注重隐私的用户
- **Luxury Shoppers** - 奢侈品购买者

### 3. 商品分类
- Baby & Kids
- Beauty & Personal Care
- Fashion & Apparel
- Electronics
- Home & Kitchen
- Books & Media
- Sports & Outdoors
- Health & Wellness
- Gaming
- Automotive

### 4. 标签系统
自动生成标签：
- `Region:{region}` - 大洲标签
- `Country:{country}` - 国家标签
- `City:{city}` - 城市标签
- `Demographic:{demographic}` - 人群标签
- `Category:{category}` - 商品类别标签
- `HasEmail` - 有邮箱
- `HasAddress` - 有地址

## 使用方法

### 基本用法

```bash
# 清洗单个文件
node scripts/cleanAndCategorizeDataPack.js data-pack-1.csv

# 清洗多个文件
node scripts/cleanAndCategorizeDataPack.js data-pack-1.csv data-pack-2.csv
```

### 输出文件

脚本会在 `cleaned-data/` 目录下生成以下文件：

1. **`{filename}_cleaned.json`** - 完整的清洗后数据（包含 metadata）
2. **`{filename}_groups.json`** - 按分类分组的数据
3. **`{filename}_groups/`** - 每个分组的独立 CSV 文件

### 输出示例

```
cleaned-data/
├── data-pack-1_cleaned.json          # 完整清洗数据
├── data-pack-1_groups.json           # 分组数据
└── data-pack-1_groups/               # 分组 CSV 文件
    ├── Europe-Fashion___Apparel.csv
    ├── Asia-Books___Media.csv
    ├── North_America-Electronics.csv
    └── ...
```

## 数据统计

运行脚本后会显示统计信息：

```
📈 Statistics:

By Region:
  Europe: 17
  Asia: 9
  North America: 7
  ...

By Category:
  Books & Media: 19
  Electronics: 8
  ...

By Country (Top 10):
  United States: 6
  United Kingdom: 4
  ...

By Demographic:
  General Consumer: 29
  Book Lovers: 18
  ...
```

## 数据格式

### 清洗后的数据格式

每条记录包含原始字段 + `_metadata` 字段：

```json
{
  "订单编号": "105-7462910-4567890",
  "邮箱": "alice.williams@gmx.com",
  "商品名称": "Nike Running Shoes",
  "收件地址": "101 Elm St, Berlin, Germany",
  "_metadata": {
    "region": "Europe",
    "country": "Germany",
    "city": "",
    "demographics": ["Privacy-Conscious", "Fitness Enthusiasts"],
    "category": "Fashion & Apparel",
    "tags": [
      "Region:Europe",
      "Country:Germany",
      "Demographic:Privacy-Conscious",
      "Demographic:Fitness Enthusiasts",
      "Category:Fashion & Apparel",
      "HasEmail",
      "HasAddress"
    ]
  }
}
```

## 下一步：创建商家和上架 DataNFT

清洗完成后，可以：

1. **按分组创建商家账户**
   - 每个分组对应一个商家
   - 商家名称：`{Region} {Category} Merchant`
   - 例如：`Europe Fashion & Apparel Merchant`

2. **为每个商家创建 DataNFT**
   - 使用分组 CSV 文件作为数据源
   - 设置价格、描述等元数据
   - 自动发布到市场

3. **区块链记录**
   - 使用 DDC Market SDK 在链上记录
   - 每个 DataNFT 对应一个链上 token

## 工作流程

```
原始 CSV 数据
    ↓
数据清洗脚本
    ↓
清洗后的数据 + 分组数据
    ↓
创建商家账户（按分组）
    ↓
为每个商家创建 DataNFT
    ↓
上架到数据市场
    ↓
区块链记录
```

## 注意事项

1. **邮箱字段必需**: 没有邮箱的记录会被跳过
2. **地址识别**: 脚本会尝试从多个字段识别地址信息
3. **商品分类**: 基于关键词匹配，可能需要根据实际数据调整
4. **分组策略**: 当前按 `Region-Category` 分组，可以根据需要修改

## 自定义配置

如需修改分类规则，编辑 `scripts/cleanAndCategorizeDataPack.js`：

- `categorizeByRegion()` - 地域分类规则
- `categorizeByDemographic()` - 人群分类规则
- `categorizeByProductCategory()` - 商品分类规则
- `groupByCategory()` - 分组策略

## 示例：处理 data-pack-1.csv

```bash
# 运行清洗
node scripts/cleanAndCategorizeDataPack.js data-pack-1.csv

# 输出：
# ✅ Cleaned records: 39
# 📁 Output directory: cleaned-data/
# 💾 Saved 19 group CSV files
```

清洗完成后，你会得到：
- 39 条清洗后的记录
- 19 个分组（按 Region-Category）
- 每个分组一个独立的 CSV 文件

## 相关脚本

- `scripts/importDataPackAsDataNFT.js` - 导入数据包为 DataNFT
- `scripts/importDataPack2FromCSV.js` - 导入 data-pack-2
- `scripts/importDataPack2SplitFromCSV.js` - 分割导入

## 下一步计划

1. ✅ 数据清洗（当前步骤）
2. 🔄 创建商家账户脚本
3. 🔄 批量创建 DataNFT 脚本
4. 🔄 上架到市场脚本
5. 🔄 区块链记录脚本









