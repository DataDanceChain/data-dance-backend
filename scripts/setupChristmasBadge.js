const prisma = require('../src/utils/prisma');
const path = require('path');
const fs = require('fs');

/**
 * 检查并创建 DDC 组织用户（如果不存在）
 */
async function ensureDDCOrganization() {
  const DDC_EMAIL = 'ddc@datadance.org';
  const DDC_NAME = 'DataDance';
  
  let ddcOrg = await prisma.user.findFirst({
    where: {
      email: DDC_EMAIL,
      isOrganization: true
    }
  });
  
  if (!ddcOrg) {
    console.log('Creating DDC organization user...');
    const bcrypt = require('bcryptjs');
    const { generateReferralCode } = require('../src/utils/referralUtils');
    const hashedPassword = await bcrypt.hash('DDC@2025', 10);
    
    ddcOrg = await prisma.user.create({
      data: {
        email: DDC_EMAIL,
        name: DDC_NAME,
        password: hashedPassword,
        isOrganization: true,
        description: 'Official DataDance organization',
        referralCode: generateReferralCode()
      }
    });
    
    // Assign USER role
    const userRole = await prisma.role.findFirst({
      where: { name: 'USER' }
    });
    
    if (userRole) {
      await prisma.userRole.create({
        data: {
          userId: ddcOrg.id,
          roleId: userRole.id
        }
      });
    }
    
    console.log(`✅ Created DDC organization: ${DDC_NAME}`);
  } else {
    console.log(`✅ DDC organization already exists: ${DDC_NAME}`);
  }
  
  return ddcOrg;
}

/**
 * 检查并创建 Christmas Badge
 */
async function ensureChristmasBadge(creatorId) {
  const BADGE_ID = 'christmas-badge-2025';
  const BADGE_NAME = 'Exclusive DDC Christmas Badge';
  const BADGE_DESCRIPTION = 'Complete Christmas tasks to earn this exclusive badge and 5 Points';
  const BADGE_IMAGE = '/assets/badges/ddc-2025-christmas.png';
  
  // 检查图片文件是否存在
  const imagePath = path.join(__dirname, '../public/assets/badges/ddc-2025-christmas.png');
  if (!fs.existsSync(imagePath)) {
    console.warn(`⚠️  Warning: Badge image not found at ${imagePath}`);
    console.warn('   Please ensure the image file exists before running this script.');
  }
  
  let badge = await prisma.badge.findUnique({
    where: { id: BADGE_ID }
  });
  
  if (!badge) {
    console.log('Creating Christmas Badge...');
    badge = await prisma.badge.create({
      data: {
        id: BADGE_ID,
        name: BADGE_NAME,
        description: BADGE_DESCRIPTION,
        image: BADGE_IMAGE,
        creatorId: creatorId
      }
    });
    console.log(`✅ Created Christmas Badge: ${BADGE_NAME}`);
  } else {
    // 更新 badge 信息（如果需要）
    badge = await prisma.badge.update({
      where: { id: BADGE_ID },
      data: {
        name: BADGE_NAME,
        description: BADGE_DESCRIPTION,
        image: BADGE_IMAGE
      }
    });
    console.log(`✅ Christmas Badge already exists, updated: ${BADGE_NAME}`);
  }
  
  return badge;
}

/**
 * 检查并创建 Christmas Shopping Award
 */
async function ensureChristmasShoppingAward() {
  const AWARD_ID = 'christmas-shopping';
  const AWARD_TITLE = 'Christmas Shopping';
  const AWARD_DESCRIPTION = 'Complete Christmas shopping tasks to unlock exclusive rewards';
  
  let award = await prisma.award.findUnique({
    where: { id: AWARD_ID }
  });
  
  if (!award) {
    console.log('Creating Christmas Shopping Award...');
    award = await prisma.award.create({
      data: {
        id: AWARD_ID,
        title: AWARD_TITLE,
        description: AWARD_DESCRIPTION,
        status: 'LIVE',
        metadata: {}
      }
    });
    console.log(`✅ Created Christmas Shopping Award: ${AWARD_TITLE}`);
  } else {
    console.log(`✅ Christmas Shopping Award already exists: ${AWARD_TITLE}`);
  }
  
  return award;
}

/**
 * 检查并创建 Christmas Shopping 任务
 */
async function ensureChristmasTasks(awardId) {
  const tasks = [
    {
      id: 'upload-3-orders',
      title: 'Upload 3+ December Orders',
      description: 'Upload at least 3 Amazon orders from December 2025',
      points: 0,
      requirementCount: 3,
      claimLimit: 1,
      status: 'LIVE',
      metadata: {}
    },
    {
      id: 'follow-x',
      title: 'Follow X (Twitter)',
      description: 'Follow the official DDC X account',
      points: 0,
      requirementCount: 1,
      claimLimit: 1,
      status: 'LIVE',
      metadata: {}
    },
    {
      id: 'join-telegram',
      title: 'Join Telegram',
      description: 'Join the official DDC Telegram group',
      points: 0,
      requirementCount: 1,
      claimLimit: 1,
      status: 'LIVE',
      metadata: {}
    }
  ];
  
  const createdTasks = [];
  
  for (const taskData of tasks) {
    let task = await prisma.task.findUnique({
      where: { id: taskData.id }
    });
    
    if (!task) {
      console.log(`Creating task: ${taskData.title}...`);
      task = await prisma.task.create({
        data: {
          ...taskData,
          awardId: awardId
        }
      });
      console.log(`✅ Created task: ${taskData.title} (${taskData.id})`);
    } else {
      // 更新任务信息（如果需要）
      task = await prisma.task.update({
        where: { id: taskData.id },
        data: {
          title: taskData.title,
          description: taskData.description,
          points: taskData.points,
          requirementCount: taskData.requirementCount,
          claimLimit: taskData.claimLimit,
          status: taskData.status,
          metadata: taskData.metadata,
          awardId: awardId
        }
      });
      console.log(`✅ Task already exists, updated: ${taskData.title} (${taskData.id})`);
    }
    
    createdTasks.push(task);
  }
  
  return createdTasks;
}

/**
 * 运行 createAwards.js 来创建所有其他任务（从 awards.json）
 */
async function createAllAwards() {
  console.log('Creating all awards and tasks from awards.json...');
  const { postIds, common, awards } = require('../config/awards.json');
  
  // Upsert each award definition
  for (const award of awards) {
    await prisma.award.upsert({
      where: { id: award.id },
      update: {
        title: award.title,
        description: award.description,
        icon: award.icon,
        color: award.color,
        status: award.status
      },
      create: {
        id: award.id,
        title: award.title,
        description: award.description,
        icon: award.icon,
        color: award.color,
        status: award.status
      }
    });
  }
  
  console.log('✅ Award definitions seeded.');
  
  // Upsert task definitions per award using config tasks
  for (const award of awards) {
    const defs = award.tasks || [];
    for (const t of defs) {
      // build dynamic fields
      const description = t.description;
      const metadata = t.postKey
        ? { type: common.metadataType, targetPostId: postIds[t.postKey] }
        : (t.metadata || null);
      await prisma.task.upsert({
        where: { id: t.id },
        update: {
          title: t.title,
          description: t.description,
          points: t.points,
          status: award.status,
          claimLimit: t.claimLimit,
          requirementCount: t.requirementCount || null,
          prerequisiteTaskId: t.prerequisiteTaskId || null,
          metadata
        },
        create: {
          id: t.id,
          awardId: award.id,
          title: t.title,
          description,
          points: t.points,
          status: award.status,
          claimLimit: t.claimLimit,
          requirementCount: t.requirementCount || null,
          prerequisiteTaskId: t.prerequisiteTaskId || null,
          metadata
        }
      });
    }
  }
  
  console.log('✅ Task definitions seeded.');
}

/**
 * 主函数
 */
async function main() {
  try {
    console.log('🎄 Setting up Christmas Badge and Tasks...\n');
    
    // 0. 首先创建所有其他 awards 和 tasks（从 awards.json）
    await createAllAwards();
    console.log('');
    
    // 1. 确保 DDC 组织存在
    const ddcOrg = await ensureDDCOrganization();
    console.log('');
    
    // 2. 确保 Christmas Badge 存在
    const badge = await ensureChristmasBadge(ddcOrg.id);
    console.log('');
    
    // 3. 确保 Christmas Shopping Award 存在
    const award = await ensureChristmasShoppingAward();
    console.log('');
    
    // 4. 确保所有任务存在
    const tasks = await ensureChristmasTasks(award.id);
    console.log('');
    
    console.log('✅ Setup completed successfully!\n');
    console.log('Summary:');
    console.log(`  - Badge: ${badge.name} (${badge.id})`);
    console.log(`  - Award: ${award.title} (${award.id})`);
    console.log(`  - Tasks: ${tasks.length} tasks created/updated`);
    tasks.forEach(task => {
      console.log(`    • ${task.title} (${task.id})`);
    });
    
  } catch (error) {
    console.error('❌ Error setting up Christmas Badge:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// 运行脚本
main()
  .then(() => {
    console.log('\n✨ Script completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 Script failed:', error);
    process.exit(1);
  });


