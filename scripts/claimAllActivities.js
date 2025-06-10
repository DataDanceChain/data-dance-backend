const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function claimAllActivities() {
  try {
    // 1. 获取测试用户
    const testUser = await prisma.user.findUnique({
      where: {
        email: 'test@example.com'
      }
    });

    if (!testUser) {
      console.error('Test user not found');
      return;
    }

    // 2. 获取所有可用的活动
    const activities = await prisma.activity.findMany({
      where: {
        endDate: {
          gt: new Date() // 只获取未结束的活动
        }
      }
    });

    console.log(`Found ${activities.length} available activities`);

    // 3. 为每个活动创建领取记录
    for (const activity of activities) {
      try {
        // 检查是否已经领取过
        const existingClaim = await prisma.activityClaim.findUnique({
          where: {
            userId_activityId: {
              userId: testUser.id,
              activityId: activity.id
            }
          }
        });

        if (existingClaim) {
          console.log(`Activity ${activity.title} already claimed`);
          continue;
        }

        // 创建新的领取记录
        const claim = await prisma.activityClaim.create({
          data: {
            userId: testUser.id,
            activityId: activity.id,
            status: 'CLAIMED'
          }
        });

        console.log(`Successfully claimed activity: ${activity.title}`);
      } catch (error) {
        console.error(`Error claiming activity ${activity.title}:`, error.message);
      }
    }

    console.log('Finished claiming all activities');
  } catch (error) {
    console.error('Error in claimAllActivities:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行脚本
claimAllActivities(); 