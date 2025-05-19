const prisma = require('../src/utils/prisma');
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { recordTaskProgress } = require('../src/services/taskService');
const { generateReferralCode } = require('../src/utils/referralUtils');

/**
 * Seed test users, referral relationships, UserAward, and UserTask data.
 * Uses TEST_USER_EMAIL env var to locate the main test user.
 */
async function main() {
  const mainEmail = process.env.TEST_USER_EMAIL;
  if (!mainEmail) throw new Error('Please set TEST_USER_EMAIL in environment');

  // Prepare list of test users: only main test user
  const emails = [mainEmail];

  // Precompute password hash for main test user
  const defaultPassword = 'sloantest';
  const defaultHash = await bcrypt.hash(defaultPassword, 10);
  // Upsert main test user and build map
  const userMap = {};
  const mainUser = await prisma.user.upsert({
    where: { email: mainEmail },
    update: { 
      name: mainEmail.split('@')[0],
      referralCode: generateReferralCode()
    },
    create: { 
      email: mainEmail, 
      name: mainEmail.split('@')[0], 
      password: defaultHash, 
      referralCode: generateReferralCode(),
      profile: { create: { language: 'en' } } 
    }
  });
  userMap[mainEmail] = mainUser;
  console.log(`[seedTestUserData] Upserted main test user: ${mainEmail}`);
  console.log('[seedTestUserData] Base user seeding complete');

  // Generate 4-level referrals under main user, naming Test_user_path
  const levels = [[{ email: mainEmail, path: '' }]];
  const referralPairs = [];
  for (let lvl = 1; lvl <= 4; lvl++) {
    const current = [];
    for (const { email: referrerEmail, path } of levels[lvl-1]) {
      const count = Math.floor(Math.random() * 5) + 1;
      for (let i = 1; i <= count; i++) {
        const newPath = path ? `${path}_${i}` : `${i}`;
        const childEmail = `test.user.${newPath}.${lvl}@example.com`;
        referralPairs.push([referrerEmail, childEmail]);
        current.push({ email: childEmail, path: newPath });
      }
    }
    levels.push(current);
  }

  // Upsert each referral user with path-based name
  await Promise.all(referralPairs.map(async ([, childEmail]) => {
    const path = levels.flat().find(o => o.email === childEmail)?.path;
    const name = path ? `Test_user_${path}` : childEmail.split('@')[0];
    const user = await prisma.user.upsert({
      where: { email: childEmail }, 
      update: { 
        name,
        referralCode: generateReferralCode()
      },
      create: { 
        email: childEmail, 
        name, 
        password: defaultHash, 
        referralCode: generateReferralCode(),
        profile: { create: { language: 'en' } } 
      }
    });
    userMap[childEmail] = user;
    emails.push(childEmail);
  }));
  console.log(`[seedTestUserData] Created referral users across 4 levels: total ${emails.length}`);

  const allPairs = referralPairs;

  // Batch create referral relations
  await Promise.all(allPairs.map(async ([refEmail, refereeEmail]) => {
    const referrer = userMap[refEmail];
    const referee = userMap[refereeEmail];
    const code = referrer.referralCode;

    await prisma.referral.upsert({
      where: { inviteeId: referee.id },
      update: {
        inviterId: referrer.id,
        code
      },
      create: { 
        inviterId: referrer.id, 
        inviteeId: referee.id, 
        code 
      }
    });
  }));
  console.log(`[seedTestUserData] Created ${allPairs.length} referral relationships`);

  // Prefill referral task progress for referral levels 1–4
  const parentMap = {};
  allPairs.forEach(([refEmail, refereeEmail]) => { parentMap[refereeEmail] = refEmail; });
  for (let lvl = 1; lvl <= 4; lvl++) {
    const taskId = `referral-${lvl}`;
    for (const { email } of levels[lvl]) {
      const referrerId = userMap[parentMap[email]].id;
      await recordTaskProgress(referrerId, taskId, 1);
    }
  }
  console.log('[seedTestUserData] Prefilled referral task progress for levels 1-4');

  // Only seed for active awards (status LIVE)
  const awards = await prisma.award.findMany({ where: { status: 'LIVE' } });
  // Batch seed UserAward and UserTask per user
  await Promise.all(emails.map(async (email) => {
    const userId = userMap[email].id;
    for (const award of awards) {
      await prisma.userAward.upsert({
        where: { userId_awardId: { userId, awardId: award.id } },
        update: { status: award.status, claimed: false },
        create: { userId, awardId: award.id, status: award.status, claimed: false }
      });
      const tasks = await prisma.task.findMany({ where: { awardId: award.id } });
      await Promise.all(tasks.map(task => {
        // Tasks with a prerequisite should start locked
        const initStatus = task.prerequisiteTaskId ? 'LOCKED' : task.status;
        return prisma.userTask.upsert({
          where: { userId_taskId: { userId, taskId: task.id } },
          update: { status: initStatus, claimRecords: [], claimed: false },
          create: { userId, taskId: task.id, status: initStatus, claimRecords: [], claimed: false }
        });
      }));
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