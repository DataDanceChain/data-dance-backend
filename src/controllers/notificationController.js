const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * 获取用户通知
 * @route GET /api/notifications
 * @access Private
 */
exports.getNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    // 获取通知
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit)
    });

    // 获取总数
    const total = await prisma.notification.count({
      where: { userId: req.user.id }
    });

    // 获取未读通知数量
    const unreadCount = await prisma.notification.count({
      where: {
        userId: req.user.id,
        isRead: false
      }
    });

    res.status(200).json({
      status: 'success',
      data: {
        notifications,
        unreadCount,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 标记通知为已读
 * @route PUT /api/notifications/:id/read
 * @access Private
 */
exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;

    // 检查通知是否存在且属于当前用户
    const notification = await prisma.notification.findFirst({
      where: {
        id,
        userId: req.user.id
      }
    });

    if (!notification) {
      return res.status(404).json({
        status: 'fail',
        message: '通知不存在'
      });
    }

    // 标记为已读
    await prisma.notification.update({
      where: { id },
      data: { isRead: true }
    });

    res.status(200).json({
      status: 'success',
      message: '通知已标记为已读'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 标记所有通知为已读
 * @route PUT /api/notifications/read-all
 * @access Private
 */
exports.markAllAsRead = async (req, res) => {
  try {
    // 更新所有未读通知
    await prisma.notification.updateMany({
      where: {
        userId: req.user.id,
        isRead: false
      },
      data: {
        isRead: true
      }
    });

    res.status(200).json({
      status: 'success',
      message: '所有通知已标记为已读'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 更新通知偏好设置
 * @route PUT /api/notifications/preferences
 * @access Private
 */
exports.updatePreferences = async (req, res) => {
  try {
    const { preferences } = req.body;

    // 更新用户通知偏好
    await prisma.userProfile.update({
      where: { userId: req.user.id },
      data: {
        notificationPrefs: preferences
      }
    });

    res.status(200).json({
      status: 'success',
      message: '通知偏好设置已更新'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '服务器错误',
      error: error.message
    });
  }
}; 