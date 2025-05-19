const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function createTestUser() {
  try {
    // 检查测试账号是否已存在
    const existingUser = await prisma.user.findUnique({
      where: { email: 'test@example.com' }
    });

    if (existingUser) {
      console.log('测试账号已存在，跳过创建');
      return;
    }

    // 加密密码
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('password123', salt);

    // 创建测试账号
    const testUser = await prisma.user.create({
      data: {
        email: 'test@example.com',
        password: hashedPassword,
        name: 'Test User',
        isOrganization: false,
        userType: 'regular',
        authType: 'traditional',
        profile: {
          create: {
            language: 'zh'
          }
        }
      },
      include: {
        profile: true
      }
    });

    console.log('测试账号创建成功:', {
      id: testUser.id,
      email: testUser.email,
      name: testUser.name,
      userType: testUser.userType,
      authType: testUser.authType
    });
  } catch (error) {
    console.error('创建测试账号时出错:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 执行创建测试账号
createTestUser();