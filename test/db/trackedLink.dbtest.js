/**
 * Tracked links on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at a throwaway,
 * migrated database whose name contains "test").
 *
 * The flow the ops console and the public /go page drive, through the real routers on the real
 * migrations: an admin creates a link, the public page reads it, visitors post open / continue
 * events, and the ops list and detail count them. What only the database can prove: the unique slug
 * (409), Postgres' groupBy behind opens / people / continues, the 30-minute dedupe query, the hit
 * table's columns (no IP, no user agent) and the cascade. Fixture links use a per-run slug prefix
 * and are deleted afterwards (their hits go with them); the seeded links are only read.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';
const JWT_SECRET = `tracked-link-db-${crypto.randomBytes(8).toString('hex')}`;
process.env.JWT_SECRET = JWT_SECRET;
delete process.env.TRACKED_LINK_ORIGIN;

const prisma = require('../../src/utils/prisma');
const goRoutes = require('../../src/routes/goRoutes');
const opsAdminRoutes = require('../../src/routes/opsAdminRoutes');
const { OPS_TOKEN_TYPE } = require('../../src/middlewares/opsAuthMiddleware');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { listenLoopback } = require('../helpers/loopbackServer');

const RUN = `tl${crypto.randomBytes(3).toString('hex')}`;
const slugOf = (name) => `${RUN}-${name}`;
const visitorOf = (name) => `${RUN}${name}visitor`;

const app = express();
app.use(express.json());
app.use('/api/go', goRoutes);
app.use('/api/ops', opsAdminRoutes);

const opsToken = (role) => `Bearer ${jwt.sign({ type: OPS_TOKEN_TYPE, sub: `ops-${role}`, role }, JWT_SECRET, { expiresIn: '5m' })}`;
const ADMIN = opsToken('admin');
const DEMO = opsToken('demo');

let server;
const ops = (method, path) => request(server)[method](`/api/ops${path}`).set('Authorization', ADMIN);
const postEvent = (slug, body, headers = {}) => request(server).post(`/api/go/${slug}/events`).set(headers).send(body);

describe('tracked links on Postgres', () => {
  before(async () => {
    clearRateLimitStore();
    server = await listenLoopback(app);
  });

  after(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "TrackedLink" WHERE slug LIKE $1', `${RUN}-%`);
    const [{ remaining }] = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS remaining FROM "TrackedLinkHit" WHERE "visitorId" LIKE $1',
      `${RUN}%`
    );
    assert.equal(remaining, 0, 'deleting a link deletes its hits (ON DELETE CASCADE)');
    await prisma.$disconnect();
    await new Promise((resolve) => server.close(resolve));
  });

  it('the migrations leave the three standing links, with unique slugs', async () => {
    const rows = await prisma.trackedLink.findMany({
      where: { slug: { in: ['event', 'reddit', 'download'] } },
      select: { slug: true, name: true, kind: true, targetUrl: true },
      orderBy: { slug: 'asc' },
    });
    assert.deepEqual(rows.map((r) => r.slug), ['download', 'event', 'reddit']);
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
    assert.equal(bySlug.event.name, 'Token 2049', '20261002100000 renames the event link');
    assert.equal(bySlug.download.kind, 'app');
    assert.equal(bySlug.reddit.targetUrl, 'https://forms.gle/9hDn2DKauL8B4NQs8');
  });

  it('the hit table stores no IP address and no user agent', async () => {
    const columns = await prisma.$queryRawUnsafe(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'TrackedLinkHit' ORDER BY column_name`
    );
    assert.deepEqual(columns.map((c) => c.name), ['createdAt', 'dest', 'event', 'id', 'linkId', 'referrerHost', 'visitorId']);
  });

  it('an error Postgres raises is answered as a plain 500, without Prisma\'s text', async () => {
    // Postgres refuses a NUL byte in a text column; the title reaches the insert unchanged.
    const res = await ops('post', '/links').send({ slug: slugOf('nul'), name: 'NUL', kind: 'app', title: 'a\u0000b' });
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.deepEqual(res.body, { status: 'error', message: 'Server error' });
    assert.equal(await prisma.trackedLink.count({ where: { slug: slugOf('nul') } }), 0);
  });

  it('a NUL byte in the public slug or in `dest` never reaches Postgres', async () => {
    const page = await request(server).get('/api/go/%00');
    assert.equal(page.status, 404, JSON.stringify(page.body));
    const event = await postEvent('event%00', { visitorId: visitorOf('nul'), event: 'open' });
    assert.equal(event.status, 404, JSON.stringify(event.body));

    const slug = slugOf('dest');
    const created = await ops('post', '/links').send({ slug, name: 'dest', kind: 'app', title: 'dest' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const hit = await postEvent(slug, { visitorId: visitorOf('nul'), event: 'continue', dest: 'a\u0000b' });
    assert.equal(hit.status, 200, JSON.stringify(hit.body));
    assert.deepEqual(hit.body.data, { counted: true });
    const [row] = await prisma.trackedLinkHit.findMany({ where: { linkId: created.body.data.id } });
    assert.equal(row.dest, null);
  });

  it('create a link → the public page reads it → events → the ops list and detail count them', async () => {
    const slug = slugOf('page');
    const created = await ops('post', '/links').send({
      slug,
      name: 'DB flow',
      kind: 'page',
      title: 'DB flow',
      body: 'One short form.',
      buttonLabel: 'Apply',
      targetUrl: 'https://example.com/apply',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { id } = created.body.data;
    assert.equal(created.body.data.publicUrl, `https://app.datadance.ai/go/${slug}`);

    const duplicate = await ops('post', '/links').send({ slug, name: 'again', kind: 'app', title: 'again' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'slug_taken');

    const page = await request(server).get(`/api/go/${slug}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(page.body.data, {
      slug,
      kind: 'page',
      title: 'DB flow',
      body: 'One short form.',
      buttonLabel: 'Apply',
      targetUrl: 'https://example.com/apply',
    });

    const a = visitorOf('a');
    const b = visitorOf('b');
    assert.deepEqual((await postEvent(slug, { visitorId: a, event: 'open' })).body.data, { counted: true });
    assert.deepEqual((await postEvent(slug, { visitorId: a, event: 'open' })).body.data, { counted: false });
    const cont = await postEvent(
      slug,
      { visitorId: a, event: 'continue', dest: 'target' },
      { Referer: 'https://www.reddit.com/r/datadance/comments/abc?utm_source=x', 'User-Agent': 'DbTestAgent/1.0' }
    );
    assert.deepEqual(cont.body.data, { counted: true });
    assert.deepEqual((await postEvent(slug, { visitorId: b, event: 'open' })).body.data, { counted: true });

    const stored = await prisma.trackedLinkHit.findMany({ where: { linkId: id }, orderBy: [{ visitorId: 'asc' }, { event: 'asc' }] });
    assert.deepEqual(stored.map((h) => [h.visitorId, h.event, h.dest, h.referrerHost]), [
      [a, 'continue', 'target', 'www.reddit.com'],
      [a, 'open', null, null],
      [b, 'open', null, null],
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const detail = await ops('get', `/links/${id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual([detail.body.data.opens, detail.body.data.people, detail.body.data.continues], [2, 2, 1]);
    // A run straddling UTC midnight could split the day; the totals above never depend on it.
    if (stored.every((h) => h.createdAt.toISOString().slice(0, 10) === today)) {
      assert.deepEqual(detail.body.data.days, [{ day: today, opens: 2, people: 2, continues: 1 }]);
    }

    const list = await ops('get', '/links');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const listed = list.body.data.find((l) => l.id === id);
    assert.deepEqual([listed.opens, listed.people, listed.continues], [2, 2, 1]);

    const demoWrite = await request(server)
      .patch(`/api/ops/links/${id}`)
      .set('Authorization', DEMO)
      .send({ kind: 'redirect', targetUrl: 'https://example.org/' });
    assert.equal(demoWrite.status, 403, 'a demo session cannot change a link');

    const off = await ops('patch', `/links/${id}`).send({ active: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await request(server).get(`/api/go/${slug}`)).status, 404);
    assert.equal((await postEvent(slug, { visitorId: visitorOf('c'), event: 'open' })).status, 404);
    assert.equal(await prisma.trackedLinkHit.count({ where: { linkId: id } }), 3);
  });
});
