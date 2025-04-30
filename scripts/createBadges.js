const prisma = require('../src/utils/prisma');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

/**
 * 确保角色存在
 */
async function ensureRolesExist() {
  console.log("Ensuring required roles exist...");
  
  // 简化角色定义
  const requiredRoles = [
    { name: "ADMIN", description: "System administrator" },
    { name: "USER", description: "Regular user" }
  ];
  
  // 创建角色（如果不存在）
  for (const roleData of requiredRoles) {
    const existingRole = await prisma.role.findFirst({
      where: { name: roleData.name }
    });
    
    if (!existingRole) {
      await prisma.role.create({
        data: roleData
      });
      console.log(`Created role: ${roleData.name}`);
    } else {
      console.log(`Role already exists: ${roleData.name}`);
    }
  }
  
  console.log("Role check completed");
}

/**
 * 根据徽章图片名称生成组织名称
 */
function generateOrganizationName(logoFileName) {
  // 移除文件扩展名
  const baseName = path.basename(logoFileName, path.extname(logoFileName));
  
  // 将连字符替换为空格，并将每个单词的首字母大写
  return baseName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * 创建组织用户和徽章
 */
async function createOrganizationAndBadge(logoFileName) {
  try {
    // 生成组织名称
    const organizationName = generateOrganizationName(logoFileName);
    
    // 生成唯一的电子邮件地址
    const orgEmail = `${organizationName.toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')}@organization.com`;
    
    // 查找组织用户，如果不存在则创建
    let orgUser = await prisma.user.findFirst({
      where: { 
        email: orgEmail,
        isOrganization: true
      }
    });
    
    if (!orgUser) {
      console.log(`Creating organization user: ${organizationName}`);
      const hashedPassword = await bcrypt.hash("Org@123", 10);
      
      // 创建组织用户
      orgUser = await prisma.user.create({
        data: {
          email: orgEmail,
          name: organizationName,
          password: hashedPassword,
          isOrganization: true,
          description: `Official organization for ${organizationName}`,
          logo: `/assets/logos/${logoFileName}`,
          avatar: `/assets/logos/${logoFileName}`
        }
      });
      
      // 创建用户角色关联
      try {
        // 查找 USER 角色
        const userRole = await prisma.role.findFirst({
          where: { name: "USER" }
        });
        
        if (userRole) {
          // 创建用户角色关联
          await prisma.userRole.create({
            data: {
              user: { connect: { id: orgUser.id } },
              role: { connect: { id: userRole.id } }
            }
          });
          console.log(`Assigned USER role to organization user: ${orgUser.email}`);
        } else {
          console.log("Warning: USER role not found");
        }
      } catch (roleError) {
        console.error("Error assigning role to user:", roleError);
        // 继续执行，不中断脚本
      }
      
      console.log(`Created organization user: ${organizationName}`);
    }
    
    // 检查徽章是否已存在
    const existingBadge = await prisma.badge.findFirst({
      where: {
        name: `${organizationName} Badge`,
        creatorId: orgUser.id
      }
    });
    
    if (existingBadge) {
      console.log(`Badge for ${organizationName} already exists, skipping...`);
      return { created: false };
    }
    
    // 创建徽章
    const badge = await prisma.badge.create({
      data: {
        name: `${organizationName} Badge`,
        description: `Official badge for ${organizationName}`,
        image: `/assets/logos/${logoFileName}`,
        creator: {
          connect: { id: orgUser.id }
        }
      }
    });
    
    console.log(`Created badge for ${organizationName}`);
    return { created: true, badge };
    
  } catch (error) {
    console.error(`Error processing ${logoFileName}:`, error);
    return { created: false, error };
  }
}

/**
 * 创建所有徽章
 */
async function createAllBadges() {
  try {
    // 确保角色存在
    await ensureRolesExist();
    
    // 读取徽章图片目录
    const logosDir = path.join(__dirname, '../public/assets/logos');
    const badgesDir = path.join(__dirname, '../public/assets/badges');
    
    // 确保徽章目录存在
    if (!fs.existsSync(badgesDir)) {
      fs.mkdirSync(badgesDir, { recursive: true });
    }
    
    // 获取所有徽章图片
    const logoFiles = fs.readdirSync(logosDir);
    
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    // 复制徽章图片并创建徽章记录
    for (const logoFile of logoFiles) {
      // 复制徽章图片
      const sourcePath = path.join(logosDir, logoFile);
      const destPath = path.join(badgesDir, logoFile);
      
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(sourcePath, destPath);
      }
      
      // 创建组织和徽章
      const result = await createOrganizationAndBadge(logoFile);
      
      if (result.error) {
        errorCount++;
      } else if (result.created) {
        createdCount++;
      } else {
        skippedCount++;
      }
    }
    
    console.log(`\nBadge creation complete!`);
    console.log(`Created: ${createdCount} badges with their organizations`);
    console.log(`Skipped: ${skippedCount} badges (already exist)`);
    console.log(`Errors: ${errorCount} badges`);
    console.log(`Total logos processed: ${logoFiles.length}`);
    
  } catch (error) {
    console.error('Error creating badges:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行脚本
createAllBadges()
  .then(() => console.log('Script completed successfully'))
  .catch(error => console.error('Script failed:', error)); 