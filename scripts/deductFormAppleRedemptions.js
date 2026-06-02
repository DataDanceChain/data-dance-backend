/**
 * Deduct points for Google Form Apple Gift Code redemption rows (idempotent).
 * Usage: node scripts/deductFormAppleRedemptions.js [--dry-run]
 */
const prisma = require('../src/utils/prisma');

const APPLE_ROWS = [
  { formTs: '2025-12-12T17:48:36', email: 'race@enjoymusic.ai', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-11T02:51:36', email: 'oxmdshifat@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-17T16:41:45', email: 'oxmdshifat@gmail.com', points: 1500, reward: '$10 Apple' },
  { formTs: '2026-05-22T01:18:13', email: 'hralpin22@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-22T12:38:49', email: 'vaik1625@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-25T11:42:55', email: 'monxcataa@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-26T21:01:08', email: 'hralpin22@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-26T23:12:11', email: 'monxcataa@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-27T02:15:32', email: 'oxmdshifat@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-27T02:33:57', email: 'oxmdshifat@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-27T03:18:33', email: 'vaik1625@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-27T03:19:10', email: 'vaik1625@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-27T07:33:54', email: 'mimbosu57@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-27T08:53:15', email: 'jdu8291@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-27T09:27:56', email: 'boxmeet8@gmail.com', points: 3600, reward: '$25 Apple' },
  { formTs: '2026-05-31T12:52:15', email: 'kcximran@gmail.com', points: 3600, reward: '$25 Apple' },
];

function sourceIdFor(row) {
  const slug = row.formTs.replace(/[:.]/g, '-');
  const emailSlug = row.email.toLowerCase().replace(/[@.]/g, '_');
  return `google-form-apple-${emailSlug}-${slug}-${row.points}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const results = [];

  const sorted = [...APPLE_ROWS].sort(
    (a, b) => a.formTs.localeCompare(b.formTs) || a.email.localeCompare(b.email),
  );
  const coveredByEmail = new Map();

  for (const row of sorted) {
    const sourceId = sourceIdFor(row);
    const emailKey = row.email.toLowerCase();
    const user = await prisma.user.findFirst({
      where: { email: { equals: row.email, mode: 'insensitive' } },
      select: { id: true, email: true, totalPoints: true },
    });

    if (!user) {
      results.push({ ...row, sourceId, status: 'USER_NOT_FOUND' });
      continue;
    }

    const existing = await prisma.point.findFirst({
      where: { userId: user.id, source: 'REWARD_REDEMPTION', sourceId },
    });

    if (existing) {
      results.push({
        ...row,
        sourceId,
        status: 'ALREADY_DEDUCTED',
        existingAmount: existing.amount,
        balance: user.totalPoints,
      });
      continue;
    }

    if (!coveredByEmail.has(emailKey)) {
      const priorRedemptions = await prisma.point.findMany({
        where: { userId: user.id, source: 'REWARD_REDEMPTION' },
        select: { amount: true, sourceId: true, createdAt: true },
      });
      const priorTotal = priorRedemptions.reduce((s, p) => s + Math.abs(p.amount), 0);
      coveredByEmail.set(emailKey, { cumulativeForm: 0, coveredTotal: priorTotal, priorRedemptions });
    }
    const coverage = coveredByEmail.get(emailKey);
    coverage.cumulativeForm += row.points;

    if (coverage.coveredTotal >= coverage.cumulativeForm) {
      results.push({
        ...row,
        sourceId,
        status: 'SKIP_PRIOR_COVERED',
        coveredTotal: coverage.coveredTotal,
        cumulativeForm: coverage.cumulativeForm,
        priorRedemptions: coverage.priorRedemptions,
        balance: user.totalPoints,
      });
      continue;
    }

    const balanceBefore = user.totalPoints;

    if (dryRun) {
      coverage.coveredTotal += row.points;
      results.push({
        ...row,
        sourceId,
        status: 'WOULD_DEDUCT',
        balanceBefore,
        balanceAfter: balanceBefore - row.points,
        coveredTotalAfter: coverage.coveredTotal,
        priorRedemptions: coverage.priorRedemptions,
      });
      continue;
    }

    if (balanceBefore < row.points) {
      results.push({
        ...row,
        sourceId,
        status: 'INSUFFICIENT_BALANCE',
        balance: balanceBefore,
        priorRedemptions: coverage.priorRedemptions,
      });
      continue;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const point = await tx.point.create({
        data: {
          userId: user.id,
          amount: -row.points,
          source: 'REWARD_REDEMPTION',
          sourceId,
        },
      });
      const u = await tx.user.update({
        where: { id: user.id },
        data: { totalPoints: { decrement: row.points } },
        select: { totalPoints: true, email: true },
      });
      return { point, user: u };
    });

    coverage.coveredTotal += row.points;

    results.push({
      ...row,
      sourceId,
      status: 'DEDUCTED',
      balanceBefore,
      balanceAfter: updated.user.totalPoints,
      pointId: updated.point.id,
    });
  }

  const summary = {
    dryRun,
    totalRows: APPLE_ROWS.length,
    deducted: results.filter((r) => r.status === 'DEDUCTED').length,
    wouldDeduct: results.filter((r) => r.status === 'WOULD_DEDUCT').length,
    alreadyDeducted: results.filter((r) => r.status === 'ALREADY_DEDUCTED').length,
    skipPriorCovered: results.filter((r) => r.status === 'SKIP_PRIOR_COVERED').length,
    insufficient: results.filter((r) => r.status === 'INSUFFICIENT_BALANCE').length,
    notFound: results.filter((r) => r.status === 'USER_NOT_FOUND').length,
    totalPointsDeducted: results
      .filter((r) => r.status === 'DEDUCTED')
      .reduce((s, r) => s + r.points, 0),
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
