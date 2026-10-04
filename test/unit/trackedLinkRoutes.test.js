/**
 * Tracked links through the REAL routers — src/routes/goRoutes.js at /api/go and
 * src/routes/opsAdminRoutes.js at /api/ops — on the in-memory Prisma stand-in. No database.
 *
 * The public pair (GET /api/go/:slug, POST /api/go/:slug/events) takes no credential, so what it
 * accepts, stores and returns is pinned here: only the public fields of an active link; only the
 * `open` and `continue` events from a well-formed visitor id; one count per visitor and event per
 * 30 minutes; the referrer's host and never the caller's IP or user agent; and the shared `public`
 * limiter. The ops routes need an ops token, and a demo session can read but not write.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();
const JWT_SECRET = 'tracked-link-unit-test-secret';
Object.assign(process.env, { LOG_LEVEL: 'error', JWT_SECRET });
delete process.env.TRACKED_LINK_ORIGIN;

const goRoutes = require('../../src/routes/goRoutes');
const opsAdminRoutes = require('../../src/routes/opsAdminRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { OPS_TOKEN_TYPE } = require('../../src/middlewares/opsAuthMiddleware');

const app = express();
app.use(express.json());
app.use('/api/go', goRoutes);
app.use('/api/ops', opsAdminRoutes);

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const opsToken = (role) => jwt.sign({ type: OPS_TOKEN_TYPE, sub: `ops-${role}`, role }, JWT_SECRET, { expiresIn: '5m' });
const ADMIN = `Bearer ${opsToken('admin')}`;
const DEMO = `Bearer ${opsToken('demo')}`;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const VISITOR = 'visitorA1234';

function seedLink(overrides = {}) {
  const row = {
    id: `link-${prisma.trackedLink.rows.length + 1}`,
    slug: 'event',
    name: 'Token 2049',
    kind: 'app',
    title: '下载 DataDance',
    body: '用手机打开这个页面，即可下载 App。',
    buttonLabel: '',
    targetUrl: null,
    active: true,
    createdAt: new Date('2026-09-29T00:00:00Z'),
    updatedAt: new Date('2026-09-29T00:00:00Z'),
    ...overrides,
  };
  prisma.trackedLink.rows.push(row);
  return row;
}

function seedHit(link, visitorId, event, at) {
  prisma.trackedLinkHit.rows.push({
    id: `hit-${prisma.trackedLinkHit.rows.length + 1}`,
    linkId: link.id,
    visitorId,
    event,
    dest: null,
    referrerHost: null,
    createdAt: new Date(at),
  });
}

const hits = () => prisma.trackedLinkHit.rows;
const postEvent = (slug, body, headers = {}) => request(server).post(`/api/go/${slug}/events`).set(headers).send(body);
const day = (at) => new Date(at).toISOString().slice(0, 10);

beforeEach(() => {
  clearRateLimitStore();
  prisma.reset();
});

describe('GET /api/go/:slug (public)', () => {
  it('returns only the public fields of an active link, with no credential', async () => {
    seedLink({
      slug: 'reddit',
      kind: 'page',
      name: 'Reddit beta apply',
      title: 'DataDance beta',
      body: 'One short form.',
      buttonLabel: 'Apply',
      targetUrl: 'https://forms.gle/9hDn2DKauL8B4NQs8',
    });
    const expected = {
      slug: 'reddit',
      kind: 'page',
      title: 'DataDance beta',
      body: 'One short form.',
      buttonLabel: 'Apply',
      targetUrl: 'https://forms.gle/9hDn2DKauL8B4NQs8',
    };
    const res = await request(server).get('/api/go/reddit');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { status: 'success', data: expected });
    const upper = await request(server).get('/api/go/REDDIT');
    assert.equal(upper.status, 200, 'the slug is matched case-insensitively');
    assert.deepEqual(upper.body.data, expected);
  });

  it('answers 404 for an unknown or a switched-off link', async () => {
    seedLink({ slug: 'old', active: false });
    for (const slug of ['old', 'nope']) {
      const res = await request(server).get(`/api/go/${slug}`);
      assert.equal(res.status, 404, slug);
      assert.equal(res.body.code, 'link_not_found');
    }
  });
});

describe('POST /api/go/:slug/events (public)', () => {
  it('counts an open once per visitor per 30 minutes, and a continue on its own', async () => {
    seedLink();
    const first = await postEvent('event', { visitorId: VISITOR, event: 'open' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { status: 'success', data: { counted: true } });
    const again = await postEvent('event', { visitorId: VISITOR, event: 'open' });
    assert.deepEqual(again.body.data, { counted: false }, 'a reload within 30 minutes is not a second open');
    const cont = await postEvent('event', { visitorId: VISITOR, event: 'continue', dest: 'ios' });
    assert.deepEqual(cont.body.data, { counted: true });
    const other = await postEvent('event', { visitorId: 'visitorB1234', event: 'open' });
    assert.deepEqual(other.body.data, { counted: true });
    assert.deepEqual(hits().map((h) => [h.visitorId, h.event, h.dest]), [
      [VISITOR, 'open', null],
      [VISITOR, 'continue', 'ios'],
      ['visitorB1234', 'open', null],
    ]);
  });

  it('counts the same visitor again once the 30-minute window has passed', async () => {
    const link = seedLink();
    seedHit(link, VISITOR, 'open', Date.now() - 31 * MINUTE);
    seedHit(link, 'visitorB1234', 'open', Date.now() - 29 * MINUTE);
    assert.deepEqual((await postEvent('event', { visitorId: VISITOR, event: 'open' })).body.data, { counted: true });
    assert.deepEqual((await postEvent('event', { visitorId: 'visitorB1234', event: 'open' })).body.data, { counted: false });
  });

  it('keeps the referrer host only, and nothing that identifies the caller (no IP, no user agent)', async () => {
    seedLink();
    const res = await postEvent(
      'event',
      { visitorId: VISITOR, event: 'continue', dest: 'target' },
      {
        Referer: 'https://www.reddit.com/r/datadance/comments/abc?utm_source=someone@example.com',
        'User-Agent': 'UnitTestAgent/1.0',
        'X-Forwarded-For': '203.0.113.9',
      }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(hits().length, 1);
    const [row] = hits();
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'dest', 'event', 'id', 'linkId', 'referrerHost', 'visitorId']);
    assert.equal(row.referrerHost, 'www.reddit.com');
    const stored = JSON.stringify(row);
    for (const leak of ['203.0.113.9', '127.0.0.1', 'UnitTestAgent', 'someone@example.com', 'utm_source']) {
      assert.ok(!stored.includes(leak), `stored hit must not contain ${leak}`);
    }
  });

  it('refuses a malformed visitor id or any event but open / continue, and writes nothing', async () => {
    seedLink();
    for (const visitorId of [undefined, '', 'short', 'has space 1234', 'semi;colon123', 'é'.repeat(10), { $gt: '' }]) {
      const res = await postEvent('event', { visitorId, event: 'open' });
      assert.equal(res.status, 400, `visitorId ${JSON.stringify(visitorId)}`);
      assert.equal(res.body.code, 'invalid_visitor');
    }
    for (const event of [undefined, 'click', 'OPEN', ['open'], { $ne: null }]) {
      const res = await postEvent('event', { visitorId: VISITOR, event });
      assert.equal(res.status, 400, `event ${JSON.stringify(event)}`);
      assert.equal(res.body.code, 'invalid_event');
    }
    assert.equal(hits().length, 0);
  });

  it('answers 404 for events on an unknown or a switched-off link, and writes nothing', async () => {
    seedLink({ slug: 'old', active: false });
    for (const slug of ['old', 'nope']) {
      const res = await postEvent(slug, { visitorId: VISITOR, event: 'open' });
      assert.equal(res.status, 404, slug);
      assert.equal(res.body.code, 'link_not_found');
    }
    assert.equal(hits().length, 0);
  });
});

describe('public rate limit', () => {
  it('the page and its events share the per-IP `public` limiter: 200 a minute, then 429', async () => {
    seedLink();
    for (let i = 0; i < 150; i += 1) {
      const res = await request(server).get('/api/go/event');
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    for (let i = 0; i < 50; i += 1) {
      // Refused for its event, but every request counts on entry.
      const res = await postEvent('event', { visitorId: VISITOR, event: 'nope' });
      assert.equal(res.status, 400, `event request ${i + 1}`);
    }
    const page = await request(server).get('/api/go/event');
    assert.equal(page.status, 429);
    assert.ok(Number(page.headers['retry-after']) >= 1, 'Retry-After is set');
    const hit = await postEvent('event', { visitorId: VISITOR, event: 'open' });
    assert.equal(hit.status, 429);
    assert.equal(hits().length, 0);
  });
});

describe('server errors', () => {
  it('a database failure is a plain 500: the error text (query, file paths, database host) stays in the server log', async () => {
    seedLink({ id: 'link-1' });
    // What Prisma puts in error.message: the call, the server's file path and line, the database host.
    const prismaText = "\nInvalid `prisma.trackedLink.findUnique()` invocation in\n/app/src/services/trackedLink.js:173:41\n\nCan't reach database server at `db.internal:5432`";
    const fail = async () => { throw Object.assign(new Error(prismaText), { code: 'P1001' }); };
    const saved = { ...prisma.trackedLink };
    Object.assign(prisma.trackedLink, { findUnique: fail, findMany: fail, create: fail });
    try {
      const responses = {
        'GET /api/go/event': await request(server).get('/api/go/event'),
        'POST /api/go/event/events': await postEvent('event', { visitorId: VISITOR, event: 'open' }),
        'GET /api/ops/links': await request(server).get('/api/ops/links').set('Authorization', ADMIN),
        'POST /api/ops/links': await request(server)
          .post('/api/ops/links')
          .set('Authorization', ADMIN)
          .send({ slug: 'new-link', name: 'n', kind: 'app', title: 't' }),
        'GET /api/ops/links/link-1': await request(server).get('/api/ops/links/link-1').set('Authorization', ADMIN),
        'PATCH /api/ops/links/link-1': await request(server)
          .patch('/api/ops/links/link-1')
          .set('Authorization', ADMIN)
          .send({ active: false }),
      };
      for (const [route, res] of Object.entries(responses)) {
        assert.equal(res.status, 500, route);
        assert.deepEqual(res.body, { status: 'error', message: 'Server error' }, route);
      }
    } finally {
      Object.assign(prisma.trackedLink, saved);
    }
  });
});

describe('/api/ops/links', () => {
  const routes = [
    ['get', '/api/ops/links'],
    ['post', '/api/ops/links'],
    ['get', '/api/ops/links/link-1'],
    ['patch', '/api/ops/links/link-1'],
  ];

  it('needs an ops token: none is 401, a user token is 403', async () => {
    seedLink();
    const userJwt = jwt.sign({ id: 'user-1', ver: 2 }, JWT_SECRET, { expiresIn: '5m' });
    for (const [method, path] of routes) {
      const anonymous = await request(server)[method](path).send({});
      assert.equal(anonymous.status, 401, `${method.toUpperCase()} ${path} without a token`);
      const user = await request(server)[method](path).set('Authorization', `Bearer ${userJwt}`).send({});
      assert.equal(user.status, 403, `${method.toUpperCase()} ${path} with a user token`);
    }
    assert.equal(prisma.trackedLink.rows.length, 1);
  });

  it('a demo session can read links but cannot create or change them', async () => {
    const link = seedLink();
    const list = await request(server).get('/api/ops/links').set('Authorization', DEMO);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const detail = await request(server).get(`/api/ops/links/${link.id}`).set('Authorization', DEMO);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const create = await request(server)
      .post('/api/ops/links')
      .set('Authorization', DEMO)
      .send({ slug: 'demo-made', name: 'x', kind: 'redirect', title: 'x', targetUrl: 'https://example.com/' });
    assert.equal(create.status, 403);
    const patch = await request(server)
      .patch(`/api/ops/links/${link.id}`)
      .set('Authorization', DEMO)
      .send({ kind: 'redirect', targetUrl: 'https://example.com/' });
    assert.equal(patch.status, 403);
    assert.equal(prisma.trackedLink.rows.length, 1);
    assert.equal(prisma.trackedLink.rows[0].kind, 'app');
    assert.equal(prisma.trackedLink.rows[0].targetUrl, null);
  });

  it('an admin creates a link; the slug, kind, required text and https target are checked', async () => {
    const create = (body) => request(server).post('/api/ops/links').set('Authorization', ADMIN).send(body);
    const valid = {
      slug: ' Spring-Promo ',
      name: 'Spring promo',
      kind: 'page',
      title: 'Spring',
      body: 'Short copy.',
      buttonLabel: 'Go',
      targetUrl: 'https://example.com/spring',
    };
    const ok = await create(valid);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.slug, 'spring-promo');
    assert.equal(ok.body.data.publicUrl, 'https://app.datadance.ai/go/spring-promo');
    assert.equal(ok.body.data.targetUrl, 'https://example.com/spring');
    assert.deepEqual([ok.body.data.opens, ok.body.data.people, ok.body.data.continues], [0, 0, 0]);

    const app = await create({ ...valid, slug: 'app-link', kind: 'app', targetUrl: 'https://elsewhere.example/' });
    assert.equal(app.status, 201, JSON.stringify(app.body));
    assert.equal(app.body.data.targetUrl, null, 'an app download link never carries a target');

    const refused = [
      [{ ...valid, slug: 'a' }, 'invalid_slug'],
      [{ ...valid, slug: 'has space' }, 'invalid_slug'],
      [{ ...valid, slug: 'x'.repeat(41) }, 'invalid_slug'],
      [{ ...valid, slug: 'popup-1', kind: 'popup' }, 'invalid_kind'],
      [{ ...valid, slug: 'no-name', name: '  ' }, 'invalid_name'],
      [{ ...valid, slug: 'no-title', title: '' }, 'invalid_title'],
      [{ ...valid, slug: 'plain-http', targetUrl: 'http://example.com/' }, 'invalid_target'],
      [{ ...valid, slug: 'script-url', kind: 'redirect', targetUrl: 'javascript:alert(1)' }, 'invalid_target'],
      [{ ...valid, slug: 'data-url', kind: 'redirect', targetUrl: 'data:text/html,<script>alert(1)</script>' }, 'invalid_target'],
      [{ ...valid, slug: 'no-target', kind: 'redirect', targetUrl: '' }, 'invalid_target'],
      [{ ...valid, slug: 'long-target', targetUrl: `https://example.com/${'a'.repeat(500)}` }, 'invalid_target'],
    ];
    for (const [body, code] of refused) {
      const res = await create(body);
      assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${res.status}`);
      assert.equal(res.body.code, code);
    }
    assert.deepEqual(prisma.trackedLink.rows.map((r) => r.slug), ['spring-promo', 'app-link']);
  });

  it('the list and the detail count opens, people and continues; the detail splits the last 14 days by day', async () => {
    const a = seedLink({ id: 'link-a', slug: 'event' });
    const b = seedLink({ id: 'link-b', slug: 'reddit', kind: 'page', targetUrl: 'https://forms.gle/x' });
    const now = Date.now();
    const old = now - 20 * DAY;
    const twoDaysAgo = now - 2 * DAY;
    const recent = now - MINUTE;
    // Chronological, as the real query orders them.
    seedHit(a, 'visitorOld01', 'open', old);
    seedHit(a, 'visitorA1234', 'open', twoDaysAgo);
    seedHit(a, 'visitorA1234', 'open', recent);
    seedHit(a, 'visitorB1234', 'open', recent);
    seedHit(a, 'visitorA1234', 'continue', recent);
    seedHit(b, 'visitorC1234', 'open', recent);

    const list = await request(server).get('/api/ops/links').set('Authorization', ADMIN);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const counts = Object.fromEntries(list.body.data.map((l) => [l.id, [l.opens, l.people, l.continues]]));
    assert.deepEqual(counts, { 'link-a': [4, 3, 1], 'link-b': [1, 1, 0] });

    const detail = await request(server).get('/api/ops/links/link-a').set('Authorization', ADMIN);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual([detail.body.data.opens, detail.body.data.people, detail.body.data.continues], [4, 3, 1]);
    // 48 hours apart, so always two different UTC days.
    assert.deepEqual(detail.body.data.days, [
      { day: day(twoDaysAgo), opens: 1, people: 1, continues: 0 },
      { day: day(recent), opens: 2, people: 2, continues: 1 },
    ]);
    assert.ok(!detail.body.data.days.some((d) => d.day === day(old)), 'hits older than 14 days stay out of the daily view');

    const missing = await request(server).get('/api/ops/links/nope').set('Authorization', ADMIN);
    assert.equal(missing.status, 404);
  });

  it('an admin can switch a link off: the public page then answers 404 and stops counting', async () => {
    const link = seedLink({ slug: 'reddit', kind: 'page', targetUrl: 'https://forms.gle/x' });
    const patch = (body) => request(server).patch(`/api/ops/links/${link.id}`).set('Authorization', ADMIN).send(body);

    const http = await patch({ targetUrl: 'http://forms.gle/x' });
    assert.equal(http.status, 400);
    assert.equal(http.body.code, 'invalid_target');
    const toApp = await patch({ kind: 'app' });
    assert.equal(toApp.status, 200, JSON.stringify(toApp.body));
    assert.equal(toApp.body.data.targetUrl, null);
    const backToRedirect = await patch({ kind: 'redirect' });
    assert.equal(backToRedirect.status, 400, 'a redirect without a target is refused');
    assert.equal(backToRedirect.body.code, 'invalid_target');

    const off = await patch({ active: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.data.active, false);
    assert.equal((await request(server).get('/api/go/reddit')).status, 404);
    assert.equal((await postEvent('reddit', { visitorId: VISITOR, event: 'open' })).status, 404);
    assert.equal(hits().length, 0);

    const unknown = await request(server).patch('/api/ops/links/nope').set('Authorization', ADMIN).send({ active: true });
    assert.equal(unknown.status, 404);
  });
});
