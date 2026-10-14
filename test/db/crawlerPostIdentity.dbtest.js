/**
 * Connect upload identity on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at
 * a throwaway, migrated database whose name contains "test").
 *
 * What only the database can prove: CrawlerData.contentHash is unique across the whole table and
 * (userId, source, sourceId) per user, and createMany({ skipDuplicates }) silently skips a row that
 * hits either. So: two users who saw the same post both keep it; one post under host / handle
 * variants is one record; an order keeps its own identity whatever links it holds; points go only
 * to rows really written; the social-identity backfill rewrites old rows without deleting any; and
 * the record backfill gives rows of other sources stored under a post link key their order / title
 * identity back, keeps the earliest copy of one record as its holder and marks the others
 * superseded, without deleting a row or changing a point. Fixture rows use a per-run id prefix and are deleted afterwards. Campaign boosts and referral
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
const {
  backfillSocialPostIdentity,
  backfillRecordIdentity,
  supersededIdentity,
} = require('../../scripts/backfillSocialPostIdentity');

const RUN = `cp${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gail'];
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

    it('a post a sync stores during the run is left as a conflict; the rest of the page is written', async () => {
      const posts = [1, 2].map((n) => `https://x.com/gail/status/${TWEET}${n + 2}`);
      const gailTask = await prisma.crawlerTask.create({
        data: { id: id('task-gail'), title: 'X Posts', source: 'x', taskId: 'x_posts', userId: id('gail') },
      });
      for (const [i, href] of posts.entries()) {
        const payload = { href, title: `Gail ${i} 5 likes` };
        await prisma.crawlerData.create({
          data: {
            id: id(`gail-${i}`), source: 'x', type: 'post', timestamp: new Date('2026-10-01T10:00:00Z'), metadata: { host: 'x.com' },
            payload, taskId: gailTask.id, userId: id('gail'), contentHash: generateContentHash(payload), sourceId: href,
            createdAt: new Date(`2026-10-02T00:00:0${i}Z`),
          },
        });
      }
      // Right before the page is written, a sync stores the first post under its new identity.
      let synced = false;
      const client = new Proxy(prisma, {
        get(target, prop) {
          if (prop !== '$queryRaw') return target[prop];
          return async (strings, ...values) => {
            if (!synced && strings.join('').includes('UPDATE "CrawlerData"')) {
              synced = true;
              const payload = { href: posts[0], title: 'Gail 0 6 likes' };
              await prisma.crawlerData.create({
                data: {
                  id: id('gail-sync'), source: 'x', type: 'post', timestamp: new Date(), metadata: { host: 'x.com' }, payload,
                  taskId: gailTask.id, userId: id('gail'), contentHash: generateContentHash(payload, { source: 'x', userId: id('gail') }),
                  sourceId: `title:post:https://x.com/i/status/${TWEET}3`,
                },
              });
            }
            return target.$queryRaw(strings, ...values);
          };
        },
      });
      const report = await backfillSocialPostIdentity({ client, apply: true, userIds: [id('gail')] });
      assert.equal(synced, true);
      // the synced row is read on the next page, already current
      assert.deepEqual([report.scanned, report.updated, report.current], [3, 1, 1]);
      assert.deepEqual(report.conflicts.map((c) => [c.id, c.keptBy]), [[id('gail-0'), 'row stored or changed during the run']]);
      const rows = Object.fromEntries((await rowsOf('gail')).map((r) => [r.id, r.sourceId]));
      assert.equal(rows[id('gail-0')], posts[0]);
      assert.equal(rows[id('gail-1')], `title:post:https://x.com/i/status/${TWEET}4`);
    });
  });

  describe('backfill of records stored under a post link key', () => {
    const NAMES = ['ann', 'ben', 'cat', 'dan', 'inv'];
    const ids = NAMES.map(id);
    const short = (rowId) => rowId.slice(RUN.length + 1);
    const order = (n) => `${n}${n}${n}-${RUN}-0000${n}`;
    const at = (s) => new Date(`2026-10-12T01:00:${String(s).padStart(2, '0')}.000Z`);
    const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
    const amazonMeta = { sourceUrl: 'https://www.amazon.com/gp/css/order-history' };
    const amazonPayload = (orderid, href) => ({ orderid, title: 'Desk lamp', price: '30.00', currency: 'USD', ...(href ? { href } : {}) });
    const bookingMeta = { sourceUrl: 'https://secure.booking.com/mytrips' };
    const bookingPayload = (href) => ({ bookingId: `BK-${RUN}`, hotelName: 'Harbour Hotel', checkIn: '2026-09-01', href });
    const temuMeta = { sourceUrl: 'https://www.temu.com/bgt_order.html' };
    const temuPayload = { title: `Socks ${RUN}`, href: 'https://x.com/t/status/7' };
    // Metadata with a host of its own: the key uses that host.
    const amazonPostMeta = { ...amazonMeta, host: 'post' };
    const sheinMeta = { sourceUrl: 'https://m.shein.com/user/orders', host: 'superseded' };
    const sheinPayload = (href) => ({ orderId: `SH-20-${RUN}`, title: 'Linen shirt', price: '20.00', href });
    // Social rows whose link is not a post permalink (a redirect link): a record with a title key.
    const xMeta = { sourceUrl: 'https://x.com/home' };
    const xRedirect = { href: 'https://t.co/r1?u=https://x.com/a/status/41', title: `Morning run ${RUN}` };
    const xPostMeta = { ...xMeta, host: 'post' };
    const xRedirectPost = { href: 'https://t.co/r2?u=https://x.com/a/status/42', title: `Evening run ${RUN}` };
    const task = {};

    // A row exactly as stored: under a post link key with the hash of the link, or under its order
    // id with the hash of the payload.
    async function stored(rowId, name, source, payload, metadata, sourceId, contentHash, createdAt) {
      const key = `${name}:${source}`;
      task[key] ||= (await prisma.crawlerTask.create({
        data: { id: id(`task-${name}-${source}`), title: source, source, taskId: `${source}_orders`, userId: id(name) },
      })).id;
      await prisma.crawlerData.create({
        data: {
          id: id(rowId), source, type: 'order', timestamp: new Date('2026-10-01T10:00:00Z'), metadata, payload,
          taskId: task[key], userId: id(name), contentHash, sourceId, createdAt,
        },
      });
    }
    const linked = (rowId, name, source, payload, metadata, link, createdAt) => {
      const host = metadata.host || new URL(metadata.sourceUrl).hostname.replace(/^www\./, '');
      return stored(rowId, name, source, payload, metadata, `title:${host}:${link}`, sha(JSON.stringify({ postUrl: link })), createdAt);
    };
    // The Point rows of one upload carry the same createdAt as its rows.
    const paid = (name, amount, source, sourceId, createdAt) =>
      prisma.point.create({ data: { userId: id(name), amount, source, sourceId, createdAt } });

    const snapshot = () =>
      prisma.crawlerData.findMany({ where: { userId: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, sourceId: true, contentHash: true } });
    const pointsSnapshot = async () => ({
      points: await prisma.point.findMany({ where: { userId: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, amount: true } }),
      totals: await prisma.user.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, totalPoints: true } }),
    });

    before(async () => {
      for (const name of NAMES) await user(name);
      await prisma.referral.create({ data: { inviterId: id('inv'), inviteeId: id('ben'), code: id('inv') } });

      const o1 = amazonPayload(order(1));
      await stored('ann-o1', 'ann', 'amazon', o1, amazonMeta, order(1), generateContentHash(o1), at(0));
      await linked('ben-o1', 'ben', 'amazon', amazonPayload(order(1), 'https://x.com/someone/status/111'), amazonMeta, 'https://x.com/someone/status/111', at(1));
      await paid('ben', 10, 'crawler', 'data_upload', at(1));
      await paid('ben', 10, 'CAMPAIGN_CONNECT_BOOST', 'c1', at(1));
      await paid('inv', 1, 'upline_reward', 'crawler_data_upload', at(1));

      await linked('ben-o2', 'ben', 'amazon', amazonPayload(order(2), 'https://www.instagram.com/p/AbC123/'), amazonMeta, 'https://instagram.com/p/AbC123', at(2));
      await linked('dan-o2-link', 'dan', 'amazon', amazonPayload(order(2), 'https://www.threads.net/@h/post/XyZ9'), amazonMeta, 'https://threads.net/@h/post/XyZ9', at(3));
      await paid('dan', 10, 'crawler', 'data_upload', at(3));
      const d2 = amazonPayload(order(2));
      await stored('dan-o2', 'dan', 'amazon', d2, amazonMeta, order(2), generateContentHash(d2), at(4));
      await paid('dan', 10, 'crawler', 'data_upload', at(4));

      await linked('cat-temu', 'cat', 'temu', temuPayload, temuMeta, 'https://x.com/t/status/7', at(5));
      await linked('cat-bk-1', 'cat', 'booking', bookingPayload('https://www.tiktok.com/@h/video/1001'), bookingMeta, 'https://tiktok.com/@h/video/1001', at(6));
      await linked('cat-bk-2', 'cat', 'booking', bookingPayload('https://www.tiktok.com/@h/video/1002'), bookingMeta, 'https://tiktok.com/@h/video/1002', at(7));
      // a second row in that upload: its batch Point is shared by both rows
      const luma = { eventId: `evt-${RUN}`, title: 'Meetup' };
      await stored('cat-luma', 'cat', 'luma', luma, { sourceUrl: 'https://lu.ma/home' }, `evt-${RUN}`, generateContentHash(luma), at(7));
      await paid('cat', 20, 'crawler', 'data_upload', at(7));

      await linked('ann-o3', 'ann', 'amazon', amazonPayload(order(3), 'https://x.com/z/status/6'), amazonMeta, 'https://x.com/z/status/6', at(8));
      // a social post under the same kind of key belongs to the social backfill and stays as it is here
      await linked('ann-post', 'ann', 'x', { href: 'https://x.com/ann/status/123', caption: 'hi' }, { sourceUrl: 'https://x.com/' }, 'https://x.com/ann/status/123', at(9));

      // orders whose metadata names the host 'post' or 'superseded'
      await linked('ben-o7-1', 'ben', 'amazon', amazonPayload(order(7), 'https://x.com/p/status/71'), amazonPostMeta, 'https://x.com/p/status/71', at(10));
      await paid('ben', 10, 'crawler', 'data_upload', at(10));
      await linked('ben-o7-2', 'ben', 'amazon', amazonPayload(order(7), 'https://x.com/p/status/72'), amazonPostMeta, 'https://x.com/p/status/72', at(11));
      await paid('ben', 10, 'crawler', 'data_upload', at(11));
      await linked('cat-sh-1', 'cat', 'shein', sheinPayload('https://www.instagram.com/p/Shirt01/'), sheinMeta, 'https://instagram.com/p/Shirt01', at(12));
      await paid('cat', 10, 'crawler', 'data_upload', at(12));
      await linked('cat-sh-2', 'cat', 'shein', sheinPayload('https://www.instagram.com/p/Shirt02/'), sheinMeta, 'https://instagram.com/p/Shirt02', at(13));
      await paid('cat', 10, 'crawler', 'data_upload', at(13));

      await linked('dan-x-1', 'dan', 'x', xRedirect, xMeta, 'https://t.co/r1', at(14));
      await linked('dan-x-2', 'dan', 'x', xRedirectPost, xPostMeta, 'https://t.co/r2', at(15));
    });

    after(async () => {
      await prisma.point.deleteMany({ where: { userId: { in: ids } } });
      await prisma.crawlerData.deleteMany({ where: { userId: { in: ids } } });
      await prisma.crawlerTask.deleteMany({ where: { userId: { in: ids } } });
      await prisma.referral.deleteMany({ where: { inviteeId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    });

    const counts = (r) => ({
      linkKeyRows: r.linkKeyRows, records: r.records, restored: r.restored, restoredByKind: r.restoredByKind,
      heldAlready: r.heldAlready, superseded: r.superseded, supersededLinkKey: r.supersededLinkKey,
      supersededStored: r.supersededStored, conflicts: r.conflicts.length,
    });
    const expected = {
      linkKeyRows: 13, records: 9, restored: 8, restoredByKind: { order: 5, title: 3, content: 0 },
      heldAlready: 1, superseded: 6, supersededLinkKey: 5, supersededStored: 1, conflicts: 0,
    };
    // per user: [superseded rows, base points, bonus points, upline points, rows without a batch Point]
    const perUser = (r) => Object.fromEntries(r.users.map((u) => [short(u.userId), [u.rows, u.base, u.bonus, u.upline, u.noBatch]]));
    const expectedPoints = { ben: [2, 20, 10, 1, 0], dan: [2, 20, 0, 0, 0], cat: [2, 20, 0, 0, 0] };

    it('a dry run reports the plan and writes nothing', async () => {
      const rows = await snapshot();
      const points = await pointsSnapshot();
      const report = await backfillRecordIdentity({ userIds: ids });
      assert.equal(report.mode, 'dry-run');
      assert.deepEqual(counts(report), expected);
      // exact match for superseded rows
      assert.equal(report.alreadySuperseded, 0);
      assert.deepEqual(perUser(report), expectedPoints);
      assert.deepEqual(await snapshot(), rows);
      assert.deepEqual(await pointsSnapshot(), points);
    });

    it('--apply restores the earliest copy, marks the others superseded, deletes nothing, changes no points', async () => {
      const before = await snapshot();
      const points = await pointsSnapshot();
      const report = await backfillRecordIdentity({ userIds: ids, apply: true, batch: 2 });
      assert.deepEqual(counts(report), expected);

      const rows = await snapshot();
      assert.equal(rows.length, before.length);
      const by = Object.fromEntries(rows.map((r) => [short(r.id), r]));
      assert.equal(by['ann-o1'].sourceId, order(1));
      assert.equal(by['ben-o2'].sourceId, order(2));
      assert.equal(by['ben-o2'].contentHash, generateContentHash(amazonPayload(order(2), 'https://www.instagram.com/p/AbC123/')));
      assert.equal(by['ann-o3'].sourceId, order(3));
      assert.equal(by['cat-temu'].sourceId, `title:temu.com:socks ${RUN}:`);
      assert.equal(by['cat-bk-1'].sourceId, `BK-${RUN}`);
      for (const name of ['ben-o1', 'dan-o2-link', 'dan-o2', 'cat-bk-2', 'ben-o7-2', 'cat-sh-2']) {
        assert.deepEqual({ sourceId: by[name].sourceId, contentHash: by[name].contentHash }, supersededIdentity(id(name)), name);
      }
      assert.equal(by['ben-o7-1'].sourceId, order(7));
      assert.equal(by['cat-sh-1'].sourceId, `SH-20-${RUN}`);
      assert.equal(by['dan-x-1'].sourceId, `title:x.com:morning run ${RUN.toLowerCase()}:`);
      assert.equal(by['dan-x-2'].sourceId, `title:post:evening run ${RUN.toLowerCase()}:`);
      assert.equal(by['ann-post'].sourceId, 'title:x.com:https://x.com/ann/status/123');
      assert.equal(await prisma.crawlerData.count({ where: { source: 'amazon', sourceId: order(2) } }), 1);
      assert.deepEqual(await pointsSnapshot(), points);
    });

    it('a second --apply writes nothing', async () => {
      const rows = await snapshot();
      const report = await backfillRecordIdentity({ userIds: ids, apply: true });
      assert.deepEqual([report.linkKeyRows, report.records, report.restored, report.superseded], [0, 0, 0, 0]);
      assert.equal(report.alreadySuperseded, 6);
      assert.deepEqual(perUser(report), expectedPoints);
      assert.deepEqual(await snapshot(), rows);
    });

    it('the current upload finds each record as stored and still stores a new order', async () => {
      const item = (source, metadata, payload) => ({ source, type: 'order', timestamp: '2026-10-12T00:00:00Z', metadata, payload });
      const again = [
        await upload('ben', [item('amazon', amazonMeta, amazonPayload(order(1), 'https://x.com/someone/status/111'))]),
        await upload('dan', [item('amazon', amazonMeta, amazonPayload(order(2)))]),
        await upload('ann', [item('amazon', amazonMeta, amazonPayload(order(3)))]),
        await upload('ben', [item('amazon', amazonMeta, amazonPayload(order(3), 'https://x.com/other/status/1'))]),
        await upload('cat', [item('temu', temuMeta, temuPayload)]),
        await upload('cat', [item('booking', bookingMeta, bookingPayload('https://www.tiktok.com/@h/video/1003'))]),
        await upload('ann', [item('amazon', amazonMeta, amazonPayload(order(7)))]),
        await upload('ann', [item('shein', { sourceUrl: 'https://m.shein.com/user/orders' }, { orderId: `SH-20-${RUN}`, title: 'Linen shirt' })]),
        await upload('dan', [item('x', xMeta, xRedirect)]),
        await upload('dan', [item('x', xPostMeta, xRedirectPost)]),
      ];
      for (const result of again) assert.deepEqual([result.uploadedCount, result.duplicatesCount, result.pointsEarned], [0, 1, 0]);

      const fresh = await upload('dan', [item('amazon', amazonMeta, amazonPayload(order(9), 'https://x.com/n/status/9'))]);
      assert.equal(fresh.uploadedCount, 1);
      assert.ok(fresh.pointsEarned > 0);
    });
  });

  // A record whose title key is the link key another record's row is still stored under waits for
  // that record: --apply repairs it in a later pass of the same transaction, so one run settles.
  // Rows that block each other stay listed.
  describe('backfill of records waiting for another record\'s link key', () => {
    const NAMES = ['kim', 'lou'];
    const ids = NAMES.map(id);
    const short = (rowId) => rowId.slice(RUN.length + 1);
    const at = (s) => new Date(`2026-10-12T02:00:${String(s).padStart(2, '0')}.000Z`);
    const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
    const temuMeta = { sourceUrl: 'https://www.temu.com/bgt_order.html' };
    const r = RUN.toLowerCase();
    // A chain: W's title key is Y's link key, Y's title key is Z's link key.
    const zed = { title: `Zed ${r}`, href: `https://www.tiktok.com/@u${r}/video/1:2024-01-01` };
    const why = { title: `https://tiktok.com/@u${r}/video/1`, date: '2024-01-01', href: `https://x.com/q${r}/status/9:d` };
    const dub = { title: `https://x.com/q${r}/status/9`, date: 'd', href: `https://www.instagram.com/p/Chain${r}/` };
    // Two rows that block each other.
    const pee = { title: `https://tiktok.com/@c${r}/video/2`, date: 'd', href: `https://www.tiktok.com/@c${r}/video/3:e` };
    const que = { title: `https://tiktok.com/@c${r}/video/3`, date: 'e', href: `https://www.tiktok.com/@c${r}/video/2:d` };
    const keys = {
      zed: `title:temu.com:https://tiktok.com/@u${r}/video/1:2024-01-01`,
      why: `title:temu.com:https://x.com/q${r}/status/9:d`,
      dub: `title:temu.com:https://instagram.com/p/Chain${r}`,
      pee: `title:temu.com:https://tiktok.com/@c${r}/video/3:e`,
      que: `title:temu.com:https://tiktok.com/@c${r}/video/2:d`,
    };

    before(async () => {
      for (const name of NAMES) await user(name);
      const task = {};
      for (const name of NAMES) {
        task[name] = (await prisma.crawlerTask.create({
          data: { id: id(`task-${name}-temu`), title: 'temu', source: 'temu', taskId: 'temu_orders', userId: id(name) },
        })).id;
      }
      const rows = [['kim', 'dub', dub, 0], ['kim', 'why', why, 1], ['kim', 'zed', zed, 2], ['lou', 'pee', pee, 3], ['lou', 'que', que, 4]];
      for (const [name, key, payload, s] of rows) {
        await prisma.crawlerData.create({
          data: {
            id: id(key), source: 'temu', type: 'order', timestamp: new Date('2026-10-01T10:00:00Z'), metadata: temuMeta, payload,
            taskId: task[name], userId: id(name), contentHash: sha(JSON.stringify({ postUrl: keys[key] })), sourceId: keys[key], createdAt: at(s),
          },
        });
      }
    });

    after(async () => {
      await prisma.point.deleteMany({ where: { userId: { in: ids } } });
      await prisma.crawlerData.deleteMany({ where: { userId: { in: ids } } });
      await prisma.crawlerTask.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    });

    const snapshot = () =>
      prisma.crawlerData.findMany({ where: { userId: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, sourceId: true, contentHash: true } });
    const counts = (rep) => ({
      linkKeyRows: rep.linkKeyRows, records: rep.records, passes: rep.passes, restored: rep.restored, restoredByKind: rep.restoredByKind,
      heldAlready: rep.heldAlready, superseded: rep.superseded, conflicts: rep.conflicts.map((c) => short(c.id)).sort(),
    });
    const expected = {
      linkKeyRows: 5, records: 5, passes: 3, restored: 3, restoredByKind: { order: 0, title: 3, content: 0 },
      heldAlready: 0, superseded: 0, conflicts: ['pee', 'que'],
    };

    it('a dry run plans every pass and writes nothing', async () => {
      const rows = await snapshot();
      const report = await backfillRecordIdentity({ userIds: ids });
      assert.equal(report.mode, 'dry-run');
      assert.deepEqual(counts(report), expected);
      assert.match(report.conflicts[0].reason, /block each other/);
      assert.deepEqual(await snapshot(), rows);
    });

    it('one --apply repairs the chain in three passes and leaves the rows that block each other', async () => {
      const report = await backfillRecordIdentity({ userIds: ids, apply: true, batch: 1 });
      assert.deepEqual(counts(report), expected);
      const by = Object.fromEntries((await snapshot()).map((row) => [short(row.id), row]));
      assert.equal(by.zed.sourceId, `title:temu.com:zed ${r}:`);
      assert.equal(by.why.sourceId, keys.zed);
      assert.equal(by.dub.sourceId, keys.why);
      assert.equal(by.zed.contentHash, generateContentHash(zed));
      assert.equal(by.why.contentHash, generateContentHash(why));
      assert.equal(by.dub.contentHash, generateContentHash(dub));
      assert.equal(by.pee.sourceId, keys.pee);
      assert.equal(by.que.sourceId, keys.que);
    });

    it('a second --apply writes nothing', async () => {
      const rows = await snapshot();
      const report = await backfillRecordIdentity({ userIds: ids, apply: true });
      assert.deepEqual(counts(report), { ...expected, linkKeyRows: 2, records: 2, passes: 1, restored: 0, restoredByKind: { order: 0, title: 0, content: 0 } });
      assert.deepEqual(await snapshot(), rows);
    });

    it('the current upload finds each repaired record as stored', async () => {
      const item = (payload) => ({ source: 'temu', type: 'order', timestamp: '2026-10-12T00:00:00Z', metadata: temuMeta, payload });
      for (const payload of [zed, why, dub]) {
        const result = await upload('kim', [item(payload)]);
        assert.deepEqual([result.uploadedCount, result.duplicatesCount, result.pointsEarned], [0, 1, 0]);
      }
    });
  });
});
