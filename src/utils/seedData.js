const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function seedData() {
  try {
    console.log('开始填充测试数据...');

    // 创建测试组织
    const organization = await prisma.organization.create({
      data: {
        name: '测试商家',
        description: '这是一个测试商家',
        logo: 'https://via.placeholder.com/150'
      }
    });

    console.log('已创建测试组织');

    // 创建测试用户
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('password123', salt);

    const user = await prisma.user.create({
      data: {
        email: 'test@example.com',
        password: hashedPassword,
        name: '测试用户',
        profile: {
          create: {
            language: 'zh'
          }
        }
      }
    });

    console.log('已创建测试用户');

    // 创建测试勋章
    const badge = await prisma.badge.create({
      data: {
        name: '新手勋章',
        description: '完成注册获得的勋章',
        image: 'https://via.placeholder.com/100',
        organization: {
          connect: { id: organization.id }
        }
      }
    });

    console.log('已创建测试勋章');

    // 给用户添加勋章
    await prisma.userBadge.create({
      data: {
        user: {
          connect: { id: user.id }
        },
        badge: {
          connect: { id: badge.id }
        }
      }
    });

    console.log('已给用户添加勋章');

    // 给用户添加积分
    await prisma.point.create({
      data: {
        user: {
          connect: { id: user.id }
        },
        amount: 100,
        source: 'REGISTRATION'
      }
    });

    console.log('已给用户添加积分');

    // 创建活动分类
    const category = await prisma.activityCategory.create({
      data: {
        name: '新手活动'
      }
    });

    console.log('已创建活动分类');

    // 创建活动标签
    const tag = await prisma.activityTag.create({
      data: {
        name: '限时'
      }
    });

    console.log('已创建活动标签');

    // 创建测试活动
    const activity = await prisma.activity.create({
      data: {
        title: '新手欢迎活动',
        description: '参与即可获得积分奖励',
        startDate: new Date(),
        endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7天后结束
        image: 'https://via.placeholder.com/300',
        creator: {
          connect: { id: organization.id }
        },
        categories: {
          connect: { id: category.id }
        },
        tags: {
          connect: { id: tag.id }
        },
        budget: 1000,
        shareLink: 'https://example.com/activity/1'
      }
    });

    console.log('已创建测试活动');

    // 创建测试通知
    await prisma.notification.create({
      data: {
        user: {
          connect: { id: user.id }
        },
        title: '欢迎使用 DataDance',
        content: '感谢您注册 DataDance，开始探索更多精彩活动吧！',
        type: 'SYSTEM'
      }
    });

    console.log('已创建测试通知');

    console.log('测试数据填充完成！');
  } catch (error) {
    console.error('填充测试数据失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seedData(); 