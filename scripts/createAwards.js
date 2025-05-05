const prisma = require('../src/utils/prisma');

async function main() {
  // Seed awards based on front-end mock awardCategories
  const awards = [
    { id: 'social-engagement', title: 'Social Engagement', description: 'Share DataDance news and earn rewards', rewards: 50, completionType: 'PARALLEL' },
    { id: 'profile-awards', title: 'Profile Awards', description: 'Complete your profile to earn rewards', rewards: 100, completionType: 'PARALLEL' },
    { id: 'early-registration', title: 'Early Registration', description: 'Early adopter rewards for registering before June 2025', rewards: 100, completionType: 'PARALLEL' },
    { id: 'referral-rewards', title: 'Referral Rewards', description: 'Earn rewards from your referral network activities', rewards: 0, completionType: 'PARALLEL' },
    { id: 'assets-collection', title: 'Assets Collection', description: 'Collect NFTs and earn exclusive titles', rewards: 500, completionType: 'TIERED' },
    { id: 'badge-collection', title: 'Badge Collection', description: 'Collect brand badges and earn rewards', rewards: 300, completionType: 'TIERED' },
    { id: 'ddc-holdings', title: 'DDC Holdings', description: 'Earn rewards based on your DDC holdings', rewards: 1000, completionType: 'TIERED' },
    { id: 'ecosystem-participation', title: 'Ecosystem Participation', description: 'Data contribution & governance rewards', rewards: 500, completionType: 'TIERED' },
    { id: 'trading-incentives', title: 'Trading Incentives', description: 'Fee rebates & trading rewards', rewards: 0, completionType: 'PARALLEL' },
    { id: 'loyalty-program', title: 'Loyalty Program', description: 'Holding rewards & activity bonuses', rewards: 2000, completionType: 'TIERED' },
    { id: 'business-partnership', title: 'Business Partnership', description: 'Brand collaboration rewards', rewards: 0, completionType: 'PARALLEL' },
    { id: 'innovation-rewards', title: 'Innovation Rewards', description: 'Beta testing & feedback rewards', rewards: 300, completionType: 'TIERED' },
    { id: 'education-rewards', title: 'Education Rewards', description: 'Learn & earn program', rewards: 150, completionType: 'TIERED' },
    { id: 'seasonal-events', title: 'Seasonal Events', description: 'Limited-time special rewards', rewards: 0, completionType: 'PARALLEL' },
    { id: 'ecosystem-building', title: 'Ecosystem Building', description: 'Cross-chain collaboration rewards', rewards: 0, completionType: 'PARALLEL' }
  ];

  // Upsert each award
  for (const award of awards) {
    await prisma.award.upsert({
      where: { id: award.id },
      update: { title: award.title, description: award.description, rewards: award.rewards, completionType: award.completionType },
      create: award
    });
  }

  console.log('Seeded Award table.');

  // Find test user by email from environment variable
  const USER_EMAIL = process.env.TEST_USER_EMAIL;
  if (!USER_EMAIL) {
    console.error('Please set TEST_USER_EMAIL in .env or as an environment variable.');
    return;
  }
  const user = await prisma.user.findUnique({ where: { email: USER_EMAIL } });
  if (!user) {
    console.error(`Test user with email ${USER_EMAIL} not found.`);
    return;
  }

  // Upsert UserAward entries for this user
  for (const award of awards) {
    await prisma.userAward.upsert({
      where: { userId_awardId: { userId: user.id, awardId: award.id } },
      update: { status: 'IN_PROGRESS', progress: 0, claimed: false },
      create: { userId: user.id, awardId: award.id, status: 'IN_PROGRESS', progress: 0, claimed: false }
    });
  }

  console.log('Seeded UserAward entries for test user.');

  // Seed Task definitions based on front-end mock categories
  const tasksByAward = {
    'social-engagement': [
      { id: 'social-1', title: 'DataDance Launch', description: 'Repost announcement', type: 'ONE_TIME', totalCount: 1, points: 50, requirement: "Repost: 'Excited to announce the launch...'", order: 1 },
      { id: 'social-2', title: 'Partnership Announcement', description: 'Repost partnership', type: 'ONE_TIME', totalCount: 1, points: 50, requirement: "Repost: 'Major partnership alert...'", order: 2 },
      { id: 'social-3', title: 'Community Milestone', description: 'Repost milestone', type: 'ONE_TIME', totalCount: 1, points: 50, requirement: "Repost: 'Celebrating 10,000 users...'", order: 3 },
      { id: 'social-4', title: 'New Feature Release', description: 'Repost feature release', type: 'ONE_TIME', totalCount: 1, points: 50, requirement: "Repost: 'Introducing DataDance 2.0...'", order: 4 }
    ],
    'profile-awards': [
      { id: 'profile-1', title: 'Complete Profile', description: 'Fill in profile', type: 'ONE_TIME', totalCount: 1, points: 100, requirement: 'Fill in your profile information', order: 1 }
    ],
    'early-registration': [
      { id: 'early-1', title: 'Early Registration', description: 'Register before cutoff', type: 'ONE_TIME', totalCount: 1, points: 100, requirement: 'Register before June 1, 2025', order: 1 }
    ],
    'referral-rewards': [
      { id: 'ref-1', title: 'Invite 1 Friend', description: 'Invite a friend', type: 'CONTINUOUS', totalCount: 1, points: 5, requirement: 'Invite someone using your code', order: 1 },
      { id: 'ref-2', title: 'Referral Level 2', description: 'Second level referral', type: 'CONTINUOUS', totalCount: 1, points: 3, requirement: 'Get a friend of a friend to register', order: 2 },
      { id: 'ref-3', title: 'Referral Level 3', description: 'Third level referral', type: 'CONTINUOUS', totalCount: 1, points: 1, requirement: 'Get a third level referral to register', order: 3 }
    ],
    'assets-collection': [
      { id: 'assets-1', title: 'Collect 1 NFT', description: 'Acquire 1 NFT', type: 'ONE_TIME', totalCount: 1, points: 100, requirement: 'Add 1 NFT to your collection', order: 1 },
      { id: 'assets-2', title: 'Collect 3 NFTs', description: 'Acquire 3 NFTs', type: 'ONE_TIME', totalCount: 3, points: 200, requirement: 'Add 3 NFTs to your collection', order: 2 },
      { id: 'assets-3', title: 'Collect 5 NFTs', description: 'Acquire 5 NFTs', type: 'ONE_TIME', totalCount: 5, points: 200, requirement: 'Add 5 NFTs to your collection', order: 3 }
    ],
    'badge-collection': [
      { id: 'badge-1', title: 'Earn 1 Badge', description: 'Collect a badge', type: 'ONE_TIME', totalCount: 1, points: 100, requirement: 'Claim 1 badge', order: 1 },
      { id: 'badge-2', title: 'Earn 3 Badges', description: 'Collect 3 badges', type: 'ONE_TIME', totalCount: 3, points: 150, requirement: 'Claim 3 badges', order: 2 },
      { id: 'badge-3', title: 'Earn 5 Badges', description: 'Collect 5 badges', type: 'ONE_TIME', totalCount: 5, points: 200, requirement: 'Claim 5 badges', order: 3 }
    ],
    'ddc-holdings': [
      { id: 'ddc-50', title: 'Hold 50 DDC', description: 'Hold 50 DDC tokens', type: 'ONE_TIME', totalCount: 50, points: 100, requirement: 'Hold 50 DDC', order: 1 },
      { id: 'ddc-100', title: 'Hold 100 DDC', description: 'Hold 100 DDC tokens', type: 'ONE_TIME', totalCount: 100, points: 100, requirement: 'Hold 100 DDC', order: 2 },
      { id: 'ddc-200', title: 'Hold 200 DDC', description: 'Hold 200 DDC tokens', type: 'ONE_TIME', totalCount: 200, points: 150, requirement: 'Hold 200 DDC', order: 3 },
      { id: 'ddc-500', title: 'Hold 500 DDC', description: 'Hold 500 DDC tokens', type: 'ONE_TIME', totalCount: 500, points: 150, requirement: 'Hold 500 DDC', order: 4 },
      { id: 'ddc-1000', title: 'Hold 1000 DDC', description: 'Hold 1000 DDC tokens', type: 'ONE_TIME', totalCount: 1000, points: 200, requirement: 'Hold 1000 DDC', order: 5 }
    ],
    'ecosystem-participation': [
      { id: 'eco-1', title: 'Governance Vote', description: 'Cast a governance vote', type: 'ONE_TIME', totalCount: 1, points: 100, requirement: 'Vote in DAO governance', order: 1 },
      { id: 'eco-2', title: 'Submit a Proposal', description: 'Submit ecosystem proposal', type: 'ONE_TIME', totalCount: 1, points: 200, requirement: 'Create a DAO proposal', order: 2 }
    ],
    'trading-incentives': [
      { id: 'trade-1', title: 'Make a Trade', description: 'Execute a trade', type: 'CONTINUOUS', totalCount: 1, points: 10, requirement: 'Complete one trade', order: 1 }
    ],
    'loyalty-program': [
      { id: 'loyal-1', title: '1 Month Loyalty', description: 'Hold account for 1 month', type: 'ONE_TIME', totalCount: 30, points: 500, requirement: 'Maintain 30 days activity', order: 1 },
      { id: 'loyal-2', title: '3 Month Loyalty', description: 'Hold account for 3 months', type: 'ONE_TIME', totalCount: 90, points: 1000, requirement: 'Maintain 90 days activity', order: 2 }
    ],
    'business-partnership': [
      { id: 'biz-1', title: 'Partner Onboard', description: 'Complete partnership onboarding', type: 'ONE_TIME', totalCount: 1, points: 300, requirement: 'Become a business partner', order: 1 }
    ],
    'innovation-rewards': [
      { id: 'innov-1', title: 'Beta Tester', description: 'Test new feature', type: 'ONE_TIME', totalCount: 1, points: 150, requirement: 'Participate in beta test', order: 1 },
      { id: 'innov-2', title: 'Submit Feedback', description: 'Provide product feedback', type: 'CONTINUOUS', totalCount: 1, points: 150, requirement: 'Submit detailed feedback', order: 2 }
    ],
    'education-rewards': [
      { id: 'edu-1', title: 'Complete Tutorial', description: 'Finish platform tutorial', type: 'ONE_TIME', totalCount: 1, points: 100, requirement: 'Complete onboarding tutorial', order: 1 },
      { id: 'edu-2', title: 'Pass Quiz', description: 'Pass educational quiz', type: 'ONE_TIME', totalCount: 1, points: 50, requirement: 'Score >80% on quiz', order: 2 }
    ],
    'seasonal-events': [
      { id: 'season-1', title: 'Holiday Event', description: 'Participate in holiday event', type: 'CONTINUOUS', totalCount: 1, points: 200, requirement: 'Join seasonal event', order: 1 }
    ],
    'ecosystem-building': [
      { id: 'build-1', title: 'Cross-chain Test', description: 'Bridge assets', type: 'ONE_TIME', totalCount: 1, points: 200, requirement: 'Bridge assets across chains', order: 1 }
    ]
  };

  for (const award of awards) {
    const defs = tasksByAward[award.id] || [];
    for (const t of defs) {
      await prisma.task.upsert({
        where: { id: t.id },
        update: { ...t, awardId: award.id },
        create: { ...t, awardId: award.id }
      });
    }
  }

  console.log('Seeded Task definitions for awards.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());