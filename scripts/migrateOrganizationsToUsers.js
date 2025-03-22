const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function migrateOrganizationsToUsers() {
  try {
    console.log('Starting migration of organizations to users...');
    
    // 获取所有组织
    const organizations = await prisma.organization.findMany({
      include: {
        users: true,
        activities: true,
        dataAssets: true,
        badges: true
      }
    });
    
    console.log(`Found ${organizations.length} organizations to migrate`);
    
    // 为每个组织创建对应的用户
    for (const org of organizations) {
      console.log(`Migrating organization: ${org.name}`);
      
      // 生成唯一的电子邮件
      const email = `${org.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}@organization.com`;
      
      // 检查是否已存在同名用户
      const existingUser = await prisma.user.findFirst({
        where: { email }
      });
      
      if (existingUser) {
        console.log(`User with email ${email} already exists, skipping...`);
        continue;
      }
      
      // 创建随机密码
      const password = Math.random().toString(36).slice(-10);
      const hashedPassword = await bcrypt.hash(password, 10);
      
      // 创建组织用户
      const orgUser = await prisma.user.create({
        data: {
          email,
          name: org.name,
          password: hashedPassword,
          isOrganization: true,
          description: org.description,
          logo: org.logo,
          avatar: org.logo
        }
      });
      
      console.log(`Created organization user: ${orgUser.name} (${orgUser.id})`);
      
      // 更新组织成员关系
      for (const member of org.users) {
        await prisma.user.update({
          where: { id: member.id },
          data: {
            organization: {
              connect: { id: orgUser.id }
            }
          }
        });
      }
      
      // 更新活动创建者
      for (const activity of org.activities) {
        await prisma.activity.update({
          where: { id: activity.id },
          data: {
            creator: {
              connect: { id: orgUser.id }
            }
          }
        });
      }
      
      // 更新数据资产所有者
      for (const asset of org.dataAssets) {
        await prisma.nFTDataAsset.update({
          where: { id: asset.id },
          data: {
            owner: {
              connect: { id: orgUser.id }
            }
          }
        });
      }
      
      // 更新徽章创建者
      for (const badge of org.badges) {
        await prisma.badge.update({
          where: { id: badge.id },
          data: {
            creator: {
              connect: { id: orgUser.id }
            }
          }
        });
      }
      
      console.log(`Migration completed for organization: ${org.name}`);
    }
    
    console.log('Organization migration completed successfully');
    
  } catch (error) {
    console.error('Error during migration:', error);
  } finally {
    await prisma.$disconnect();
  }
}

migrateOrganizationsToUsers()
  .then(() => console.log('Migration script completed'))
  .catch(error => console.error('Migration script failed:', error)); 