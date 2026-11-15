/**
 * Deduct unqualified social points for the 35 accounts reviewed on 12 Nov 2026,
 * then pay the announced 750-point goodwill where points were actually removed.
 *
 * Kept on purpose:
 *   malang26042001@gmail.com  posts on x.com/KangDien_Wae
 *   suppercell56@gmail.com    posts on reddit.com/user/bheghe/submitted
 * Orders, travel pages, tasks and sign-in are not social rows, so they stay.
 * Redeemed points are not pulled below zero.
 *
 *   node scripts/adjustReviewedSocialPoints.js            # dry run
 *   node scripts/adjustReviewedSocialPoints.js --apply
 */

const { PrismaClient } = require('@prisma/client');
const { isSocialCrawlerSource } = require('../src/constants/crawlerSources');
const { reviewedSocialLedger, GOODWILL_POINTS } = require('../src/services/reviewedSocialLedger');

const DEDUCT_SOURCE_ID = 'social-review-20261112__non-own-social';
const GOODWILL_SOURCE_ID = 'social-review-20261112__goodwill-750';

const EMAILS = [
  'darmavm@gmail.com',
  'rizkirahman056@gmail.com',
  'malang26042001@gmail.com',
  'sicxaaa@gmail.com',
  'asoipadeh@gmail.com',
  'zepettozeo@gmail.com',
  'acekaler@gmail.com',
  'suppercell56@gmail.com',
  'curva.damascus@gmail.com',
  'garisanku@gmail.com',
  'kringanjala@gmail.com',
  'ferryduwiyanto477@gmail.com',
  'calmeuus@gmail.com',
  'hondajazz278@gmail.com',
  'nawalnajwaazzahra@gmail.com',
  'yogaheru2121@gmail.com',
  'bintangpanter8@gmail.com',
  '0xshannn@gmail.com',
  'ktsuardika83@gmail.com',
  'kisworo891@gmail.com',
  'anggajne25@gmail.com',
  'boiminudik@gmail.com',
  'jhonjohan077@gmail.com',
  'kangzoronih@gmail.com',
  'andipratama171193@gmail.com',
  'wijanarkomezzoo@gmail.com',
  'menungguwd@gmail.com',
  'yudhaekasaputra1@gmail.com',
  'jeckdevil72@gmail.com',
  'bubarjalan15@gmail.com',
  'sleepinginvestor21@gmail.com',
  'kapitraemperan@gmail.com',
  'rheivannaufal@gmail.com',
  'mariacre16@gmail.com',
  'yulisintianti@gmail.com',
];

const prisma = new PrismaClient();

function pagePath(metadata) {
  const raw = metadata && metadata.sourceUrl;
  if (!raw) return '';
  try {
    return new URL(String(raw)).pathname || '';
  } catch {
    return '';
  }
}

function isKeptSocial(email, source, metadata) {
  const path = pagePath(metadata);
  if (email === 'malang26042001@gmail.com' && source === 'x' && /^\/kangdien_wae(?:\/|$)/i.test(path)) {
    return true;
  }
  if (email === 'suppercell56@gmail.com' && source === 'reddit' && /^\/user\/bheghe\/(?:submitted|posts|comments)\/?$/i.test(path)) {
    return true;
  }
  return false;
}

async function loadRows(userId) {
  const rows = [];
  let cursor;
  for (;;) {
    const page = await prisma.crawlerData.findMany({
      where: { userId },
      take: 300,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, source: true, metadata: true },
    });
    if (!page.length) break;
    rows.push(...page);
    cursor = page[page.length - 1].id;
    if (page.length < 300) break;
  }
  return rows;
}

async function planAccount(user) {
  const existing = await prisma.point.findFirst({
    where: { userId: user.id, source: 'OPS_ADJUSTMENT', sourceId: DEDUCT_SOURCE_ID },
    select: { id: true },
  });
  if (existing) {
    return { email: user.email, skipped: 'already adjusted' };
  }
  const rows = await loadRows(user.id);
  let badSocialRows = 0;
  let keptSocialRows = 0;
  for (const row of rows) {
    if (!isSocialCrawlerSource(row.source)) continue;
    if (isKeptSocial(user.email, row.source, row.metadata)) keptSocialRows += 1;
    else badSocialRows += 1;
  }
  const points = await prisma.point.groupBy({
    by: ['source'],
    where: { userId: user.id },
    _sum: { amount: true },
  });
  let ledgerSum = 0;
  let crawlerPoints = 0;
  for (const row of points) {
    const amount = row._sum.amount || 0;
    ledgerSum += amount;
    if (row.source === 'crawler') crawlerPoints += amount;
  }
  const plan = reviewedSocialLedger({
    totalPoints: user.totalPoints,
    ledgerSum,
    crawlerPoints,
    crawlerRows: rows.length,
    badSocialRows,
  });
  return {
    email: user.email,
    userId: user.id,
    rows: rows.length,
    badSocialRows,
    keptSocialRows,
    totalPoints: user.totalPoints,
    ...plan,
  };
}

async function applyAccount(entry) {
  await prisma.$transaction(async (tx) => {
    const again = await tx.point.findFirst({
      where: { userId: entry.userId, source: 'OPS_ADJUSTMENT', sourceId: DEDUCT_SOURCE_ID },
      select: { id: true },
    });
    if (again) throw new Error(`already adjusted: ${entry.email}`);
    if (entry.deduction > 0) {
      await tx.point.create({
        data: {
          userId: entry.userId,
          amount: -entry.deduction,
          source: 'OPS_ADJUSTMENT',
          sourceId: DEDUCT_SOURCE_ID,
        },
      });
    }
    if (entry.goodwill > 0) {
      await tx.point.create({
        data: {
          userId: entry.userId,
          amount: entry.goodwill,
          source: 'OPS_ADJUSTMENT',
          sourceId: GOODWILL_SOURCE_ID,
        },
      });
    }
    await tx.user.update({
      where: { id: entry.userId },
      data: { totalPoints: entry.nextTotal },
    });
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  const users = await prisma.user.findMany({
    where: { email: { in: EMAILS } },
    select: { id: true, email: true, totalPoints: true },
  });
  const found = new Set(users.map((user) => user.email));
  const missing = EMAILS.filter((email) => !found.has(email));
  if (missing.length) {
    console.error(JSON.stringify({ missing }));
    process.exit(1);
  }
  const plans = [];
  for (const user of users) plans.push(await planAccount(user));
  const refused = plans.filter((plan) => plan.ok === false);
  console.log(JSON.stringify({
    apply,
    goodwill: GOODWILL_POINTS,
    accounts: plans.map((plan) => ({
      email: plan.email,
      skipped: plan.skipped || '',
      rows: plan.rows,
      badSocialRows: plan.badSocialRows,
      keptSocialRows: plan.keptSocialRows,
      totalPoints: plan.totalPoints,
      deduction: plan.deduction,
      goodwill: plan.goodwill,
      nextTotal: plan.nextTotal,
      reason: plan.reason || '',
    })),
  }));
  if (refused.length) {
    console.error(`refusing to write: ${refused.length} account(s) did not match the 10-point ledger`);
    process.exit(1);
  }
  if (!apply) return;
  for (const plan of plans) {
    if (plan.skipped) continue;
    await applyAccount(plan);
    console.error(`applied ${plan.email} ${plan.totalPoints} -> ${plan.nextTotal}`);
  }
}

main()
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
