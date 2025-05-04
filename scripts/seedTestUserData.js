const prisma = require('../src/utils/prisma');
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/**
 * Seed test users, referral relationships, UserAward, and UserTask data.
 * Uses TEST_USER_EMAIL env var to locate the main test user.
 */
async function main() {
  const mainEmail = process.env.TEST_USER_EMAIL;
  if (!mainEmail) throw new Error('Please set TEST_USER_EMAIL in environment');

  // Prepare list of test users: main + ten others
  const otherEmails = Array.from({ length: 10 }, (_, i) => `test_user${i + 1}@example.com`);
  const emails = [mainEmail, ...otherEmails];

  // Precompute password hash for all test users (avoid repeating bcrypt.hash)
  const defaultPassword = 'sloantest';
  const defaultHash = await bcrypt.hash(defaultPassword, 10);
  // Upsert test users and build map
  const userMap = {};
  await Promise.all(emails.map(async (email) => {
    const user = await prisma.user.upsert({
      where: { email },
      update: { name: email.split('@')[0] },
      create: { email, name: email.split('@')[0], password: defaultHash, profile: { create: { language: 'en' } } }
    });
    userMap[email] = user;
  }));
  console.log(`[seedTestUserData] Upserted ${emails.length} base test users`);

  // Define referral chains, using inviter.inviteCode
  const referralPairs = [
    [mainEmail, otherEmails[0]],
    [otherEmails[0], otherEmails[1]],
    [otherEmails[1], otherEmails[2]],
    [mainEmail, otherEmails[3]],
    [otherEmails[3], otherEmails[4]],
    [otherEmails[4], otherEmails[5]],
    [otherEmails[1], otherEmails[6]]
  ];

  // Generate multi-level referral relationships (3 levels deep, 3 children each)
  const levels = [emails];
  const referralPairsExtended = [];
  const numLevels = 3;
  for (let lvl = 1; lvl <= numLevels; lvl++) {
    const prevEmails = levels[lvl - 1];
    const currentEmails = [];
    for (const inviterEmail of prevEmails) {
      for (let i = 1; i <= 3; i++) {
        const childEmail = `${inviterEmail}_lvl${lvl}_${i}@example.com`;
        currentEmails.push(childEmail);
        referralPairsExtended.push([inviterEmail, childEmail]);
      }
    }
    levels.push(currentEmails);
  }
  // Upsert all multi-level users in parallel per level
  for (const levelEmails of levels.slice(1)) {
    await Promise.all(levelEmails.map(async (email) => {
      const user = await prisma.user.upsert({
        where: { email }, update: {},
        create: { email, name: email.split('@')[0], password: defaultHash, profile: { create: { language: 'en' } } }
      });
      userMap[email] = user;
      emails.push(email);
    }));
  }
  console.log(`[seedTestUserData] Generated and upserted multi-level users, total users now: ${emails.length}`);

  // Combine original and extended referrals
  const allPairs = referralPairs.concat(referralPairsExtended);

  // Batch create referral relations
  await Promise.all(allPairs.map(async ([invEmail, invrEmail]) => {
    const inviter = userMap[invEmail];
    const invitee = userMap[invrEmail];
    const code = crypto.randomBytes(4).toString('hex');
    await prisma.referral.upsert({
      where: { inviteeId: invitee.id },
      update: { code },
      create: { inviterId: inviter.id, inviteeId: invitee.id, code }
    });
  }));
  console.log(`[seedTestUserData] Created ${allPairs.length} referral relationships`);

  // Seed UserAward/UserTask for all test users
  const awards = await prisma.award.findMany();
  // Batch seed UserAward and UserTask per user
  await Promise.all(emails.map(async (email) => {
    const userId = userMap[email].id;
    for (const award of awards) {
      await prisma.userAward.upsert({
        where: { userId_awardId: { userId, awardId: award.id } },
        update: { status: 'LIVE', claimed: false },
        create: { userId, awardId: award.id, status: 'LIVE', claimed: false }
      });
      const tasks = await prisma.task.findMany({ where: { awardId: award.id } });
      await Promise.all(tasks.map(task => 
        prisma.userTask.upsert({
          where: { userId_taskId: { userId, taskId: task.id } },
          update: { status: task.status, claimRecords: [] },
          create: { userId, taskId: task.id, status: task.status, claimRecords: [] }
        })
      ));
    }
  }));
  console.log(`[seedTestUserData] Seeded UserAward/UserTask for ${emails.length} users`);

  // Enrich main test user with heavy assets for testing incentives
  console.log('[seedTestUserData] Starting enrichment for main test user assets and points');
  const mainUserId = userMap[mainEmail].id;
  // Seed large number of points
  for (let i = 0; i < 100; i++) {
    await prisma.point.create({ data: { userId: mainUserId, amount: Math.floor(Math.random() * 500) + 100, source: 'TEST_SEED' } });
  }
  // Assign every badge to main user
  const allBadges = await prisma.badge.findMany({ select: { id: true } });
  for (const { id: badgeId } of allBadges) {
    await prisma.userBadge.upsert({
      where: { userId_badgeId: { userId: mainUserId, badgeId } },
      update: {}, create: { userId: mainUserId, badgeId }
    });
  }
  // Create many NFT assets
  for (let i = 1; i <= 50; i++) {
    await prisma.nFTDataAsset.create({ data: { name: `TestNFT_${i}`, description: 'Seeded NFT for main test user', metadata: {}, ownerId: mainUserId } });
  }
  console.log('[seedTestUserData] Enriched main test user with points, badges, and NFTs');
  console.log('[seedTestUserData] Completed all seeding tasks');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });