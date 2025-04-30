require('dotenv').config({ path: '../.env' });
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../src/utils/prisma');

async function main() {
  // Define test users
  const usersData = [
    { email: 'sloan_test@sloantest.com', name: 'sloantest' },
    ...Array.from({ length: 7 }, (_, i) => ({
      email: `test_user${i + 1}@example.com`,
      name: `test_user${i + 1}`
    }))
  ];

  // Create other test users
  for (const u of usersData) {
    const hash = await bcrypt.hash('sloantest', 10);
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        name: u.name,
        password: hash,
        isOrganization: false,
        profile: { create: { language: 'en' } }
      }
    });
  }

  // Fetch created users
  const users = await prisma.user.findMany({ where: { email: { in: usersData.map(u => u.email) } } });
  const userMap = Object.fromEntries(users.map(u => [u.email, u]));

  // Create referral codes and relationships
  const referralPairs = [
    ['sloan_test@sloantest.com', 'test_user1@example.com'],
    ['test_user1@example.com', 'test_user2@example.com'],
    ['test_user2@example.com', 'test_user3@example.com'],
    ['test_user3@example.com', 'test_user4@example.com'],
    ['sloan_test@sloantest.com', 'test_user5@example.com'],
    ['test_user1@example.com', 'test_user6@example.com'],
    ['test_user5@example.com', 'test_user7@example.com']
  ];

  for (const [invEmail, invrEmail] of referralPairs) {
    const inviter = userMap[invEmail];
    const invitee = userMap[invrEmail];
    const code = crypto.randomBytes(4).toString('hex');
    await prisma.referral.upsert({
      where: { inviteeId: invitee.id },
      update: { code },
      create: {
        inviterId: inviter.id,
        inviteeId: invitee.id,
        code
      }
    });
  }

  // Fetch existing badge IDs for seeding user badges
  const badgeRecords = await prisma.badge.findMany({ select: { id: true } });
  const badgeIds = badgeRecords.map(b => b.id);

  // Fetch existing activity IDs for seeding DataDanceIDs
  const activityRecords = await prisma.activity.findMany({ select: { id: true } });
  const activityIds = activityRecords.map(a => a.id);

  // Seed Points, NFT assets, badges and DataDanceIDs
  for (const u of users) {
    // random points
    await prisma.point.create({ data: { userId: u.id, amount: Math.floor(Math.random() * 500) + 50, source: 'TEST_SEED' } });
    // NFT assets
    const assetCount = Math.floor(Math.random() * 5) + 1;
    for (let i = 0; i < assetCount; i++) {
      await prisma.nFTDataAsset.create({ data: {
        name: `TestNFT_${u.name}_${i+1}`,
        description: 'Seeded test NFT',
        metadata: {},
        ownerId: u.id
      }});
    }
    // badges
    const badgeCount = Math.floor(Math.random() * 3);
    for (let i = 0; i < badgeCount; i++) {
      if (badgeIds.length === 0) break;
      const randomBadgeId = badgeIds[Math.floor(Math.random() * badgeIds.length)];
      await prisma.userBadge.create({ data: { userId: u.id, badgeId: randomBadgeId } });
    }
    // DataDanceIDs
    const idCount = Math.floor(Math.random() * 4);
    for (let i = 0; i < idCount; i++) {
      if (activityIds.length === 0) break;
      const randomActivityId = activityIds[Math.floor(Math.random() * activityIds.length)];
      await prisma.dataDanceID.create({ data: { userId: u.id, activityId: randomActivityId, identifier: crypto.randomUUID() } });
    }
  }

  // Seed referral tasks progress for direct invites
  const tasks = await prisma.task.findMany({ where: { awardId: 'referral-rewards' } });
  const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]));
  for (const [invEmail, invrEmail] of referralPairs) {
    const inviter = userMap[invEmail];
    // upsert UserTask for direct referral task (ref-1)
    await prisma.userTask.upsert({
      where: { userId_taskId: { userId: inviter.id, taskId: 'ref-1' } },
      update: { progress: 1, completed: true },
      create: { userId: inviter.id, taskId: 'ref-1', progress: 1, completed: true }
    });
  }
  console.log('Seeded referral UserTask progress for direct invites.');

  console.log('Seeded test referral users, relationships, points, assets, badges and IDs.');
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());