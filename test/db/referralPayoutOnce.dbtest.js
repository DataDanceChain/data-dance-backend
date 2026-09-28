/**
 * Referral payouts happen once under concurrency, on REAL Postgres (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway, migrated database whose name contains "test").
 *
 * Point has no unique key, so "already paid?" used to be a lookup outside the payout transaction. Two
 * requests arriving together (an invitee's App sending two uploads in parallel, or a login overlapping
 * an upload) both saw no payout and both paid. What only the database can prove: the second payout
 * waits on the inviter's row lock and its re-check then sees the first payout's committed row.
 * Fixture rows use a per-run id prefix and are deleted afterwards; task progress and campaign boosts
 * are stubbed so no shared rows change.
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
const taskProgress = [];
stub('services/taskService.js', {
  recordTaskProgress: async (userId, taskId) => taskProgress.push([userId, taskId]),
});
const boosts = [];
stub('services/campaignEffects.js', {
  awardReferralBoost: async (inviterId, inviteeId) => boosts.push([inviterId, inviteeId]),
  syncRaffleTicketsForInviter: async () => ({ skipped: true }),
});

const prisma = require(src('utils/prisma.js'));
const referralService = require(src('services/referralService.js'));
const { MOTHERS_DAY_2026, MOTHERS_DAY_2026_SLUG } = require(src('constants/referralCampaigns.js'));

const RUN = `po${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const PARALLEL = 6;

async function user(name) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "User"(id, email, "referralCode", "updatedAt") VALUES ($1, $2, $3, now())',
    id(name), `${id(name)}@example.test`, id(name).toUpperCase(),
  );
}
async function bind(inviter, invitee, campaignSlug = null) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "Referral"(id, "inviterId", "inviteeId", code, "campaignSlug", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, now() - interval \'1 hour\', now())',
    id(`ref-${invitee}`), id(inviter), id(invitee), id(inviter).toUpperCase(), campaignSlug,
  );
}
async function ordinaryUpload(owner) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "CrawlerTask"(id, title, source, "userId", "updatedAt") VALUES ($1, $2, $3, $4, now())',
    id(`task-${owner}`), 'dbtest', 'amazon', id(owner),
  );
  // No importSource key: an ordinary App upload.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CrawlerData"(id, source, type, timestamp, metadata, payload, "taskId", "userId", "contentHash", "updatedAt")
     VALUES ($1, 'amazon', 'order', now(), '{}'::jsonb, '{}'::jsonb, $2, $3, $1, now())`,
    id(`cd-${owner}`), id(`task-${owner}`), id(owner),
  );
}
const points = (name) => prisma.point.findMany({ where: { userId: id(name) }, select: { amount: true, source: true, sourceId: true } });
const total = async (name) => Number((await prisma.user.findUnique({ where: { id: id(name) }, select: { totalPoints: true } })).totalPoints);

describe('referral payouts happen once under concurrency (Postgres)', () => {
  const users = ['up', 'inv', 'vee', 'mdInv', 'mdVee'];

  before(async () => {
    for (const n of users) await user(n);
    await bind('up', 'inv');
    await bind('inv', 'vee');
    await ordinaryUpload('vee');
    await bind('mdInv', 'mdVee', MOTHERS_DAY_2026_SLUG);
  });

  after(async () => {
    const ids = users.map(id);
    await prisma.point.deleteMany({ where: { userId: { in: ids } } });
    await prisma.$executeRawUnsafe('DELETE FROM "CrawlerData" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "CrawlerTask" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "Referral" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('parallel upload triggers pay the direct bonus, upline share, boost and referral-1 once', async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => referralService.onInviteeFirstValidUpload(id('vee'))),
    );

    assert.equal(results.filter((r) => r.processed).length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.alreadyProcessed).length, PARALLEL - 1, JSON.stringify(results));

    const direct = (await points('inv')).filter((p) => p.source === 'REFERRAL_DIRECT');
    assert.deepEqual(direct.map((p) => [Number(p.amount), p.sourceId]), [[150, id('vee')]]);
    assert.equal(await total('inv'), 150);

    const upline = await points('up');
    assert.equal(upline.length, 1, `upline paid ${upline.length} times`);
    assert.equal(await total('up'), Number(upline[0].amount));

    assert.deepEqual(boosts, [[id('inv'), id('vee')]]);
    assert.deepEqual(taskProgress.filter(([u, t]) => u === id('inv') && t === 'referral-1').length, 1);
  });

  it('a later trigger after the payout is still a no-op', async () => {
    assert.deepEqual(await referralService.onInviteeFirstValidUpload(id('vee')), { alreadyProcessed: true });
    assert.equal(await total('inv'), 150);
  });

  it('parallel campaign settlements pay inviter and invitee once', async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        referralService.processCampaignReferral(id('mdVee'), id('mdInv'), MOTHERS_DAY_2026_SLUG)),
    );

    assert.equal(results.filter((r) => r.skipped === false).length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.reason === 'already_processed').length, PARALLEL - 1, JSON.stringify(results));

    assert.equal((await points('mdInv')).length, 1);
    assert.equal((await points('mdVee')).length, 1);
    assert.equal(await total('mdInv'), MOTHERS_DAY_2026.inviterPoints);
    assert.equal(await total('mdVee'), MOTHERS_DAY_2026.inviteePoints);
  });
});
