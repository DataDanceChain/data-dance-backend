# Data Market Image API Update

## 📋 更新概述

数据包的图片已从 JPG/PNG 格式更新为 SVG 格式，图片路径也发生了变化。本文档说明前端需要做的调整。

## 🔄 图片路径变化

### 之前
```json
{
  "coverImage": "/assets/nfts/data-pack-default.jpg"
}
```

### 现在
```json
{
  "coverImage": "/data-pack/Electronics Data Pack.svg"
}
```

## 📡 受影响的接口

### 1. 市场列表接口
**接口**: `GET /nft-market`

**响应字段**:
```json
{
  "status": "success",
  "data": [
    {
      "id": "nft-id",
      "title": "Electronics Data Pack - North America",
      "coverImage": "/data-pack/Electronics Data Pack.svg",  // ⚠️ 已更新为 SVG
      "owner": "DataDance Official",
      "size": 1234,
      "price": 299.99,
      ...
    }
  ]
}
```

### 2. 市场详情接口
**接口**: `GET /nft-market/:id`

**响应字段**:
```json
{
  "status": "success",
  "data": {
    "id": "nft-id",
    "title": "Electronics Data Pack - North America",
    "coverImage": "/data-pack/Electronics Data Pack.svg",  // ⚠️ 已更新为 SVG
    "owner": "DataDance Official",
    "size": 1234,
    "price": 299.99,
    ...
  }
}
```

### 3. 我的购买记录接口
**接口**: `GET /nft-market/my-purchases`

**响应字段**:
```json
{
  "status": "success",
  "data": [
    {
      "orderId": "order-id",
      "nftId": "nft-id",
      "title": "Electronics Data Pack - North America",
      "coverImage": "/data-pack/Electronics Data Pack.svg",  // ⚠️ 已更新为 SVG
      "price": 299.99,
      ...
    }
  ]
}
```

### 4. 我的销售记录接口
**接口**: `GET /nft-market/my-sales`

**响应字段**:
```json
{
  "status": "success",
  "data": [
    {
      "nftId": "nft-id",
      "title": "Electronics Data Pack - North America",
      "coverImage": "/data-pack/Electronics Data Pack.svg",  // ⚠️ 已更新为 SVG
      "sales": 5,
      "revenue": 1499.95,
      ...
    }
  ]
}
```

### 5. DataNFT 列表接口
**接口**: `GET /api/data-nfts`

**响应字段**:
```json
{
  "status": "success",
  "data": {
    "data": [
      {
        "id": "nft-id",
        "name": "Electronics Data Pack - North America",
        "image": "/data-pack/Electronics Data Pack.svg",  // ⚠️ 已更新为 SVG
        "price": 299.99,
        ...
      }
    ]
  }
}
```

### 6. DataNFT 详情接口
**接口**: `GET /api/data-nfts/:id`

**响应字段**:
```json
{
  "id": "nft-id",
  "name": "Electronics Data Pack - North America",
  "image": "/data-pack/Electronics Data Pack.svg",  // ⚠️ 已更新为 SVG
  "price": 299.99,
  ...
}
```

## 🎨 前端需要调整的内容

### 1. 图片路径处理

**之前**:
```javascript
// JPG/PNG 图片
<img src={nft.coverImage} alt={nft.title} />
```

**现在**:
```javascript
// SVG 图片 - 可以直接使用，无需特殊处理
<img src={nft.coverImage} alt={nft.title} />

// 或者使用 object/embed（如果需要）
<object data={nft.coverImage} type="image/svg+xml">
  <img src="/data-pack/Other Data Pack.svg" alt="Fallback" />
</object>
```

### 2. 图片格式检测（可选）

如果需要区分图片类型，可以检测文件扩展名：

```javascript
function getImageType(imagePath) {
  if (!imagePath) return 'unknown';
  
  const ext = imagePath.split('.').pop()?.toLowerCase();
  if (ext === 'svg') return 'svg';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'raster';
  return 'unknown';
}

// 使用示例
const imageType = getImageType(nft.coverImage);
if (imageType === 'svg') {
  // SVG 特殊处理（如果需要）
  return <img src={nft.coverImage} alt={nft.title} />;
} else {
  // 普通图片处理
  return <img src={nft.coverImage} alt={nft.title} />;
}
```

### 3. 图片加载错误处理

建议添加错误处理和默认图片：

```javascript
function DataPackImage({ src, alt, className }) {
  const [imgSrc, setImgSrc] = useState(src);
  const [hasError, setHasError] = useState(false);

  const handleError = () => {
    if (!hasError) {
      // 如果 SVG 加载失败，使用默认图片
      setImgSrc('/data-pack/Other Data Pack.svg');
      setHasError(true);
    }
  };

  return (
    <img
      src={imgSrc}
      alt={alt}
      className={className}
      onError={handleError}
    />
  );
}
```

### 4. CSS 样式调整

SVG 图片可能需要不同的样式处理：

```css
/* SVG 图片样式 */
.data-pack-image {
  width: 100%;
  height: auto;
  object-fit: contain; /* SVG 通常使用 contain 而不是 cover */
}

/* 如果需要固定尺寸 */
.data-pack-image-container {
  width: 100%;
  aspect-ratio: 1 / 1; /* 或其他比例 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5; /* 可选背景色 */
}
```

### 5. 图片路径前缀处理

如果前端需要完整的 URL，确保正确处理路径：

```javascript
// 如果图片路径已经是完整路径，直接使用
const imageUrl = nft.coverImage.startsWith('http') 
  ? nft.coverImage 
  : `${API_BASE_URL}${nft.coverImage}`;

// 或者如果使用相对路径
const imageUrl = nft.coverImage; // 直接使用，浏览器会自动处理
```

## 📝 图片路径格式说明

### 数据包图片路径格式
```
/data-pack/{Category} Data Pack.svg
```

### 支持的类别
- `Automotive Data Pack.svg`
- `Baby & Kids Data Pack.svg`
- `Beauty & Personal Care Data Pack.svg`
- `Books & Media Data Pack.svg`
- `Electronics Data Pack.svg`
- `Fashion & Apparel Data Pack.svg`
- `Health & Wellness Data Pack.svg`
- `Home & Kitchen Data Pack.svg`
- `Sports & Outdoors Data Pack.svg`
- `Other Data Pack.svg`

## ⚠️ 注意事项

1. **SVG 支持**: 确保浏览器支持 SVG（现代浏览器都支持）
2. **路径格式**: 图片路径以 `/` 开头，是相对于网站根目录的路径
3. **CORS**: 如果 SVG 需要跨域加载，确保服务器配置了正确的 CORS 头
4. **缓存**: SVG 文件可以被浏览器缓存，确保更新后清除缓存
5. **兼容性**: 如果需要在旧浏览器中支持，可能需要 SVG polyfill

## 🔍 测试建议

1. **检查图片加载**: 确保所有 SVG 图片都能正常加载
2. **响应式设计**: 测试在不同屏幕尺寸下 SVG 的显示效果
3. **加载性能**: SVG 通常比 JPG/PNG 文件小，但需要测试实际加载时间
4. **错误处理**: 测试图片加载失败时的降级处理

## 📚 相关文档

- [Update Data Pack Images Script](./UPDATE_DATA_PACK_IMAGES.md)
- [Data Market API Documentation](./MERCHANT_API_DOC.md)



