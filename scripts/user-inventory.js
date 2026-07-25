const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const total = await p.user.count();
  const byAuth = await p.user.groupBy({ by: ['authType'], _count: { _all: true } });
  const byUserType = await p.user.groupBy({ by: ['userType'], _count: { _all: true } });
  const withWallet = await p.user.count({ where: { walletAddress: { not: null } } });
  const noWallet = await p.user.count({ where: { walletAddress: null } });
  const org = await p.user.count({
    where: { OR: [{ isOrganization: true }, { userType: 'organization' }] },
  });

  const web3NoWallet = await p.user.count({
    where: { authType: 'web3auth', walletAddress: null },
  });
  const web3WithWallet = await p.user.count({
    where: { authType: 'web3auth', walletAddress: { not: null } },
  });
  const traditionalNoWallet = await p.user.count({
    where: { authType: 'traditional', walletAddress: null },
  });
  const traditionalWithWallet = await p.user.count({
    where: { authType: 'traditional', walletAddress: { not: null } },
  });

  const seededRows = await p.crawlerData.count({
    where: { metadata: { path: ['importSource'], equals: 'data-pack' } },
  });
  const seededUsers = await p.crawlerData.groupBy({
    by: ['userId'],
    where: { metadata: { path: ['importSource'], equals: 'data-pack' } },
  });
  const seededUserIds = seededUsers.map((u) => u.userId);

  let seededWithWallet = 0;
  let seededNoWallet = 0;
  const batch = 5000;
  for (let i = 0; i < seededUserIds.length; i += batch) {
    const chunk = seededUserIds.slice(i, i + batch);
    const rows = await p.user.findMany({
      where: { id: { in: chunk } },
      select: { walletAddress: true },
    });
    for (const r of rows) {
      if (r.walletAddress) seededWithWallet += 1;
      else seededNoWallet += 1;
    }
  }

  const organicRows = await p.crawlerData.count({
    where: { NOT: { metadata: { path: ['importSource'], equals: 'data-pack' } } },
  });
  const organicUsers = await p.crawlerData.groupBy({
    by: ['userId'],
    where: { NOT: { metadata: { path: ['importSource'], equals: 'data-pack' } } },
  });

  const byCrawlerSource = await p.$queryRaw`
    SELECT source, COUNT(*)::int AS rows, COUNT(DISTINCT "userId")::int AS users
    FROM "CrawlerData"
    GROUP BY source
    ORDER BY rows DESC
  `;

  const byImportBatch = await p.$queryRaw`
    SELECT COALESCE(metadata->>'importBatch', '(none)') AS batch,
           COUNT(*)::int AS rows,
           COUNT(DISTINCT "userId")::int AS users
    FROM "CrawlerData"
    GROUP BY 1
    ORDER BY rows DESC
  `;

  const canUpload = await p.user.count({
    where: {
      isOrganization: false,
      userType: { not: 'organization' },
    },
  });

  const withX = await p.user.count({ where: { xid: { not: null } } });

  console.log(
    JSON.stringify(
      {
        totalUsers: total,
        organizationUsers: org,
        regularUsers: total - org,
        canUploadPersonalData: canUpload,
        wallet: { withWallet, noWallet },
        withXAccount: withX,
        authChannels: {
          web3auth_with_wallet: web3WithWallet,
          web3auth_no_wallet: web3NoWallet,
          traditional_with_wallet: traditionalWithWallet,
          traditional_no_wallet: traditionalNoWallet,
          byAuthType: byAuth,
          byUserType,
        },
        dataPackSeeded: {
          users: seededUsers.length,
          rows: seededRows,
          withWallet: seededWithWallet,
          noWallet: seededNoWallet,
        },
        organicUploads: {
          users: organicUsers.length,
          rows: organicRows,
        },
        crawlerBySource: byCrawlerSource,
        crawlerByImportBatch: byImportBatch,
      },
      null,
      2
    )
  );
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
