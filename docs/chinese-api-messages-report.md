# Chinese Characters in API Response Messages Report

This report lists all instances of Chinese characters found in API response messages that are sent to users.

## Controllers

### 1. authController.js
- **Line 23**: `message: '该邮箱已被注册'`
- **Line 71**: `message: '服务器错误'`
- **Line 94**: `message: '邮箱或密码不正确'`
- **Line 102**: `message: '请使用 Web3Auth 登录'`
- **Line 110**: `message: '邮箱或密码不正确'`
- **Line 119**: `message: '邮箱或密码不正确'`
- **Line 139**: `message: '服务器错误'`

### 2. notificationController.js
- **Line 50**: `message: '服务器错误'`
- **Line 76**: `message: '通知不存在'`
- **Line 88**: `message: '通知已标记为已读'`
- **Line 93**: `message: '服务器错误'`
- **Line 119**: `message: '所有通知已标记为已读'`
- **Line 124**: `message: '服务器错误'`
- **Line 149**: `message: '通知偏好设置已更新'`
- **Line 154**: `message: '服务器错误'`

### 3. passController.js
- **Line 229**: `message: '缺少必要参数'`
- **Line 273**: `message: '未找到该创建者'`
- **Line 279**: `message: '未找到该创建者的认领记录'`
- **Line 883**: `message: '生成 Pass 失败'`
- **Line 924**: `message: '获取 Pass 列表失败'`
- **Line 950**: `message: 'Pass 不存在'`
- **Line 969**: `message: '获取 Pass 详情失败'`
- **Line 990**: `message: '无效的状态值'`
- **Line 1004**: `message: 'Pass 不存在'`
- **Line 1024**: `message: '更新 Pass 状态失败'`

### 4. passWebServiceController.js
- **Line 54**: `message: '处理日志请求失败'`
- **Line 195**: `message: '获取更新失败'`
- **Line 245**: `message: '发送 Pass 文件失败'`
- **Line 256**: `message: '获取 pass 失败'`
- **Line 303**: `message: '注销设备失败'`

### 5. userController.js
- **Line 22**: `message: '用户不存在'`
- **Line 52**: `message: '服务器错误'`
- **Line 85**: `message: '服务器错误'`
- **Line 107**: `message: '语言设置已更新'`
- **Line 112**: `message: '服务器错误'`
- **Line 138**: `message: '当前密码不正确'`
- **Line 146**: `message: '只有组织用户可以修改密码'`
- **Line 162**: `message: '密码已更新'`
- **Line 167**: `message: '服务器错误'`
- **Line 200**: `message: '获取用户积分失败'`
- **Line 219**: `message: '组织用户不能更新钱包地址'`
- **Line 227**: `message: '您已绑定钱包地址，不能再次更改'`
- **Line 235**: `message: '无效的钱包地址格式'`
- **Line 251**: `message: '该钱包地址已被其他用户绑定'`
- **Line 273**: `message: '钱包地址已绑定'`
- **Line 282**: `message: '服务器错误'`
- **Line 298**: `message: '此功能已被禁用，请使用 Web3Auth 或其他安全的钱包生成方式'`
- **Line 307**: `message: '组织用户不能生成钱包'`
- **Line 449**: `message: '服务器错误'`

### 6. xController.js
- **Line 115**: `message: '授权失败'`
- **Line 168**: `message: '获取状态失败'`

### 7. activityController.js
- **Line 1211**: `message: '缺少必填字段: ${missingFields.join(', ')}'`
- **Line 1293**: `message: '创建活动失败'`

## Middlewares

### 1. auth.js
- **Line 12**: `message: '未提供认证令牌'`
- **Line 21**: `message: '无效的认证令牌格式'`
- **Line 36**: `message: '用户不存在'`
- **Line 47**: `message: '无效的认证令牌'`
- **Line 53**: `message: '认证令牌已过期'`
- **Line 59**: `message: '服务器错误'`

### 2. authMiddleware.js
- **Line 20**: `message: '您未登录，请先登录'`
- **Line 35**: `message: '此 token 对应的用户不存在'`
- **Line 45**: `message: '未授权，请重新登录'`
- **Line 57**: `message: '未授权访问'`
- **Line 64**: `message: '只有组织用户可以访问此资源'`
- **Line 79**: `message: '没有权限访问此资源'`

### 3. validationMiddleware.js
- **Line 11**: `message: '请求数据验证失败'`

## Services

### 1. passService.js
- **Line 32**: `throw new Error('找不到序列号为 ${serialNumber} 的Pass')`
- **Line 56**: `throw new Error('找不到序列号为 ${serialNumber} 的Pass')`
- **Line 101**: `throw new Error('找不到序列号为 ${serialNumber} 的Pass')`

## Comments and Console Logs
There are also many Chinese characters in comments and console.log statements in passService.js, but these do not affect API responses sent to users.

## Recommendations
All the above Chinese text in API response messages should be translated to English to maintain consistency with the rest of the API and support international users. The crawlerController.js, referralController.js, and web3AuthController.js are already using English throughout, which is good.