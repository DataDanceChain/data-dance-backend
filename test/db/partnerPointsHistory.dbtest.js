/**
 * GET /partner/tge/points/history's query on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL
 * pointing at a throwaway database that `prisma migrate deploy` has built — its name must contain
 * "test").
 *
 * What only the database can prove: the keyset WHERE and the ORDER BY agree under Postgres' own
 * comparison of `createdAt` (timestamp(3)) and `id` (text), so rows that share a millisecond page in
 * a stable order with neither gaps nor repeats; a seeded ledger's items sum to the balance; and a
 * 10 000-row ledger (heavy timestamp ties, interleaved with another user's rows) pages completely at
 * the maximum limit. Fixture rows use a per-run id prefix and are deleted afterwards. Every read
 * runs inside the G14 read-only scope with the guard installed on the real client, as the route
 * runs it.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';
// The cursor's signing key is derived from this; the partner API never serves without it.
process.env.SSO_SESSION_SECRET = process.env.SSO_SESSION_SECRET || `dbtest-${crypto.randomBytes(16).toString('hex')}`;

const prisma = require('../../src/utils/prisma');
const { installReadOnlyGuard, runReadOnly } = require('../../src/utils/prismaReadOnly');
const history = require('../../src/services/partnerPointsHistory');

installReadOnlyGuard(prisma);

const RUN = `ph${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms);

async function user(name, totalPoints) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "User"(id, email, "referralCode", "totalPoints", "updatedAt") VALUES ($1, $2, $3, $4, now())',
    id(name), `${id(name)}@example.test`, id(name).toUpperCase(), totalPoints,
  );
}
async function point(owner, rowId, amount, source, createdAt, sourceId = null) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "Point"(id, "userId", amount, source, "sourceId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $6)',
    rowId, id(owner), amount, source, sourceId, createdAt,
  );
}

const page = (owner, query) => runReadOnly('partner GET /partner/tge/points/history (dbtest)', async () => {
  const row = await prisma.user.findUnique({ where: { id: id(owner) }, select: { id: true, totalPoints: true } });
  return history.buildPointsHistory(row, query);
});

async function pageAll(owner, query = {}) {
  const pages = [];
  let body = await page(owner, query);
  pages.push(body);
  while (body.next_cursor) {
    // A keyset that repeats a row would page forever; fail instead of hanging.
    assert.ok(pages.length < 1000, 'more than 1000 pages: the keyset is not advancing');
    body = await page(owner, { ...query, cursor: body.next_cursor });
    pages.push(body);
  }
  return pages;
}

/** Postgres' own order of one user's ledger, as the reference the pages must reproduce. */
async function referenceOrder(owner) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id FROM "Point" WHERE "userId" = $1 ORDER BY "createdAt" DESC, id DESC',
    id(owner),
  );
  return rows.map((r) => r.id);
}

describe('points history query on Postgres', () => {
  // `ledger`: a realistic mixed ledger whose total is the balance. `ties`: 40 rows in one
  // millisecond. `bulk`: 10 000 rows over 250 distinct timestamps. `other`: rows at the same
  // instants as everyone else's, never to appear in their pages.
  const LEDGER = [
    ['l1', 100, 'crawler', 0, 'data_upload'],
    ['l2', 50, 'REFERRAL_DIRECT', 1000, 'some-other-user-id'],
    ['l3', 25, 'OPS_ADJUSTMENT', 1000, 'ops-manual-1-fix__staffname'],
    ['l4', 10, 'TASK_CLAIM', 2000, 'task-1'],
    ['l5', 30, 'CAMPAIGN_RAFFLE', 3000, 'win-1'],
    ['l6', -30, 'REWARD_REDEMPTION', 3000, 'form-apple-order-77'],
    ['l7', 5, 'REFERRAL_LEVEL_3', 4000, 'downline-x'],
    ['l8', -12, 'MANUAL_ADJUSTMENT', 5000, 'staff-label'],
    ['l9', 7, 'REGISTRATION', 5000, null],
    ['l10', 3, 'upline_reward', 5000, 'task-2'],
  ];
  const LEDGER_TOTAL = LEDGER.reduce((sum, row) => sum + row[1], 0);
  const BULK = 10_000;

  before(async () => {
    await user('ledger', LEDGER_TOTAL);
    await user('ties', 40);
    await user('bulk', BULK);
    await user('other', 0);
    await user('empty', 0);
    for (const [rowId, amount, source, ms, sourceId] of LEDGER) await point('ledger', id(rowId), amount, source, at(ms), sourceId);
    for (let i = 0; i < 40; i++) {
      // Mixed-case and hyphenated ids, so the order really is Postgres' text order, not insertion order.
      await point('ties', id(`T-${crypto.randomUUID()}`), 1, 'TASK_CLAIM', at(10_000));
    }
    // 10 000 rows in one statement: 40 rows per millisecond, ids in random order relative to time.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Point"(id, "userId", amount, source, "createdAt", "updatedAt")
       SELECT $1 || '-b-' || md5(g::text), $2, 1, 'crawler', $3::timestamp + ((g / 40) || ' milliseconds')::interval, now()
       FROM generate_series(0, $4 - 1) AS g`,
      RUN, id('bulk'), at(20_000), BULK,
    );
    // The other user: rows at exactly the ledger's, the ties' and the bulk's instants.
    for (const ms of [0, 1000, 3000, 5000, 10_000, 20_000, 20_100]) await point('other', id(`o-${ms}`), 999, 'TASK_CLAIM', at(ms), 'secret');
  });

  after(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "Point" WHERE "userId" LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
  });

  it('a seeded ledger: four fields per item, the allow-list kinds, and the items sum to the balance', async () => {
    const pages = await pageAll('ledger', { limit: '3' });
    assert.equal(pages.length, 4);
    const items = pages.flatMap((p) => p.items);
    assert.deepEqual(items.map((i) => i.id), await referenceOrder('ledger'));
    for (const p of pages) {
      assert.equal(p.balance, LEDGER_TOTAL);
      assert.equal(p.cache_max_age, 0);
      assert.equal(p.sub, id('ledger'));
    }
    assert.equal(items.reduce((sum, i) => sum + i.amount, 0), pages[0].balance);
    for (const item of items) assert.deepEqual(Object.keys(item).sort(), ['amount', 'created_at', 'id', 'kind']);
    const kinds = Object.fromEntries(items.map((i) => [i.id.slice(RUN.length + 1), i.kind]));
    assert.deepEqual(kinds, {
      l1: 'upload', l2: 'referral', l3: 'adjustment', l4: 'task', l5: 'campaign', l6: 'redemption',
      l7: 'referral', l8: 'adjustment', l9: 'other', l10: 'referral',
    });
    const text = JSON.stringify(pages);
    for (const leak of ['data_upload', 'some-other-user-id', 'staffname', 'staff-label', 'form-apple', 'secret', id('other')]) {
      assert.ok(!text.includes(leak), `must not carry ${leak}`);
    }
  });

  it('rows that share a millisecond: a stable order, every page size, neither gaps nor repeats', async () => {
    const reference = await referenceOrder('ties');
    assert.equal(reference.length, 40);
    for (const limit of [1, 3, 7, 39, 40, 100]) {
      const pages = await pageAll('ties', { limit: String(limit) });
      const ids = pages.flatMap((p) => p.items.map((i) => i.id));
      assert.deepEqual(ids, reference, `limit=${limit}`);
      assert.equal(pages.length, Math.ceil(40 / limit), `limit=${limit}`);
    }
    // The same request twice reads the same page and issues the same cursor.
    const once = await page('ties', { limit: '7' });
    const twice = await page('ties', { limit: '7' });
    assert.deepEqual(twice.items, once.items);
    assert.equal(twice.next_cursor, once.next_cursor);
  });

  it('10 000 rows at the maximum limit: 100 pages, every row exactly once, in Postgres order, no other user', async () => {
    const started = Date.now();
    const pages = await pageAll('bulk', { limit: '100' });
    const elapsed = Date.now() - started;
    assert.equal(pages.length, 100);
    for (const p of pages.slice(0, -1)) assert.equal(p.items.length, 100);
    assert.equal(pages[pages.length - 1].next_cursor, null);
    const ids = pages.flatMap((p) => p.items.map((i) => i.id));
    assert.equal(ids.length, BULK);
    assert.equal(new Set(ids).size, BULK, 'no repeats');
    assert.deepEqual(ids, await referenceOrder('bulk'), 'no gaps, Postgres order');
    assert.ok(ids.every((rowId) => rowId.startsWith(`${RUN}-b-`)), 'only the token user\'s rows');
    assert.equal(pages.flatMap((p) => p.items).reduce((sum, i) => sum + i.amount, 0), pages[0].balance);
    // The default limit is 50.
    assert.equal((await page('bulk', {})).items.length, 50);
    assert.ok(elapsed < 60_000, `100 pages took ${elapsed} ms`);
  });

  it('since (inclusive) / until (exclusive) on Postgres, carried by the cursor', async () => {
    const since = at(1000).toISOString();
    const until = at(5000).toISOString();
    const pages = await pageAll('ledger', { since, until, limit: '2' });
    assert.deepEqual(
      pages.flatMap((p) => p.items.map((i) => i.id.slice(RUN.length + 1))).sort(),
      ['l2', 'l3', 'l4', 'l5', 'l6', 'l7'],
    );
    // A later page that names no window keeps the cursor's.
    const first = await page('ledger', { since, until, limit: '2' });
    const second = await page('ledger', { cursor: first.next_cursor, limit: '2' });
    assert.ok(second.items.every((i) => Date.parse(i.created_at) >= at(1000).getTime() && Date.parse(i.created_at) < at(5000).getTime()));
  });

  it('an account with no ledger rows: empty items, next_cursor null, balance 0', async () => {
    const body = await page('empty', {});
    assert.deepEqual(body.items, []);
    assert.equal(body.next_cursor, null);
    assert.equal(body.balance, 0);
  });

  it('a cursor issued for one user is refused for another, and a tampered one never queries', async () => {
    const mine = await page('ledger', { limit: '2' });
    await assert.rejects(page('ties', { cursor: mine.next_cursor }), history.PointsHistoryRequestError);
    const [payload, tag] = mine.next_cursor.split('.');
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), u: id('bulk') })).toString('base64url');
    await assert.rejects(page('bulk', { cursor: `${edited}.${tag}` }), history.PointsHistoryRequestError);
  });
});
