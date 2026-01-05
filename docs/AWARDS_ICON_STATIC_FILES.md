# Awards Icon Static Files - 前端访问说明

## 概述

Awards 的图标文件通过后端静态文件服务提供，前端可以直接通过 HTTP 请求访问。

---

## 文件位置

### 图标文件目录

```
public/assets/websites/
├── amazon.png          # Amazon Logo
├── airbnb.webp         # Airbnb Logo
├── booking.svg          # Booking Logo
├── luma.png            # Luma Logo
└── [其他图标文件]      # Awards 图标（如果放在这里）
```

---

## 静态文件服务配置

### 后端配置

在 `src/app.js` 中已配置静态文件服务：

```javascript
// 静态文件服务 - Assets
app.use('/assets', express.static(path.join(__dirname, '../public/assets'), {
  setHeaders: (res, filePath) => {
    // 图片文件（PNG, JPG, WEBP 等）
    if (filePath.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i)) {
      res.set('Cache-Control', 'public, max-age=31536000'); // 1年缓存
    }
    // SVG 文件
    else if (filePath.endsWith('.svg')) {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=31536000'); // 1年缓存
    }
  }
}));
```

### CORS 配置

```javascript
// CORS 配置（开发环境）
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:8100',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
```

**说明：**
- ✅ 静态文件服务**不需要 CORS**（GET 请求默认允许）
- ✅ 图片文件设置了缓存头（1年）
- ✅ 支持所有图片格式（PNG, JPG, WEBP, SVG 等）

---

## 前端访问方式

### 1. 直接通过 URL 访问

```javascript
// 示例：访问 Amazon Logo
const logoUrl = 'http://your-backend-domain.com/assets/websites/amazon.png';

// 在 React/Vue 中使用
<img src={logoUrl} alt="Amazon" />
```

### 2. 使用 API 返回的路径

```javascript
// API 返回的格式
{
  "icon": "/assets/websites/amazon.png",  // 相对路径
  "metadata": {
    "logoUrl": "/assets/websites/amazon.png"
  }
}

// 前端使用（需要拼接 base URL）
const baseUrl = 'http://your-backend-domain.com';
<img src={`${baseUrl}${award.icon}`} alt={award.title} />
```

### 3. 完整示例

```jsx
// React 示例
function AwardCard({ award }) {
  const baseUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
  
  return (
    <div>
      {/* 使用 icon 字段 */}
      <img 
        src={`${baseUrl}${award.icon}`} 
        alt={award.title}
        style={{ width: '24px', height: '24px' }}
      />
      
      {/* 使用 metadata.logoUrl */}
      <img 
        src={`${baseUrl}${award.metadata.logoUrl}`} 
        alt={award.title}
        style={{ width: '100px', height: '100px' }}
      />
    </div>
  );
}
```

---

## 访问 URL 格式

### 开发环境

```
http://localhost:8080/assets/websites/amazon.png
http://localhost:8080/assets/websites/airbnb.webp
http://localhost:8080/assets/websites/booking.svg
http://localhost:8080/assets/websites/luma.png
```

### 生产环境

```
https://api.datadance.ai/assets/websites/amazon.png
https://api.datadance.ai/assets/websites/airbnb.webp
https://api.datadance.ai/assets/websites/booking.svg
https://api.datadance.ai/assets/websites/luma.png
```

---

## 跨域访问

### 静态文件（GET 请求）

**✅ 无需特殊配置**

静态文件的 GET 请求默认允许跨域访问，浏览器可以直接请求：

```html
<!-- 前端可以直接使用 -->
<img src="http://backend-domain.com/assets/websites/amazon.png" />
```

### API 请求（需要 CORS）

如果前端需要调用 API（如 `GET /api/awards`），需要确保：
1. CORS 配置正确
2. 前端域名在允许列表中

---

## 测试访问

### 1. 浏览器直接访问

在浏览器地址栏输入：
```
http://localhost:8080/assets/websites/amazon.png
```

应该能看到图片。

### 2. 使用 curl 测试

```bash
# 测试 PNG 图片
curl -I http://localhost:8080/assets/websites/amazon.png

# 应该返回：
# HTTP/1.1 200 OK
# Content-Type: image/png
# Cache-Control: public, max-age=31536000
```

### 3. 前端代码测试

```javascript
// 测试图片是否可以加载
const testImage = new Image();
testImage.onload = () => console.log('图片加载成功');
testImage.onerror = () => console.error('图片加载失败');
testImage.src = 'http://localhost:8080/assets/websites/amazon.png';
```

---

## 常见问题

### Q1: 前端无法加载图片？

**可能原因：**
- 后端服务未启动
- 文件路径错误
- 文件不存在

**解决方法：**
1. 检查后端服务是否运行
2. 检查文件是否存在于 `public/assets/websites/` 目录
3. 在浏览器直接访问 URL 测试

### Q2: 跨域问题？

**说明：**
- 静态文件的 GET 请求**不需要 CORS**
- 如果遇到跨域问题，可能是浏览器安全策略

**解决方法：**
- 确保使用 HTTP/HTTPS 协议
- 检查浏览器控制台错误信息

### Q3: 图片缓存问题？

**说明：**
- 图片设置了 1 年缓存
- 更新图片后可能需要清除缓存

**解决方法：**
- 使用版本号：`/assets/websites/amazon.png?v=2`
- 清除浏览器缓存
- 使用硬刷新（Ctrl+Shift+R）

---

## 总结

✅ **前端可以访问**：静态文件服务已配置，前端可以直接请求  
✅ **无需 CORS**：GET 请求默认允许跨域  
✅ **支持缓存**：图片设置了长期缓存，提高性能  
✅ **多格式支持**：支持 PNG, JPG, WEBP, SVG 等格式

---

**最后更新：** 2025-01-06
