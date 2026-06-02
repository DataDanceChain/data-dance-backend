/**
 * Deep referral fraud signals for redeemers and top inviters.
 */
const prisma = require('../src/utils/prisma');

async function main() {
  const redeemerEmails = [
    'oxmdshifat@gmail.com',
    'donfilex459@gmail.com',
    'hralpin22@gmail.com',
    'vaik1625@gmail.com',
    'monxcataa@gmail.com',
    'sakibr1997sakib@gmail.com',
    'denz.eldee008@gmail.com',
  ];

  const users = await prisma.user.findMany({
    where: { email: { in: redeemerEmails } },
    select: { id: true, email: true, createdAt: true },
  });
  const idByEmail = Object.fromEntries(users.map((u) => [u.email, u.id]));

  const networkAnalysis = [];
  for (const email of redeemerEmails) {
    const inviterId = idByEmail[email];
    if (!inviterId) continue;

    const invitees = await prisma.referral.findMany({
      where: { inviterId, campaignSlug: null },
      include: {
        invitee: { select: { email: true, createdAt: true, walletAddress: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const days = {};
    for (const r of invitees) {
      const d = r.createdAt.toISOString().slice(0, 10);
      days[d] = (days[d] || 0) + 1;
    }
    const peakDay = Object.entries(days).sort((a, b) => b[1] - a[1])[0];

    const inviteeIds = invitees.map((i) => i.inviteeId);
    const uploads = inviteeIds.length
      ? await prisma.crawlerData.groupBy({
          by: ['userId'],
          where: { userId: { in: inviteeIds } },
          _count: { _all: true },
        })
      : [];

    networkAnalysis.push({
      email,
      directInvites: invitees.length,
      inviteesWithAnyUpload: uploads.length,
      inviteeUploadRatePct: invitees.length
        ? Math.round((uploads.length / invitees.length) * 100)
        : 0,
      peakSignupDay: peakDay ? { date: peakDay[0], count: peakDay[1] } : null,
      signupDaysActive: Object.keys(days).length,
      firstInviteAt: invitees[0]?.createdAt,
      lastInviteAt: invitees[invitees.length - 1]?.createdAt,
    });
  }

  // Cross-links: who invited the redeemers
  const inviteChains = await Promise.all(
    redeemerEmails.map(async (email) => {
      const u = await prisma.user.findUnique({
        where: { email },
        select: {
          email: true,
          createdAt: true,
          invitesReceived: {
            include: {
              inviter: { select: { email: true } },
            },
          },
        },
      });
      return {
        email,
        registeredAt: u?.createdAt,
        invitedBy: u?.invitesReceived?.inviter?.email || null,
      };
    }),
  );

  // Global: standard referrals with zero uploads across platform
  const totalStandardReferrals = await prisma.referral.count({ where: { campaignSlug: null } });
  const allInviteeIds = (
    await prisma.referral.findMany({
      where: { campaignSlug: null },
      select: { inviteeId: true },
    })
  ).map((r) => r.inviteeId);
  const uniqueInvitees = [...new Set(allInviteeIds)];
  const withUpload = await prisma.crawlerData.groupBy({
    by: ['userId'],
    where: { userId: { in: uniqueInvitees } },
  });

  // Referral DIRECT points issued vs invite count
  const directPointRows = await prisma.point.count({ where: { source: 'REFERRAL_DIRECT' } });

  console.log(
    JSON.stringify(
      {
        platform: {
          totalStandardReferrals,
          uniqueInvitees: uniqueInvitees.length,
          inviteesWithUpload: withUpload.length,
          inviteeUploadRatePct: Math.round((withUpload.length / uniqueInvitees.length) * 100),
          referralDirectPointRecords: directPointRows,
        },
        redeemerInviteNetworks: networkAnalysis,
        redeemerInviteChains: inviteChains,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
