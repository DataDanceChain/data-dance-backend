# Data Pack Image Serving

## ✅ 已实现的静态文件服务

后端已配置静态文件服务，所有数据包图片都可以通过 HTTP 访问。

## 📡 图片访问路径

### 数据包图片
所有数据包 SVG 图片可以通过以下路径访问：

```
http://localhost:8080/data-pack/{Category} Data Pack.svg
```

**示例**:
- `http://localhost:8080/data-pack/Electronics Data Pack.svg`
- `http://localhost:8080/data-pack/Fashion & Apparel Data Pack.svg`
- `http://localhost:8080/data-pack/Home & Kitchen Data Pack.svg`
- `http://localhost:8080/data-pack/Other Data Pack.svg`

### Owner 头像图片
所有用户和商家的头像图片可以通过以下路径访问：

```
http://localhost:8080/assets/avatars/{filename}.jpg
```

**示例**:
- `http://localhost:8080/assets/avatars/default-avatar.jpg`
- `http://localhost:8080/assets/avatars/merchant-avatar.png`

## 🔧 后端配置

### 静态文件服务配置

在 `src/app.js` 中已配置：

#### 1. Assets 静态文件服务（头像、Logo、Banner 等）

```javascript
// 静态文件服务 - Assets (avatars, logos, banners, nfts, etc.)
app.use('/assets', express.static(path.join(__dirname, '../public/assets'), {
  setHeaders: (res, filePath) => {
    // Apple Wallet pass 文件
    if (filePath.endsWith('.pkpass')) {
      res.set('Content-Type', 'application/vnd.apple.pkpass');
    }
    // 图片文件设置缓存
    else if (filePath.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i)) {
      res.set('Cache-Control', 'public, max-age=31536000'); // 1年
    }
  }
}));
```

#### 2. Data Pack 图片静态文件服务

```javascript
// 静态文件服务 - Data Pack Images
app.use('/data-pack', express.static(path.join(__dirname, '../public/data-pack'), {
  setHeaders: (res, filePath) => {
    // 确保 SVG 文件返回正确的 MIME 类型
    if (filePath.endsWith('.svg')) {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=31536000'); // 1年
    }
  }
}));
```

### 目录结构

```
public/
  ├── assets/
  │   ├── avatars/          # 用户和商家头像
  │   │   └── default-avatar.jpg
  │   ├── banners/          # 活动横幅
  │   ├── nfts/            # NFT 图片（活动数据）
  │   ├── logos/           # Logo 图片
  │   └── badges/          # 徽章图片
  └── data-pack/           # 数据包 SVG 图片
      ├── Automotive Data Pack.svg
      ├── Baby & Kids Data Pack.svg
      ├── Beauty & Personal Care Data Pack.svg
      ├── Books & Media Data Pack.svg
      ├── Electronics Data Pack.svg
      ├── Fashion & Apparel Data Pack.svg
      ├── Health & Wellness Data Pack.svg
      ├── Home & Kitchen Data Pack.svg
      ├── Sports & Outdoors Data Pack.svg
      └── Other Data Pack.svg
```

## 🌐 前端使用

### 方式 1: 直接使用相对路径（推荐）

```javascript
// DataNFT 封面图
<img src={nft.coverImage} alt={nft.title} />
// 浏览器会自动使用当前域名，变成：
// http://localhost:8080/data-pack/Electronics Data Pack.svg

// Owner 头像
<img src={nft.ownerAvatar} alt={nft.owner} />
// 浏览器会自动使用当前域名，变成：
// http://localhost:8080/assets/avatars/default-avatar.jpg
```

### 方式 2: 使用完整 URL

```javascript
const API_BASE_URL = 'http://localhost:8080';

// DataNFT 封面图
const coverImageUrl = nft.coverImage.startsWith('http') 
  ? nft.coverImage 
  : `${API_BASE_URL}${nft.coverImage}`;

// Owner 头像
const avatarUrl = nft.ownerAvatar?.startsWith('http') 
  ? nft.ownerAvatar 
  : `${API_BASE_URL}${nft.ownerAvatar || '/assets/avatars/default-avatar.jpg'}`;

<img src={coverImageUrl} alt={nft.title} />
<img src={avatarUrl} alt={nft.owner} />
```

### 方式 3: 使用 Next.js Image 组件（如果使用 Next.js）

```javascript
import Image from 'next/image';

<Image
  src={nft.coverImage}
  alt={nft.title}
  width={400}
  height={400}
  unoptimized={true} // SVG 不需要优化
/>
```

## 📋 HTTP 响应头

### SVG 图片响应头

当访问 SVG 图片时，服务器会返回：

```
Content-Type: image/svg+xml
Cache-Control: public, max-age=31536000
```

### JPG/PNG 图片响应头

当访问 JPG/PNG 图片（头像、NFT 等）时，服务器会返回：

```
Content-Type: image/jpeg 或 image/png
Cache-Control: public, max-age=31536000
```

这确保了：
- ✅ 浏览器正确识别图片格式
- ✅ 图片可以被缓存，提高性能
- ✅ 支持跨域访问（如果配置了 CORS）

## 🧪 测试

### 使用 curl 测试

```bash
# 测试 SVG 图片访问
curl -I http://localhost:8080/data-pack/Electronics Data Pack.svg

# 应该返回：
# HTTP/1.1 200 OK
# Content-Type: image/svg+xml
# Cache-Control: public, max-age=31536000
```

### 在浏览器中测试

直接在浏览器地址栏访问：
```
http://localhost:8080/data-pack/Electronics Data Pack.svg
```

应该能看到 SVG 图片内容。

### 在 HTML 中测试

```html
<!DOCTYPE html>
<html>
<head>
  <title>Test Data Pack Image</title>
</head>
<body>
  <img src="http://localhost:8080/data-pack/Electronics Data Pack.svg" 
       alt="Electronics Data Pack" 
       style="width: 200px; height: 200px;" />
</body>
</html>
```

## ⚠️ 注意事项

1. **路径编码**: 如果图片名称包含特殊字符（如空格、&），浏览器会自动进行 URL 编码
   - `Electronics Data Pack.svg` → `Electronics%20Data%20Pack.svg`
   - 后端会自动处理，无需手动编码

2. **CORS**: 如果前端和后端在不同域名，确保 CORS 配置正确

3. **缓存**: SVG 文件设置了 1 年缓存，更新图片后可能需要清除浏览器缓存

4. **文件大小**: SVG 文件通常比 JPG/PNG 小，但确保文件大小合理（建议 < 500KB）

## 🔍 故障排查

### 问题：404 Not Found

**可能原因**:
- 文件不存在于 `public/data-pack/` 目录
- 文件名称不匹配（注意大小写和空格）

**解决方法**:
```bash
# 检查文件是否存在
ls -la public/data-pack/

# 检查文件权限
chmod 644 public/data-pack/*.svg
```

### 问题：Content-Type 错误

**可能原因**:
- 服务器没有正确识别 SVG 文件

**解决方法**:
- 确保 `app.js` 中的静态文件服务配置正确
- 检查文件扩展名是否为 `.svg`

### 问题：图片不显示

**可能原因**:
- CORS 配置问题
- 路径错误
- 浏览器缓存

**解决方法**:
- 检查浏览器控制台的错误信息
- 尝试直接访问图片 URL
- 清除浏览器缓存

## 📚 相关文档

- [Data Market API Changes Summary](./DATA_MARKET_API_CHANGES_SUMMARY.md)
- [Update Data Pack Images Script](./UPDATE_DATA_PACK_IMAGES.md)
