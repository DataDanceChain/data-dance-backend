/**
 * Connect upload identity on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at
 * a throwaway, migrated database whose name contains "test").
 *
 * What only the database can prove: CrawlerData.contentHash is unique across the whole table and
 * (userId, source, sourceId) per user, and createMany({ skipDuplicates }) silently skips a row that
 * hits either. So: two users who saw the same post both keep it; one post under host / handle
 * variants is one record; an order keeps its own identity whatever links it holds; points go only
 * to rows really written; and the social-identity backfill rewrites old rows without deleting any.
 * Fixture rows use a per-run id prefix and are deleted afterwards. Campaign boosts and referral
 * hooks are stubbed so no shared rows change.
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
const boostCalls = [];
stub('services/campaignEffects.js', {
  awardConnectBoosts: async (tx, userId, pointsBySource) => {
    boostCalls.push({ userId, pointsBySource });
    return { extra: 0, awards: [] };
  },
});
stub('services/referralService.js', { onInviteeFirstValidUpload: async () => ({ skipped: true }) });

const prisma = require(src('utils/prisma.js'));
const { uploadCrawlerData, generateContentHash } = require(src('services/crawlerService.js'));
const { calculateDataPoints } = require(src('services/businessRulesService.js'));
const { backfillSocialPostIdentity } = require('../../scripts/backfillSocialPostIdentity');

const RUN = `cp${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
const TWEET = '18450000000000' + String(Date.now()).slice(-5);

async function user(name) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "User"(id, email, "referralCode", "updatedAt") VALUES ($1, $2, $3, now())',
    id(name), `${id(name)}@example.test`, id(name).toUpperCase(),
  );
}
const row = (source, payload, metadata = {}) => ({
  source,
  type: 'post',
  timestamp: '2026-10-01T10:00:00.000Z',
  metadata: { sourceUrl: `https://${source}.example/`, ...metadata },
  payload,
});
const upload = (name, items) => uploadCrawlerData(items.map((item) => structuredClone(item)), id(name));
const rowsOf = (name, where = {}) => prisma.crawlerData.findMany({ where: { userId: id(name), ...where } });
const crawlerPoints = async (name) =>
  (await prisma.point.findMany({ where: { userId: id(name), source: 'crawler' } })).reduce((s, p) => s + Number(p.amount), 0);

describe('Connect upload identity (Postgres)', () => {
  before(async () => {
    for (const name of USERS) await user(name);
  });

  after(async () => {
    const ids = USERS.map(id);
    await prisma.point.deleteMany({ where: { userId: { in: ids } } });
    await prisma.crawlerData.deleteMany({ where: { userId: { in: ids } } });
    await prisma.crawlerTask.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('two users with the same permalink both keep the post', async () => {
    const a = await upload('alice', [row('x', { href: `https://x.com/DataDance/status/${TWEET}`, title: 'Launch day' })]);
    // The same payload: the App strips engagement counts, so everyone who saw the post sends this.
    const b = await upload('bob', [row('x', { href: `https://x.com/DataDance/status/${TWEET}`, title: 'Launch day' })]);
    assert.deepEqual([a.uploadedCount, a.duplicatesCount], [1, 0]);
    assert.deepEqual([b.uploadedCount, b.duplicatesCount], [1, 0]);
    assert.equal((await rowsOf('alice', { source: 'x' })).length, 1);
    assert.equal((await rowsOf('bob', { source: 'x' })).length, 1);
    assert.ok(b.pointsEarned > 0);
  });

  it('X host, handle and like-count variants are one record for that user', async () => {
    const again = await upload('alice', [
      row('x', { href: `https://mobile.twitter.com/DATADANCE/status/${TWEET}/photo/1`, title: 'Launch day 120 likes' }),
      row('x', { href: `https://x.com/i/web/status/${TWEET}`, title: 'Launch day 121 likes' }),
    ]);
    assert.deepEqual([again.uploadedCount, again.duplicatesCount, again.pointsEarned], [0, 2, 0]);
    assert.equal((await rowsOf('alice', { source: 'x' })).length, 1);
  });

  it('an order with social-looking links is stored and paid once, across users', async () => {
    const order = `112-${String(Date.now()).slice(-7)}-1234567`;
    const amazon = (href) => ({ ...row('amazon', { orderid: order, title: 'Desk lamp', price: 30, currency: 'USD', href }), type: 'order' });
    const first = await upload('alice', [amazon('https://x.com/a/status/1')]);
    const second = await upload('alice', [amazon('https://x.com/a/status/2')]);
    const third = await upload('bob', [amazon('https://www.instagram.com/p/ABC123def/')]);
    assert.equal(first.uploadedCount, 1);
    assert.deepEqual([second.uploadedCount, second.pointsEarned], [0, 0]);
    assert.deepEqual([third.uploadedCount, third.pointsEarned], [0, 0]);
    const stored = await prisma.crawlerData.findMany({ where: { source: 'amazon', sourceId: order } });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].userId, id('alice'));
  });

  it('a row skipped by the insert earns nothing; the written row earns its own source points', async () => {
    const shared = row('shein', { title: `Linen shirt ${RUN}`, date: '2026-09-30', price: 20 }, { host: 'm.shein.com' });
    const carol = await upload('carol', [shared]);
    assert.equal(carol.uploadedCount, 1);

    // dave's copy of the same shop payload passes the per-user checks but its content hash is
    // already in the table, so the insert skips it; the Amazon order after it is written.
    const order = `113-${String(Date.now()).slice(-7)}-7654321`;
    boostCalls.length = 0;
    const dave = await upload('dave', [
      shared,
      { ...row('amazon', { orderid: order, title: 'Kettle', price: 40, currency: 'USD' }), type: 'order' },
    ]);
    assert.equal(dave.uploadedCount, 1);
    assert.equal(dave.duplicatesCount, 1);
    const skipped = dave.duplicateDetails.find((d) => d.reason === 'duplicate_data');
    assert.equal(skipped.index, 0);

    const amazonPoints = calculateDataPoints('amazon', 1);
    assert.deepEqual(boostCalls, [{ userId: id('dave'), pointsBySource: { amazon: amazonPoints } }]);
    assert.equal(await crawlerPoints('dave'), amazonPoints);
    assert.equal(dave.pointsEarned, amazonPoints);
    assert.deepEqual((await rowsOf('dave')).map((r) => r.source), ['amazon']);
    const tasks = await prisma.crawlerTask.findMany({ where: { userId: id('dave') }, select: { source: true, recordCount: true } });
    assert.deepEqual(tasks.filter((t) => t.recordCount > 0).map((t) => [t.source, t.recordCount]), [['amazon', 1]]);
  });

  describe('backfill of rows stored under the old identity', () => {
    const POST = `https://x.com/ErinPosts/status/${TWEET}1`;
    const FRANK_POST = `https://x.com/frank/status/${TWEET}2`;
    let task;

    // Rows exactly as the previous release stored them: the raw link as an official id, or a
    // title key that held the like count, and the hash of the whole payload.
    async function legacy(name, rowId, payload, sourceId, createdAt) {
      await prisma.crawlerData.create({
        data: {
          id: id(rowId),
          source: 'x',
          type: 'post',
          timestamp: new Date('2026-10-01T10:00:00Z'),
          metadata: { host: 'x.com' },
          payload,
          taskId: task[name],
          userId: id(name),
          contentHash: generateContentHash(payload),
          sourceId,
          createdAt,
        },
      });
    }

    before(async () => {
      task = {};
      for (const name of ['erin', 'frank']) {
        task[name] = (await prisma.crawlerTask.create({
          data: { id: id(`task-${name}`), title: 'X Posts', source: 'x', taskId: 'x_posts', userId: id(name) },
        })).id;
      }
      await legacy('erin', 'erin-1', { id: POST, href: POST, title: 'Hello 12 likes' }, POST, new Date('2026-10-02T00:00:00Z'));
      await legacy('frank', 'frank-1', { href: FRANK_POST, title: 'Trip 3 likes' }, 'title:x.com:trip 3 likes:', new Date('2026-10-02T00:00:01Z'));
      await legacy('frank', 'frank-2', { href: FRANK_POST, title: 'Trip 9 likes' }, 'title:x.com:trip 9 likes:', new Date('2026-10-02T00:00:02Z'));
    });

    const snapshot = async () =>
      (await prisma.crawlerData.findMany({
        where: { userId: { in: [id('erin'), id('frank')] } },
        orderBy: { id: 'asc' },
        select: { id: true, sourceId: true, contentHash: true },
      }));

    it('a dry run reports and writes nothing', async () => {
      const beforeRows = await snapshot();
      const report = await backfillSocialPostIdentity({ userIds: [id('erin'), id('frank')] });
      assert.equal(report.mode, 'dry-run');
      assert.deepEqual([report.scanned, report.updated, report.current], [3, 2, 0]);
      assert.deepEqual(report.conflicts.map((c) => c.id), [id('frank-2')]);
      assert.deepEqual(await snapshot(), beforeRows);
    });

    it('--apply rewrites the oldest row of each post, keeps the rest, deletes nothing', async () => {
      const report = await backfillSocialPostIdentity({ apply: true, userIds: [id('erin'), id('frank')], batch: 2 });
      assert.deepEqual([report.scanned, report.updated, report.current], [3, 2, 0]);
      // Pages of two: frank-1 was written on the first page, so the second page finds it in the table.
      assert.deepEqual(report.conflicts.map((c) => [c.id, c.keptBy]), [[id('frank-2'), id('frank-1')]]);

      const rows = await snapshot();
      assert.equal(rows.length, 3);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      assert.equal(byId[id('erin-1')].sourceId, `title:post:https://x.com/i/status/${TWEET}1`);
      assert.equal(byId[id('frank-1')].sourceId, `title:post:https://x.com/i/status/${TWEET}2`);
      assert.equal(byId[id('frank-2')].sourceId, 'title:x.com:trip 9 likes:');
    });

    it('after the backfill a re-sync of the old post is a duplicate and pays nothing', async () => {
      const resync = await upload('erin', [row('x', { href: `https://twitter.com/erinposts/status/${TWEET}1`, title: 'Hello 40 likes' })]);
      assert.deepEqual([resync.uploadedCount, resync.duplicatesCount, resync.pointsEarned], [0, 1, 0]);
      assert.equal(await crawlerPoints('erin'), 0);
    });

    it('a second run finds everything current', async () => {
      const report = await backfillSocialPostIdentity({ apply: true, userIds: [id('erin'), id('frank')] });
      assert.deepEqual([report.updated, report.current, report.conflicts.length], [0, 2, 1]);
      assert.equal(report.conflicts[0].keptBy, id('frank-1'));
    });
  });
});
