# Awards Logo 图片验证

## 文件位置

所有 awards 的 logo 图片存储在：
```
public/assets/websites/
```

## 实际文件列表

- ✅ `amazon.png` - Amazon 数据收集奖励
- ✅ `airbnb.webp` - Airbnb 数据收集奖励
- ✅ `booking.svg` - Booking.com 数据收集奖励
- ✅ `luma.png` - Luma 数据收集奖励

## 配置文件

`config/awards.json` 中的 `metadata.logoUrl` 路径：

```json
{
  "amazon-data-collection": {
    "metadata": {
      "logoUrl": "/assets/websites/amazon.png"
    }
  },
  "airbnb-data-collection": {
    "metadata": {
      "logoUrl": "/assets/websites/airbnb.webp"
    }
  },
  "booking-data-collection": {
    "metadata": {
      "logoUrl": "/assets/websites/booking.svg"
    }
  }
}
```

## 静态文件服务配置

在 `src/app.js` 中已配置：

```javascript
app.use('/assets', express.static(path.join(__dirname, '../public/assets'), {
  setHeaders: (res, filePath) => {
    // 图片文件（包括 .webp）
    if (filePath.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i)) {
      res.set('Cache-Control', 'public, max-age=31536000');
    }
    // SVG 文件
    else if (filePath.endsWith('.svg')) {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=31536000');
    }
  }
}));
```

## API 返回格式

### GET /api/awards

```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "id": "amazon-data-collection",
        "icon": "/assets/icons/business-outline.svg",
        "metadata": {
          "logoUrl": "/assets/websites/amazon.png"
        }
      },
      {
        "id": "airbnb-data-collection",
        "icon": "/assets/icons/business-outline.svg",
        "metadata": {
          "logoUrl": "/assets/websites/airbnb.webp"
        }
      },
      {
        "id": "booking-data-collection",
        "icon": "/assets/icons/business-outline.svg",
        "metadata": {
          "logoUrl": "/assets/websites/booking.svg"
        }
      }
    ]
  }
}
```

## 访问 URL

所有图片可以通过以下 URL 访问：

- `http://your-domain.com/assets/websites/amazon.png`
- `http://your-domain.com/assets/websites/airbnb.webp`
- `http://your-domain.com/assets/websites/booking.svg`
- `http://your-domain.com/assets/websites/luma.png`

## 验证步骤

1. ✅ 文件已放置在 `public/assets/websites/` 目录
2. ✅ 配置文件中的路径已更新为正确的文件扩展名
3. ✅ 静态文件服务已配置支持 `.webp` 和 `.svg`
4. ⏳ 需要运行 `node scripts/createAwards.js` 更新数据库中的 metadata

## 更新数据库

运行以下命令更新数据库中的 awards metadata：

```bash
node scripts/createAwards.js
```

这将从 `config/awards.json` 读取最新的配置（包括 logoUrl）并更新到数据库。

## 前端使用

前端可以直接使用 API 返回的 `metadata.logoUrl` 路径：

```jsx
<img src={award.metadata.logoUrl} alt={award.title} />
```

图片会通过后端的静态文件服务自动提供。
