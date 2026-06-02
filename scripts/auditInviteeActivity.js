/**
 * Export invitee activity for flagged inviters (uploads + engagement signals).
 * Usage: node scripts/auditInviteeActivity.js [inviterEmail...]
 */
const prisma = require('../src/utils/prisma');

const DEFAULT_INVITER_EMAILS = [
  'oxmdshifat@gmail.com',
  'donfilex459@gmail.com',
  'hralpin22@gmail.com',
  'vaik1625@gmail.com',
  'monxcataa@gmail.com',
  'sakibr1997sakib@gmail.com',
  'denz.eldee008@gmail.com',
];

async function loadInviteeActivity(inviterEmail) {
  const inviter = await prisma.user.findUnique({
    where: { email: inviterEmail },
    select: { id: true, email: true, name: true, referralCode: true, createdAt: true },
  });
  if (!inviter) return { inviterEmail, error: 'inviter_not_found' };

  const referrals = await prisma.referral.findMany({
    where: { inviterId: inviter.id, campaignSlug: null },
    include: {
      invitee: {
        select: {
          id: true,
          email: true,
          name: true,
          walletAddress: true,
          createdAt: true,
          totalPoints: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const inviteeIds = referrals.map((r) => r.inviteeId);
  if (inviteeIds.length === 0) {
    return { inviter: inviterEmail, inviteeCount: 0, invitees: [], summary: {} };
  }

  const [
    uploadCounts,
    uploadBySource,
    pointsByUser,
    dailyEventsByUser,
    taskClaimsByUser,
    inviteeReferralOut,
  ] = await Promise.all([
    prisma.crawlerData.groupBy({
      by: ['userId'],
      where: { userId: { in: inviteeIds } },
      _count: { _all: true },
    }),
    prisma.crawlerData.groupBy({
      by: ['userId', 'source'],
      where: { userId: { in: inviteeIds } },
      _count: { _all: true },
    }),
    prisma.point.groupBy({
      by: ['userId', 'source'],
      where: { userId: { in: inviteeIds } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.userDailyEvent.groupBy({
      by: ['userId', 'type'],
      where: { userId: { in: inviteeIds } },
      _count: { _all: true },
    }),
    prisma.userTask.groupBy({
      by: ['userId'],
      where: {
        userId: { in: inviteeIds },
        OR: [{ claimed: true }, { claimRecords: { isEmpty: false } }],
      },
      _count: { _all: true },
    }),
    prisma.referral.groupBy({
      by: ['inviterId'],
      where: { inviterId: { in: inviteeIds }, campaignSlug: null },
      _count: { _all: true },
    }),
  ]);

  const uploadMap = Object.fromEntries(uploadCounts.map((r) => [r.userId, r._count._all]));
  const uploadSourceMap = {};
  for (const row of uploadBySource) {
    if (!uploadSourceMap[row.userId]) uploadSourceMap[row.userId] = {};
    uploadSourceMap[row.userId][row.source] = row._count._all;
  }
  const pointsMap = {};
  for (const row of pointsByUser) {
    if (!pointsMap[row.userId]) pointsMap[row.userId] = {};
    pointsMap[row.userId][row.source] = {
      sum: row._sum.amount,
      count: row._count._all,
    };
  }
  const dailyMap = {};
  for (const row of dailyEventsByUser) {
    if (!dailyMap[row.userId]) dailyMap[row.userId] = {};
    dailyMap[row.userId][row.type] = row._count._all;
  }
  const taskClaimMap = Object.fromEntries(
    taskClaimsByUser.map((r) => [r.userId, r._count._all]),
  );
  const outboundReferralMap = Object.fromEntries(
    inviteeReferralOut.map((r) => [r.inviterId, r._count._all]),
  );

  const invitees = referrals.map((r) => {
    const u = r.invitee;
    const uploads = uploadMap[u.id] || 0;
    const points = pointsMap[u.id] || {};
    const daily = dailyMap[u.id] || {};
    const referralDirect = points.REFERRAL_DIRECT?.sum || 0;
    const crawlerPts = points.crawler?.sum || 0;
    const taskClaimPts = points.TASK_CLAIM?.sum || 0;
    const checkIns = daily.CHECK_IN || 0;
    const hubVisits = daily.REWARDS_HUB_VISIT || 0;
    const outboundInvites = outboundReferralMap[u.id] || 0;

    const signals = [];
    if (uploads > 0) signals.push('HAS_UPLOAD');
    if (checkIns > 0) signals.push('CHECK_IN');
    if (hubVisits > 0) signals.push('REWARDS_HUB_VISIT');
    if (taskClaimPts > 0) signals.push('TASK_CLAIM');
    if (crawlerPts > 0) signals.push('CRAWLER_POINTS');
    if (outboundInvites > 0) signals.push('ALSO_INVITER');
    if (referralDirect > 0) signals.push('REFERRAL_EARNER');
    if (signals.length === 0) signals.push('NO_ACTIVITY');

    return {
      email: u.email,
      name: u.name,
      wallet: u.walletAddress,
      registeredAt: u.createdAt,
      referredAt: r.createdAt,
      totalPoints: u.totalPoints,
      uploads,
      uploadBySource: uploadSourceMap[u.id] || {},
      checkIns,
      hubVisits,
      taskClaimsWithRecords: taskClaimMap[u.id] || 0,
      taskClaimPts,
      crawlerPts,
      referralDirectPts: referralDirect,
      outboundInvites,
      pointSources: points,
      activitySignals: signals,
      likelyRealUser: uploads > 0 || checkIns >= 2 || crawlerPts > 0 || taskClaimPts > 50,
    };
  });

  const summary = {
    totalInvitees: invitees.length,
    withUpload: invitees.filter((i) => i.uploads > 0).length,
    withCheckIn: invitees.filter((i) => i.checkIns > 0).length,
    withHubVisit: invitees.filter((i) => i.hubVisits > 0).length,
    withTaskClaim: invitees.filter((i) => i.taskClaimPts > 0).length,
    withCrawlerPoints: invitees.filter((i) => i.crawlerPts > 0).length,
    alsoInviters: invitees.filter((i) => i.outboundInvites > 0).length,
    noActivityAtAll: invitees.filter((i) => i.activitySignals.includes('NO_ACTIVITY')).length,
    likelyRealUser: invitees.filter((i) => i.likelyRealUser).length,
    walletDuplicateCount: invitees.length - new Set(invitees.map((i) => i.wallet?.toLowerCase()).filter(Boolean)).size,
  };

  return {
    inviter: {
      email: inviter.email,
      name: inviter.name,
      code: inviter.referralCode,
      registeredAt: inviter.createdAt,
    },
    summary,
    invitees,
  };
}

async function main() {
  const emails = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_INVITER_EMAILS;
  const results = [];
  for (const email of emails) {
    results.push(await loadInviteeActivity(email));
  }

  const grand = {
    inviters: results.length,
    totalInvitees: results.reduce((s, r) => s + (r.summary?.totalInvitees || 0), 0),
    withUpload: results.reduce((s, r) => s + (r.summary?.withUpload || 0), 0),
    withCheckIn: results.reduce((s, r) => s + (r.summary?.withCheckIn || 0), 0),
    withHubVisit: results.reduce((s, r) => s + (r.summary?.withHubVisit || 0), 0),
    withTaskClaim: results.reduce((s, r) => s + (r.summary?.withTaskClaim || 0), 0),
    likelyRealUser: results.reduce((s, r) => s + (r.summary?.likelyRealUser || 0), 0),
    noActivityAtAll: results.reduce((s, r) => s + (r.summary?.noActivityAtAll || 0), 0),
  };

  console.log(JSON.stringify({ grandSummary: grand, networks: results }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
