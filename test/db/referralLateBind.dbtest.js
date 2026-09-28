/**
 * Late-bound referral rewards on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at
 * a throwaway, migrated database whose name contains "test").
 *
 * Rule (Sloan, 2026-09-28): 后绑码的邀请关系方面的奖励只算绑定后的 — when a registered user binds an
 * inviter later, referral rewards count only the invitee's activity at or after the bind
 * (Referral.createdAt). What only the database can prove: the bind-time `createdAt >= since` filter
 * combined with the data-pack JSON exclusion, the per-invitee `groupBy … _max(createdAt)` cutoff, and
 * the real referral-code lookup in POST /api/referrals/use-code. Fixture rows use a per-run id prefix
 * and are deleted afterwards; task progress and campaign boosts are stubbed so no shared rows change.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const src = (rel) => path.join(__dirname, '../../src', rel);
const stub = (rel, exportsValue) => {
  const filename = require.resolve(src(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};
// Keep shared tables (UserTask, campaign rows, raffle tickets) untouched: only Point/Referral/CrawlerData
// rows of this run's users are written.
const taskProgress = [];
stub('services/taskService.js', {
  recordTaskProgress: async (userId, taskId) => taskProgress.push([userId, taskId]),
});
stub('services/campaignEffects.js', {
  awardReferralBoost: async () => ({ skipped: true }),
  syncRaffleTicketsForInviter: async () => ({ skipped: true }),
});

const prisma = require(src('utils/prisma.js'));
const referralService = require(src('services/referralService.js'));

const RUN = `lb${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const code = (name) => `${RUN}${name}`.toUpperCase();
const SECOND = 1000;
const HOUR = 3600 * SECOND;

async function user(name) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "User"(id, email, "referralCode", "updatedAt") VALUES ($1, $2, $3, now())',
    id(name), `${id(name)}@example.test`, code(name),
  );
}

// Fixture uploads carry an explicit non-data-pack importSource. On Postgres the existing exclusion
// `NOT (metadata.importSource = 'data-pack')` is NULL — so the row is dropped — when the key is absent
// entirely; that pre-existing behaviour is outside this test, which is about the bind-time cutoff.
const APP_UPLOAD = { importSource: 'app', sourceUrl: 'https://example.test/order' };

let seq = 0;
async function upload(name, createdAt, metadata = APP_UPLOAD) {
  seq += 1;
  await prisma.crawlerData.create({
    data: {
      source: 'amazon',
      type: 'order',
      timestamp: createdAt,
      metadata,
      payload: {},
      taskId: id('task'),
      userId: id(name),
      contentHash: `${RUN}-hash-${seq}`,
      sourceId: `${RUN}-src-${seq}`,
      createdAt,
    },
  });
}

async function bindTime(name) {
  const row = await prisma.referral.findUnique({ where: { inviteeId: id(name) }, select: { createdAt: true } });
  return row.createdAt;
}

const directBonus = (inviter) =>
  prisma.point.findMany({ where: { userId: id(inviter), source: 'REFERRAL_DIRECT' }, select: { amount: true, sourceId: true } });

describe('late-bound referral rewards on Postgres', () => {
  const users = ['a', 'b', 'c', 'd', 'e', 'f'];

  before(async () => {
    for (const n of users) await user(n);
    await prisma.crawlerTask.create({ data: { id: id('task'), title: 'late-bind dbtest', source: 'amazon', userId: id('a') } });
    await prisma.$executeRawUnsafe(
      'INSERT INTO "Referral"(id, "inviterId", "inviteeId", code, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, now() - interval \'10 hours\', now())',
      id('ref-a-b'), id('a'), id('b'), code('a'),
    );
  });

  after(async () => {
    const ids = users.map(id);
    await prisma.point.deleteMany({ where: { userId: { in: ids } } });
    await prisma.crawlerData.deleteMany({ where: { userId: { in: ids } } });
    await prisma.crawlerTask.deleteMany({ where: { id: id('task') } });
    await prisma.referral.deleteMany({ where: { OR: [{ inviteeId: { in: ids } }, { inviterId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('use-code after pre-bind uploads pays nothing; the first post-bind upload pays inviter + upline once', async () => {
    await upload('c', new Date(Date.now() - HOUR));

    await referralService.useReferralCode(id('c'), code('b'));
    assert.deepEqual(await directBonus('b'), [], 'no bonus at bind for pre-bind activity');
    assert.deepEqual(taskProgress, []);

    // A data-pack import after the bind is personal inventory, never a qualifying upload.
    await upload('c', new Date((await bindTime('c')).getTime() + SECOND), { importSource: 'data-pack' });
    assert.deepEqual(await referralService.onInviteeFirstValidUpload(id('c')), { deferred: true });

    await upload('c', new Date((await bindTime('c')).getTime() + 2 * SECOND));
    assert.deepEqual(await referralService.onInviteeFirstValidUpload(id('c')), { processed: true });
    assert.deepEqual(await directBonus('b'), [{ amount: 150, sourceId: id('c') }]);
    const upline = await prisma.point.findMany({ where: { userId: id('a'), source: 'upline_reward' }, select: { amount: true } });
    assert.deepEqual(upline, [{ amount: 15 }]);

    // Idempotent: a further upload never pays again.
    await upload('c', new Date((await bindTime('c')).getTime() + 3 * SECOND));
    assert.deepEqual(await referralService.onInviteeFirstValidUpload(id('c')), { alreadyProcessed: true });
    assert.equal((await directBonus('b')).length, 1);
  });

  it('referral overview: each invitee qualifies only through an upload at or after their own bind', async () => {
    // b (bound 10h ago) uploaded 9h ago → qualified; d uploaded 3h ago, bound to b now → not yet.
    await upload('b', new Date(Date.now() - 9 * HOUR));
    await upload('d', new Date(Date.now() - 3 * HOUR));
    await referralService.useReferralCode(id('d'), code('b'));

    const before = await referralService.getReferralOverview(id('b'));
    const nodeD = before.referrals.find((n) => n.id === id('d'));
    assert.equal(nodeD.qualified, false);
    assert.equal(before.referrals.find((n) => n.id === id('c')).qualified, true);
    assert.equal(before.qualifiedLevelCounts[1], 1);

    await upload('d', new Date((await bindTime('d')).getTime() + SECOND));
    const afterUpload = await referralService.getReferralOverview(id('b'));
    assert.equal(afterUpload.referrals.find((n) => n.id === id('d')).qualified, true);
    assert.equal(afterUpload.qualifiedLevelCounts[1], 2);
    // a sees b at level 1 (qualified since its 9h-old upload) and c, d at level 2.
    const forA = await referralService.getReferralOverview(id('a'));
    assert.deepEqual(forA.qualifiedLevelCounts, { 1: 1, 2: 2, 3: 0, 4: 0 });
  });

  it('a bonus paid at signup with no upload (pre-2026-06-02 rule) never qualifies the invitee', async () => {
    await prisma.referral.create({ data: { inviterId: id('b'), inviteeId: id('f'), code: code('b') } });
    await prisma.point.create({ data: { userId: id('b'), amount: 150, source: 'REFERRAL_DIRECT', sourceId: id('f') } });
    const qualifiedF = async () => (await referralService.getReferralOverview(id('b'))).referrals.find((n) => n.id === id('f')).qualified;
    assert.equal(await qualifiedF(), false);
    await upload('f', new Date((await bindTime('f')).getTime() + SECOND), { importSource: 'data-pack' });
    assert.equal(await qualifiedF(), false, 'a data-pack seed is not an upload');
    await upload('f', new Date((await bindTime('f')).getTime() + 2 * SECOND));
    assert.equal(await qualifiedF(), true);
  });

  it('a user who registered with a code is unchanged: first upload pays', async () => {
    await prisma.referral.create({ data: { inviterId: id('b'), inviteeId: id('e'), code: code('b') } });
    assert.deepEqual(await referralService.processReferral(id('e'), id('b'), code('b')), { deferred: true });
    await upload('e', new Date((await bindTime('e')).getTime() + SECOND));
    assert.deepEqual(await referralService.onInviteeFirstValidUpload(id('e')), { processed: true });
    assert.equal((await directBonus('b')).filter((p) => p.sourceId === id('e')).length, 1);
  });
});
