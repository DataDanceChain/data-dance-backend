const prisma = require('../src/utils/prisma');

async function main() {
  // Award definitions matching front-end mock data
  const awards = [
    { id: 'social-engagement', title: 'Social Engagement', description: 'Share DataDance news and earn rewards', icon: 'shareOutline', color: '#1DA1F2', status: 'LIVE' },
    { id: 'profile-awards', title: 'Profile Awards', description: 'Complete your profile to earn rewards', icon: 'peopleOutline', color: '#34C8B9', status: 'LIVE' },
    { id: 'early-registration', title: 'Early Registration', description: 'Early adopter rewards for registering before June 2025', icon: 'calendarOutline', color: '#4ECDC4', status: 'LIVE' },
    { id: 'referral-rewards', title: 'Referral Rewards', description: 'Earn rewards from your referral network activities', icon: 'peopleOutline', color: '#FF6B6B', status: 'LIVE' },
    { id: 'assets-collection', title: 'Assets Collection', description: 'Collect NFTs and earn exclusive titles', icon: 'diamondOutline', color: '#7C5CFC', status: 'LIVE' },
    { id: 'badge-collection', title: 'Badge Collection', description: 'Collect brand badges and earn rewards', icon: 'starOutline', color: '#FFB86C', status: 'LIVE' },
    { id: 'ddc-holdings', title: 'DDC Holdings', description: 'Earn rewards based on your DDC holdings', icon: 'cardOutline', color: '#45B7AF', status: 'LIVE' },
    { id: 'ecosystem-participation', title: 'Ecosystem Participation', description: 'Data contribution & governance rewards', icon: 'diamondOutline', color: '#7C5CFC', status: 'LOCKED' },
    { id: 'trading-incentives', title: 'Trading Incentives', description: 'Fee rebates & trading rewards', icon: 'trophyOutline', color: '#FF6B6B', status: 'LOCKED' },
    { id: 'loyalty-program', title: 'Loyalty Program', description: 'Holding rewards & activity bonuses', icon: 'starOutline', color: '#FFB86C', status: 'LOCKED' },
    { id: 'business-partnership', title: 'Business Partnership', description: 'Brand collaboration rewards', icon: 'businessOutline', color: '#A8E6CF', status: 'LOCKED' },
    { id: 'innovation-rewards', title: 'Innovation Rewards', description: 'Beta testing & feedback rewards', icon: 'bulbOutline', color: '#FF8B94', status: 'LOCKED' },
    { id: 'education-rewards', title: 'Education Rewards', description: 'Learn & earn program', icon: 'schoolOutline', color: '#3498DB', status: 'LOCKED' },
    { id: 'seasonal-events', title: 'Seasonal Events', description: 'Limited-time special rewards', icon: 'calendarOutline', color: '#E056FD', status: 'LOCKED' },
    { id: 'ecosystem-building', title: 'Ecosystem Building', description: 'Cross-chain collaboration rewards', icon: 'earthOutline', color: '#95A5A6', status: 'LOCKED' }
  ];

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

  console.log('Award definitions seeded.');

  // Task definitions matching front-end mock data
  const tasksByAward = {
    'social-engagement': [
      { id: 'social-1', title: 'DataDance Launch', requirement: "Repost: 'Excited to announce the launch of @DataDance - Revolutionizing data sharing and NFT rewards! 🚀 #DataDance #Web3 #NFT'", points: 50, claimLimit: 1 },
      { id: 'social-2', title: 'Partnership Announcement', requirement: "Repost: 'Major partnership alert! 🤝 @DataDance teams up with leading brands to bring you exclusive NFT rewards! Stay tuned for more exciting news! #DataDancePartnership'", points: 50, claimLimit: 1 },
      { id: 'social-3', title: 'Community Milestone', requirement: "Repost: 'Celebrating 10,000 users on DataDance! 🎉 Thank you for being part of our amazing community! Join us now and earn exclusive rewards! #DataDanceCommunity'", points: 50, claimLimit: 1 },
      { id: 'social-4', title: 'New Feature Release', requirement: "Repost: 'Introducing DataDance 2.0! 🌟 Enhanced rewards, smoother experience, and more ways to earn! Check out our latest features now! #DataDanceUpdate'", points: 50, claimLimit: 1 }
    ],
    'profile-awards': [
      { id: 'profile-1', title: 'Complete Profile', requirement: 'Fill in your profile information including name, email, and profile picture to help us know you better', points: 100, claimLimit: 1 }
    ],
    'early-registration': [
      { id: 'early-1', title: 'Early Registration Bonus', requirement: 'Register and join DataDance before June 2025 to receive early adopter rewards', points: 100, claimLimit: 1 }
    ],
    'referral-rewards': [
      { id: 'referral-1', title: 'Direct Invite Reward', requirement: 'Reward for directly inviting a user', points: 50, claimLimit: null },
      { id: 'referral-2', title: 'Level 2 Referral Bonus', requirement: 'Bonus for referrals made by your direct invitees', points: 5, claimLimit: null },
      { id: 'referral-3', title: 'Level 3 Referral Bonus', requirement: 'Bonus for referrals made at level 3', points: 3, claimLimit: null },
      { id: 'referral-4', title: 'Level 4 Referral Bonus', requirement: 'Bonus for referrals made at level 4', points: 1, claimLimit: null }
    ],
    'assets-collection': [
      { id: 'assets-1', title: 'Novice Collector', requirement: 'Hold 3 NFTs in your collection', points: 50, claimLimit: 1 },
      { id: 'assets-2', title: 'Rising Collector', requirement: 'Hold 10 NFTs in your collection', points: 100, claimLimit: 1, prerequisiteTaskId: 'assets-1' },
      { id: 'assets-3', title: 'Advanced Collector', requirement: 'Hold 20 NFTs in your collection', points: 100, claimLimit: 1, prerequisiteTaskId: 'assets-2' },
      { id: 'assets-4', title: 'Elite Collector', requirement: 'Hold 50 NFTs in your collection', points: 100, claimLimit: 1, prerequisiteTaskId: 'assets-3' },
      { id: 'assets-5', title: 'Legendary Collector', requirement: "Hold 100 NFTs in your collection - Earn the 'Affluent Player' title", points: 150, claimLimit: 1, prerequisiteTaskId: 'assets-4' }
    ],
    'badge-collection': [
      { id: 'badge-1', title: 'Brand Explorer', requirement: 'Collect badges from 3 different brands', points: 50, claimLimit: 1 },
      { id: 'badge-2', title: 'Brand Enthusiast', requirement: 'Collect badges from 5 different brands', points: 50, claimLimit: 1, prerequisiteTaskId: 'badge-1' },
      { id: 'badge-3', title: 'Brand Connoisseur', requirement: 'Collect badges from 10 different brands', points: 100, claimLimit: 1, prerequisiteTaskId: 'badge-2' },
      { id: 'badge-4', title: 'Brand Master', requirement: 'Collect badges from 20 different brands', points: 100, claimLimit: 1, prerequisiteTaskId: 'badge-3' }
    ],
    'ddc-holdings': [
      { id: 'ddc-1', title: 'DDC Starter', requirement: 'Hold 10 DDC in your wallet', points: 50, claimLimit: 1 },
      { id: 'ddc-2', title: 'DDC Collector', requirement: 'Hold 50 DDC in your wallet', points: 100, claimLimit: 1, prerequisiteTaskId: 'ddc-1' },
      { id: 'ddc-3', title: 'DDC Enthusiast', requirement: 'Hold 100 DDC in your wallet', points: 100, claimLimit: 1, prerequisiteTaskId: 'ddc-2' },
      { id: 'ddc-4', title: 'DDC Investor', requirement: 'Hold 200 DDC in your wallet', points: 150, claimLimit: 1, prerequisiteTaskId: 'ddc-3' },
      { id: 'ddc-5', title: 'DDC Whale', requirement: 'Hold 500 DDC in your wallet', points: 150, claimLimit: 1, prerequisiteTaskId: 'ddc-4' },
      { id: 'ddc-6', title: 'DDC Mogul', requirement: 'Hold 1000 DDC in your wallet', points: 200, claimLimit: 1, prerequisiteTaskId: 'ddc-5' },
      { id: 'ddc-7', title: 'DDC Tycoon', requirement: 'Hold 2000 DDC in your wallet', points: 200, claimLimit: 1, prerequisiteTaskId: 'ddc-6' },
      { id: 'ddc-8', title: 'DDC Legend', requirement: 'Hold 5000 DDC in your wallet', points: 250, claimLimit: 1, prerequisiteTaskId: 'ddc-7' }
    ],
    'ecosystem-participation': [
      { id: 'eco-1', title: 'Data Contribution', requirement: 'Share your first dataset on the platform and help build the community', points: 200, claimLimit: 1 },
      { id: 'eco-2', title: 'Governance Voting', requirement: 'Participate in community governance by voting on important platform decisions', points: 100, claimLimit: 1 }
    ],
    'trading-incentives': [
      { id: 'trade-1', title: 'First Trade', requirement: 'Complete your first data trade on the platform to unlock this reward', points: 300, claimLimit: 1 },
      { id: 'trade-2', title: 'Trading Volume', requirement: 'Reach 1000 Points in total trading volume to earn this bonus', points: 500, claimLimit: 1 }
    ],
    'loyalty-program': [
      { id: 'loyalty-1', title: 'Token Holding', requirement: 'Hold your tokens for 30 consecutive days to earn loyalty rewards', points: 200, claimLimit: 1 },
      { id: 'loyalty-2', title: 'Daily Check-in', requirement: 'Check in daily for 7 consecutive days to earn bonus points', points: 10, claimLimit: 1 }
    ],
    'innovation-rewards': [
      { id: 'innov-1', title: 'Beta Testing', requirement: 'Participate in beta testing', points: 200, claimLimit: 1 },
      { id: 'innov-2', title: 'Feature Feedback', requirement: 'Provide valuable feature feedback', points: 100, claimLimit: 1 }
    ],
    'education-rewards': [
      { id: 'edu-1', title: 'Tutorial Completion', requirement: 'Complete platform tutorials', points: 50, claimLimit: 1 },
      { id: 'edu-2', title: 'Knowledge Quiz', requirement: 'Pass the platform knowledge quiz', points: 100, claimLimit: 1 }
    ],
    'business-partnership': [],
    'seasonal-events': [],
    'ecosystem-building': []
  };

  // Upsert task definitions per award
  for (const award of awards) {
    const defs = tasksByAward[award.id] || [];
    for (const t of defs) {
      await prisma.task.upsert({
        where: { id: t.id },
        update: {
          title: t.title,
          description: t.requirement,
          points: t.points,
          status: award.status,
          claimLimit: t.claimLimit,
          prerequisiteTaskId: t.prerequisiteTaskId || null
        },
        create: {
          id: t.id,
          awardId: award.id,
          title: t.title,
          description: t.requirement,
          points: t.points,
          status: award.status,
          claimLimit: t.claimLimit,
          prerequisiteTaskId: t.prerequisiteTaskId || null
        }
      });
    }
  }

  console.log('Task definitions seeded.');

  // Note: user test data seeding is moved to a separate script 'seedTestUserData.js'
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());