/**
 * @deprecated Mother's Day 2026 campaign has ended. Do not run except for historical replay in a dev DB.
 *
 * Creates in-app Notification rows for all users (batched).
 * Run once per phase at the desired PT calendar date (or shortly after).
 *
 * Usage:
 *   node scripts/sendMothersDayCampaignNotifications.js launch
 *   node scripts/sendMothersDayCampaignNotifications.js reminder
 *   node scripts/sendMothersDayCampaignNotifications.js lastcall
 *
 * Requires DATABASE_URL in env (.env).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const prisma = require('../src/utils/prisma');

const PHASES = {
  launch: {
    type: 'CAMPAIGN_MOTHERS_DAY_2026_LAUNCH',
    title: "Mother's Day Bonus is live",
    content:
      "Mother's Day Bonus is live. Share DataDance Wallet with someone you appreciate. You earn 300 Points — and gift them 200 to start.",
  },
  reminder: {
    type: 'CAMPAIGN_MOTHERS_DAY_2026_REMINDER',
    title: "Mother's Day Bonus — 2 days left",
    content:
      "Mother's Day Bonus ends in 2 days. Still time to share the love — and earn 300 Points when they join with your link.",
  },
  lastcall: {
    type: 'CAMPAIGN_MOTHERS_DAY_2026_LASTCALL',
    title: "Mother's Day Bonus ends today",
    content:
      "Last chance. Mother's Day Bonus ends today. One last invite. Earn 300 Points, gift them 200.",
  },
};

async function main() {
  const phaseKey = process.argv[2];
  const def = PHASES[phaseKey];
  if (!def) {
    console.error('Usage: node scripts/sendMothersDayCampaignNotifications.js <launch|reminder|lastcall>');
    process.exit(1);
  }

  let cursorId = null;
  let total = 0;
  const batchSize = 400;

  for (;;) {
    const batch = await prisma.user.findMany({
      take: batchSize,
      ...(cursorId
        ? { skip: 1, cursor: { id: cursorId }, orderBy: { id: 'asc' } }
        : { orderBy: { id: 'asc' } }),
      select: { id: true },
    });

    if (batch.length === 0) break;

    await prisma.notification.createMany({
      data: batch.map((u) => ({
        userId: u.id,
        title: def.title,
        content: def.content,
        type: def.type,
      })),
    });

    total += batch.length;
    cursorId = batch[batch.length - 1].id;
    console.log(`Inserted ${batch.length} notifications (total ${total})...`);
  }

  console.log(`Done. Phase=${phaseKey} total notifications=${total}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
