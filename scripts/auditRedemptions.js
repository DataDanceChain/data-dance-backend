/**
 * Audit all point redemptions and flag referral/upload anomalies.
 * Usage: node scripts/auditRedemptions.js
 */
const prisma = require('../src/utils/prisma');

async function main() {
  const redemptions = await prisma.point.findMany({
    where: { source: 'REWARD_REDEMPTION' },
    orderBy: { createdAt: 'asc' },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          walletAddress: true,
          totalPoints: true,
          createdAt: true,
          referralCode: true,
        },
      },
    },
  });

  const userIds = [...new Set(redemptions.map((r) => r.userId))];

  const profiles = [];
  for (const userId of userIds) {
    const user = redemptions.find((r) => r.userId === userId).user;

    const [pointsBySource, uploadCount, asInvitee, asInviter, invitees] =
      await Promise.all([
        prisma.point.groupBy({
          by: ['source'],
          where: { userId },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.crawlerData.count({ where: { userId } }),
        prisma.referral.findUnique({
          where: { inviteeId: userId },
          include: {
            inviter: { select: { id: true, email: true, name: true, referralCode: true } },
          },
        }),
        prisma.referral.count({ where: { inviterId: userId, campaignSlug: null } }),
        prisma.referral.findMany({
          where: { inviterId: userId, campaignSlug: null },
          select: {
            inviteeId: true,
            createdAt: true,
            invitee: { select: { email: true, name: true, createdAt: true } },
          },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

    const inviteeIds = invitees.map((i) => i.inviteeId);
    const inviteeUploads = inviteeIds.length
      ? await prisma.crawlerData.groupBy({
          by: ['userId'],
          where: { userId: { in: inviteeIds } },
          _count: { _all: true },
        })
      : [];
    const uploadSet = new Set(inviteeUploads.map((r) => r.userId));
    const inviteesWithUpload = uploadSet.size;
    const inviteesNoUpload = inviteeIds.length - inviteesWithUpload;

    const earnedTotal = pointsBySource.reduce((s, p) => s + (p._sum.amount || 0), 0);
    const referralDirect = pointsBySource.find((p) => p.source === 'REFERRAL_DIRECT')?._sum.amount || 0;
    const referralDirectCount = pointsBySource.find((p) => p.source === 'REFERRAL_DIRECT')?._count._all || 0;
    const taskClaim = pointsBySource.find((p) => p.source === 'TASK_CLAIM')?._sum.amount || 0;
    const crawler = pointsBySource.find((p) => p.source === 'crawler')?._sum.amount || 0;
    const upline = pointsBySource.find((p) => p.source === 'upline_reward')?._sum.amount || 0;
    const redeemed = redemptions
      .filter((r) => r.userId === userId)
      .reduce((s, r) => s + Math.abs(r.amount), 0);

    const userRedemptions = redemptions.filter((r) => r.userId === userId);

    profiles.push({
      userId,
      email: user.email,
      name: user.name,
      wallet: user.walletAddress,
      registeredAt: user.createdAt,
      referralCode: user.referralCode,
      totalPointsBalance: user.totalPoints,
      earnedTotal,
      redeemedTotal: redeemed,
      pointsBySource: Object.fromEntries(
        pointsBySource.map((p) => [p.source, { sum: p._sum.amount, count: p._count._all }]),
      ),
      uploadCount,
      referralDirectPts: referralDirect,
      referralDirectCount,
      taskClaimPts: taskClaim,
      crawlerPts: crawler,
      uplinePts: upline,
      referralPctOfEarned: earnedTotal > 0 ? Math.round((referralDirect / earnedTotal) * 100) : 0,
      invitedBy: asInvitee
        ? {
            email: asInvitee.inviter?.email,
            name: asInvitee.inviter?.name,
            code: asInvitee.code,
            at: asInvitee.createdAt,
          }
        : null,
      directInviteCount: asInviter,
      inviteesWithUpload,
      inviteesNoUpload,
      redemptions: userRedemptions.map((r) => ({
        amount: r.amount,
        sourceId: r.sourceId,
        at: r.createdAt,
      })),
      flags: [],
    });
  }

  for (const p of profiles) {
    if (p.referralPctOfEarned >= 80 && p.referralDirectCount >= 5) {
      p.flags.push('HIGH_REFERRAL_CONCENTRATION');
    }
    if (p.directInviteCount >= 5 && p.inviteesNoUpload >= p.directInviteCount * 0.7) {
      p.flags.push('MANY_INVITEES_NO_UPLOAD');
    }
    if (p.uploadCount === 0 && p.referralDirectCount > 0) {
      p.flags.push('REFERRAL_EARNINGS_ZERO_UPLOADS');
    }
    if (p.uploadCount <= 2 && p.referralDirectCount >= 10) {
      p.flags.push('LOW_UPLOAD_HIGH_REFERRALS');
    }
    if (p.directInviteCount >= 10) {
      p.flags.push('HIGH_INVITE_VOLUME');
    }
  }

  // Top inviters among all users (context)
  const topInviters = await prisma.referral.groupBy({
    by: ['inviterId'],
    where: { campaignSlug: null },
    _count: { _all: true },
    orderBy: { _count: { inviterId: 'desc' } },
    take: 15,
  });
  const inviterUsers = await prisma.user.findMany({
    where: { id: { in: topInviters.map((t) => t.inviterId) } },
    select: { id: true, email: true, name: true },
  });
  const inviterMap = Object.fromEntries(inviterUsers.map((u) => [u.id, u]));

  console.log(JSON.stringify({
    summary: {
      redemptionRecords: redemptions.length,
      uniqueRedeemers: userIds.length,
      totalRedeemedPoints: redemptions.reduce((s, r) => s + Math.abs(r.amount), 0),
      flaggedRedeemers: profiles.filter((p) => p.flags.length > 0).length,
    },
    redeemers: profiles,
    topStandardInviters: topInviters.map((t) => ({
      email: inviterMap[t.inviterId]?.email,
      name: inviterMap[t.inviterId]?.name,
      inviteCount: t._count._all,
      isRedeemer: userIds.includes(t.inviterId),
    })),
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
