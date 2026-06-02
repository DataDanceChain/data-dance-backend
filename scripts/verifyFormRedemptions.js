/**
 * Cross-check Google Form redemption CSV against production user activity.
 * Usage: node scripts/verifyFormRedemptions.js /path/to/form.csv [startRow1Based]
 */
const fs = require('fs');
const prisma = require('../src/utils/prisma');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

const { parsePointsFromRewardText } = require('../src/constants/rewardRedemptionCatalog');

function parsePoints(rewardText) {
  return parsePointsFromRewardText(rewardText);
}

function parseRewardLabel(rewardText) {
  return (rewardText || '').split('–')[0].split('-')[0].trim();
}

async function profileUser(user) {
  const userId = user.id;
  const [uploadCount, pointsBySource, redeemedRows, asInvitee, directInvites, referralDirectCount] =
    await Promise.all([
      prisma.crawlerData.count({ where: { userId } }),
      prisma.point.groupBy({
        by: ['source'],
        where: { userId },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.point.findMany({
        where: { userId, source: 'REWARD_REDEMPTION' },
        select: { amount: true, sourceId: true, createdAt: true },
      }),
      prisma.referral.findUnique({
        where: { inviteeId: userId },
        include: { inviter: { select: { email: true } } },
      }),
      prisma.referral.count({ where: { inviterId: userId, campaignSlug: null } }),
      prisma.point.count({ where: { userId, source: 'REFERRAL_DIRECT' } }),
    ]);

  const earned = pointsBySource.reduce((s, p) => s + (p._sum.amount || 0), 0);
  const referralDirect =
    pointsBySource.find((p) => p.source === 'REFERRAL_DIRECT')?._sum.amount || 0;
  const taskClaim =
    pointsBySource.find((p) => p.source === 'TASK_CLAIM')?._sum.amount || 0;
  const crawlerPts = pointsBySource.find((p) => p.source === 'crawler')?._sum.amount || 0;
  const alreadyRedeemed = redeemedRows.reduce((s, r) => s + Math.abs(r.amount), 0);

  const flags = [];
  if (uploadCount === 0) flags.push('NO_UPLOAD');
  if (referralDirectCount >= 5) flags.push('HIGH_REFERRAL');
  if (directInvites >= 10) flags.push('MASS_INVITER');
  if (referralDirect > 0 && uploadCount === 0) flags.push('REFERRAL_NO_UPLOAD');
  if (user.totalPoints < 0) flags.push('NEGATIVE_BALANCE');

  return {
    userId,
    email: user.email,
    wallet: user.walletAddress,
    registeredAt: user.createdAt,
    balance: user.totalPoints,
    earnedTotal: earned,
    alreadyRedeemedPts: alreadyRedeemed,
    uploadCount,
    referralDirectPts: referralDirect,
    referralDirectCount,
    taskClaimPts: taskClaim,
    crawlerPts,
    directInvites,
    invitedBy: asInvitee?.inviter?.email || null,
    redemptionRecords: redeemedRows,
    flags,
    risk: flags.includes('MASS_INVITER') || flags.includes('HIGH_REFERRAL') ? 'HIGH' : flags.length ? 'MEDIUM' : 'LOW',
  };
}

async function main() {
  const csvPath = process.argv[2];
  const startRow = parseInt(process.argv[3] || '13', 10);
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error('Usage: node scripts/verifyFormRedemptions.js <csvPath> [startRow]');
    process.exit(1);
  }

  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = startRow - 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 4) continue;
    const [timestamp, reward, wallet, email] = cols;
    const pointsRequired = parsePoints(reward);
    rows.push({
      formRow: i + 1,
      timestamp,
      reward: parseRewardLabel(reward),
      rewardRaw: reward,
      pointsRequired,
      wallet: (wallet || '').trim(),
      email: (email || '').trim().toLowerCase(),
      xHandle: cols[7] || '',
    });
  }

  const results = [];
  for (const row of rows) {
    let user =
      (row.email &&
        (await prisma.user.findFirst({
          where: { email: { equals: row.email, mode: 'insensitive' } },
          select: {
            id: true,
            email: true,
            walletAddress: true,
            totalPoints: true,
            createdAt: true,
          },
        }))) ||
      (row.wallet &&
        (await prisma.user.findFirst({
          where: { walletAddress: { equals: row.wallet, mode: 'insensitive' } },
          select: {
            id: true,
            email: true,
            walletAddress: true,
            totalPoints: true,
            createdAt: true,
          },
        })));

    if (!user) {
      results.push({
        ...row,
        status: 'NOT_IN_DB',
        canAfford: false,
        walletMatch: false,
        risk: 'UNKNOWN',
      });
      continue;
    }

    const profile = await profileUser(user);
    const walletMatch =
      !row.wallet ||
      (user.walletAddress || '').toLowerCase() === row.wallet.toLowerCase();
    const canAfford =
      row.pointsRequired != null && user.totalPoints >= row.pointsRequired;
    const duplicateForm = results.filter(
      (r) => r.email?.toLowerCase() === user.email.toLowerCase(),
    ).length;

    results.push({
      ...row,
      dbEmail: user.email,
      dbWallet: user.walletAddress,
      status: 'FOUND',
      walletMatch,
      canAfford,
      duplicatePriorInForm: duplicateForm,
      sufficientAfterPriorPending:
        row.pointsRequired != null
          ? user.totalPoints >= row.pointsRequired * (duplicateForm + 1)
          : null,
      ...profile,
    });
  }

  const summary = {
    formRowsChecked: rows.length,
    uniqueEmails: new Set(rows.map((r) => r.email)).size,
    foundInDb: results.filter((r) => r.status === 'FOUND').length,
    notInDb: results.filter((r) => r.status === 'NOT_IN_DB').length,
    canAffordAll: results.filter((r) => r.canAfford).length,
    cannotAfford: results.filter((r) => r.status === 'FOUND' && !r.canAfford).length,
    walletMismatch: results.filter((r) => r.status === 'FOUND' && !r.walletMatch).length,
    highRisk: results.filter((r) => r.risk === 'HIGH').length,
    mediumRisk: results.filter((r) => r.risk === 'MEDIUM').length,
    noUpload: results.filter((r) => r.uploadCount === 0 && r.status === 'FOUND').length,
    totalPointsRequested: rows.reduce((s, r) => s + (r.pointsRequired || 0), 0),
    duplicateSubmissions: results.filter((r) => r.duplicatePriorInForm > 0).length,
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
