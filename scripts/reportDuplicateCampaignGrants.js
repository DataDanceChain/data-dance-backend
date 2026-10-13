/**
 * Read-only report: one-time campaign grants (first-action bonus, referral boost) that exist more
 * than once for the same user, source and sourceId. Those grants are now decided under a lock, so
 * new duplicates cannot appear; this lists any written before. It changes nothing: whether to
 * adjust a listed balance is an ops decision, and no Point row is ever deleted.
 *
 * Usage (where the API runs, so DATABASE_URL is the server's):
 *   node scripts/reportDuplicateCampaignGrants.js
 *
 * Output holds user ids, sources, sourceIds, counts and amounts only.
 */
const prisma = require('../src/utils/prisma');
const { POINT_SOURCE_FIRST_ACTION, POINT_SOURCE_REFERRAL_BOOST } = require('../src/utils/campaignRules');

const ONE_TIME_SOURCES = [POINT_SOURCE_FIRST_ACTION, POINT_SOURCE_REFERRAL_BOOST];

/** Groups with more than one row, newest first. Uses the (source, sourceId) index. */
async function findDuplicateGrants(client = prisma) {
  const groups = await client.point.groupBy({
    by: ['userId', 'source', 'sourceId'],
    where: { source: { in: ONE_TIME_SOURCES } },
    _count: { _all: true },
    _sum: { amount: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
    having: { userId: { _count: { gt: 1 } } },
  });
  return groups
    .map((group) => ({
      userId: group.userId,
      source: group.source,
      sourceId: group.sourceId,
      rows: group._count._all,
      totalAmount: Number(group._sum.amount) || 0,
      firstAt: group._min.createdAt,
      lastAt: group._max.createdAt,
    }))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
}

async function main() {
  try {
    const groups = await findDuplicateGrants();
    console.log(`one-time campaign grants written more than once: ${groups.length} group(s)`);
    for (const g of groups) {
      console.log(
        `  user ${g.userId} ${g.source} ${g.sourceId}: ${g.rows} rows, ${g.totalAmount} points, ` +
          `${new Date(g.firstAt).toISOString()} .. ${new Date(g.lastAt).toISOString()}`,
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = { findDuplicateGrants, ONE_TIME_SOURCES };
