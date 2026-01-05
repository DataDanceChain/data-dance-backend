# Awards Icon API - 更新说明

## 概述

Awards 的 `icon` 字段已更新为**图片路径**格式，前端可以直接使用 `<img>` 标签显示图标，无需使用图标库。

---

## 更新内容

### 之前（图标名称）

```json
{
  "icon": "businessOutline"  // 图标库名称
}
```

**前端使用方式：**
```jsx
// 需要使用图标库
<IonIcon name={award.icon} />
```

### 现在（图片路径）

```json
{
  "icon": "/assets/icons/business-outline.svg"  // 图片路径
}
```

**前端使用方式：**
```jsx
// 直接使用图片
<img src={award.icon} alt={award.title} />
```

---

## API 接口更新

### 1. GET /api/awards

**端点:** `GET /api/awards`

**响应格式:**

```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "id": "amazon-data-collection",
        "title": "Amazon Data Collection",
        "description": "Share Your Amazon order to earn rewards",
        "icon": "/assets/icons/business-outline.svg",
        "color": "#FF9500",
        "status": "LIVE",
        "metadata": {
          "source": "amazon",
          "type": "data-collection",
          "category": "data-sharing",
          "logoUrl": "/assets/websites/amazon.png",
          "actionUrl": "/user/crawl-tasks",
          "buttonText": "Submit Data"
        }
      },
      {
        "id": "airbnb-data-collection",
        "title": "Airbnb Data Collection",
        "description": "Share Your Airbnb trips to earn rewards",
        "icon": "/assets/icons/business-outline.svg",
        "color": "#FF5A5F",
        "status": "LIVE",
        "metadata": {
          "source": "airbnb",
          "type": "data-collection",
          "category": "data-sharing",
          "logoUrl": "/assets/websites/airbnb.png",
          "actionUrl": "/user/crawl-tasks",
          "buttonText": "Submit Data"
        }
      },
      {
        "id": "booking-data-collection",
        "title": "Booking Data Collection",
        "description": "Share Your Booking.com trips to earn rewards",
        "icon": "/assets/icons/business-outline.svg",
        "color": "#003580",
        "status": "LIVE",
        "metadata": {
          "source": "booking",
          "type": "data-collection",
          "category": "data-sharing",
          "logoUrl": "/assets/websites/booking.png",
          "actionUrl": "/user/crawl-tasks",
          "buttonText": "Submit Data"
        }
      },
      {
        "id": "referral-rewards",
        "title": "Referral Rewards",
        "description": "Earn rewards from your referral network activities",
        "icon": "/assets/icons/people-outline.svg",
        "color": "#FF6B6B",
        "status": "LIVE",
        "metadata": {}
      }
    ]
  }
}
```

---

### 2. GET /api/users/awards

**端点:** `GET /api/users/awards`

**认证:** 需要登录（Bearer Token）

**响应格式:**

```json
{
  "status": "success",
  "data": {
    "awards": [
      {
        "awardId": "amazon-data-collection",
        "title": "Amazon Data Collection",
        "description": "Share Your Amazon order to earn rewards",
        "icon": "/assets/icons/business-outline.svg",
        "color": "#FF9500",
        "metadata": {
          "source": "amazon",
          "type": "data-collection",
          "category": "data-sharing",
          "logoUrl": "/assets/websites/amazon.png",
          "actionUrl": "/user/crawl-tasks",
          "buttonText": "Submit Data"
        },
        "totalTasks": 1,
        "claimedTasks": 0,
        "progress": 0.5,
        "finalStatus": "IN_PROGRESS",
        "tasks": [
          {
            "taskId": "amazon-order-submit",
            "title": "Submit Amazon Order Data",
            "description": "Share Your Amazon order to earn rewards",
            "points": 100,
            "progress": 0.5,
            "finalStatus": "IN_PROGRESS",
            "claimed": false,
            "claimLimit": null
          }
        ]
      },
      {
        "awardId": "referral-rewards",
        "title": "Referral Rewards",
        "description": "Earn rewards from your referral network activities",
        "icon": "/assets/icons/people-outline.svg",
        "color": "#FF6B6B",
        "totalTasks": 4,
        "claimedTasks": 2,
        "progress": 0.5,
        "finalStatus": "IN_PROGRESS",
        "tasks": [...]
      }
    ],
    "referralOverview": {
      "totalReferrals": 10,
      "level1Count": 5,
      "level2Count": 3,
      "level3Count": 2,
      "level4Count": 0
    }
  }
}
```

---

## 图标路径映射

### 图标名称到路径的映射

| 图标名称 | 图片路径 |
|---------|---------|
| `businessOutline` | `/assets/icons/business-outline.svg` |
| `peopleOutline` | `/assets/icons/people-outline.svg` |
| `shareOutline` | `/assets/icons/share-outline.svg` |
| `calendarOutline` | `/assets/icons/calendar-outline.svg` |
| `diamondOutline` | `/assets/icons/diamond-outline.svg` |
| `starOutline` | `/assets/icons/star-outline.svg` |
| `cardOutline` | `/assets/icons/card-outline.svg` |
| `trophyOutline` | `/assets/icons/trophy-outline.svg` |
| `bulbOutline` | `/assets/icons/bulb-outline.svg` |
| `schoolOutline` | `/assets/icons/school-outline.svg` |
| `earthOutline` | `/assets/icons/earth-outline.svg` |

### 自定义路径支持

如果 `icon` 字段已经是路径格式（以 `/` 开头），则直接返回，不进行转换。

---

## 静态文件服务

### 图标文件位置

图标文件应放置在：

```
public/assets/icons/
  ├── business-outline.svg
  ├── people-outline.svg
  ├── share-outline.svg
  ├── calendar-outline.svg
  ├── diamond-outline.svg
  ├── star-outline.svg
  ├── card-outline.svg
  ├── trophy-outline.svg
  ├── bulb-outline.svg
  ├── school-outline.svg
  └── earth-outline.svg
```

### 访问路径

所有图标可以通过以下路径访问：

```
http://localhost:8080/assets/icons/{icon-name}.svg
```

**示例:**
- `http://localhost:8080/assets/icons/business-outline.svg`
- `http://localhost:8080/assets/icons/people-outline.svg`

### MIME 类型和缓存

- **MIME 类型**: `image/svg+xml`
- **缓存**: `Cache-Control: public, max-age=31536000` (1年)

---

## 前端集成

### React 示例

```jsx
function AwardCard({ award }) {
  return (
    <div className="award-card">
      {/* 直接使用图片路径 */}
      <img 
        src={award.icon} 
        alt={award.title}
        className="award-icon"
        onError={(e) => {
          // 如果图标不存在，使用默认图标
          e.target.src = '/assets/icons/default-icon.svg';
        }}
      />
      <h3>{award.title}</h3>
      <p>{award.description}</p>
    </div>
  );
}
```

### 使用完整 URL（可选）

```jsx
const API_BASE_URL = 'http://localhost:8080';

function AwardCard({ award }) {
  const iconUrl = award.icon.startsWith('http') 
    ? award.icon 
    : `${API_BASE_URL}${award.icon}`;
  
  return (
    <img src={iconUrl} alt={award.title} />
  );
}
```

### Next.js Image 组件（如果使用 Next.js）

```jsx
import Image from 'next/image';

function AwardCard({ award }) {
  return (
    <Image
      src={award.icon}
      alt={award.title}
      width={48}
      height={48}
      unoptimized={true} // SVG 不需要优化
    />
  );
}
```

---

## 图标文件要求

### SVG 格式

- **格式**: SVG（推荐，矢量图，可无损缩放）
- **尺寸**: 建议 48x48px 或 64x64px
- **颜色**: 可以使用 `currentColor` 以便通过 CSS 控制颜色

### SVG 示例

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <path d="M24 4L6 10v18c0 11.11 7.67 21.47 18 24 10.33-2.53 18-12.89 18-24V10l-18-6z" 
        fill="currentColor"/>
</svg>
```

### 其他格式支持

虽然主要支持 SVG，但也可以使用其他图片格式：

- PNG: `/assets/icons/icon-name.png`
- JPG: `/assets/icons/icon-name.jpg`
- WebP: `/assets/icons/icon-name.webp`

---

## 向后兼容

### 自动转换

- ✅ 旧的图标名称（如 `businessOutline`）会自动转换为路径
- ✅ 如果已经是路径格式，则直接返回
- ✅ 如果图标不存在，返回路径但前端需要处理 404

### 迁移建议

1. **前端**: 将图标库使用改为 `<img>` 标签
2. **图标文件**: 确保所有图标文件已放置在 `public/assets/icons/` 目录
3. **测试**: 验证所有图标路径都能正常访问

---

## 错误处理

### 图标不存在

如果图标文件不存在，浏览器会显示 404。前端应该处理这种情况：

```jsx
function AwardIcon({ icon, title }) {
  const [imgSrc, setImgSrc] = useState(icon);
  
  const handleError = () => {
    // 使用默认图标
    setImgSrc('/assets/icons/default-icon.svg');
  };
  
  return (
    <img 
      src={imgSrc} 
      alt={title}
      onError={handleError}
    />
  );
}
```

---

## 总结

### ✅ 更新内容

1. **Icon 字段格式**: 从图标名称改为图片路径
2. **静态文件服务**: 支持 SVG 图标文件
3. **自动转换**: 图标名称自动转换为路径
4. **向后兼容**: 支持路径格式和名称格式

### 📋 前端需要做的

1. ✅ 将图标库使用改为 `<img>` 标签
2. ✅ 处理图标加载错误（404）
3. ✅ 确保图标文件已部署到服务器

### 🔧 后端已完成的

1. ✅ 图标名称到路径的自动转换
2. ✅ 静态文件服务支持 SVG
3. ✅ 正确的 MIME 类型和缓存头

---

## 相关文件

- `src/services/awardService.js` - Award 服务（图标转换逻辑）
- `src/app.js` - 静态文件服务配置
- `public/assets/icons/` - 图标文件目录
