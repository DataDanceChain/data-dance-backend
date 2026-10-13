/**
 * The ops audit log (admin issue #2): GET /api/ops/audit (ops.admin only, filters and paging) and
 * the generic `ops.write` row every other successful ops write leaves. Through the REAL application
 * on the in-memory Prisma stand-in.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { once } = require('events');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, settle } = require('../helpers/opsApp');

const { prisma, app } = installOpsApp();
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { writeAudit, auditLog, auditOpsWrites, _internals } = require('../../src/services/opsAudit');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

let admin;
let operator;
const auth = {};
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  delete process.env.OPS_SHARED_LOGIN;
  admin = await seedUser(prisma, { email: 'sloan@example.test' });
  await grant(prisma, admin.id, 'ddc_admin');
  operator = await seedUser(prisma, { email: 'op@example.test' });
  await grant(prisma, operator.id, 'operator');
  auth.admin = bearer(tokens.ops(admin));
  auth.operator = bearer(tokens.ops(operator));
});

const getAudit = (query = '', authorization = auth.admin) =>
  request(server).get(`/api/ops/audit${query}`).set('Authorization', authorization);

const ACTOR = { kind: 'user', userId: 'actor-1', label: 'sloan@example.test', role: 'ddc_admin' };

/** Rows with fixed times, oldest first, so filters and paging have something to bite on. */
async function seedRows() {
  const rows = [
    ['2026-10-01T00:00:00Z', 'role.grant', { type: 'user', id: 'u-1' }, ACTOR],
    ['2026-10-02T00:00:00Z', 'role.revoke', { type: 'user', id: 'u-1' }, ACTOR],
    ['2026-10-03T00:00:00Z', 'account.disable', { type: 'user', id: 'u-2' }, ACTOR],
    ['2026-10-04T00:00:00Z', 'points.adjust', { type: 'user', id: 'u-2' }, { ...ACTOR, userId: 'actor-2', label: 'race@example.test' }],
    ['2026-10-05T00:00:00Z', 'ops.write', { type: 'links', id: 'link-1' }, { kind: 'shared', userId: null, label: 'shared', role: 'shared' }],
  ];
  for (const [at, action, target, actor] of rows) {
    const row = await writeAudit(prisma, { actor, action, target, reason: `${action} why`, detail: { n: 1 }, surface: 'ops' });
    prisma.store.opsAuditLog.find((r) => r.id === row.id).createdAt = new Date(at);
  }
}

describe('GET /api/ops/audit', () => {
  it('lists newest first in the AuditRow shape, with total, limit and offset', async () => {
    await seedRows();
    const res = await getAudit();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.total, 5);
    assert.equal(data.limit, 50);
    assert.equal(data.offset, 0);
    assert.deepEqual(data.items.map((i) => i.action), ['ops.write', 'points.adjust', 'account.disable', 'role.revoke', 'role.grant']);
    const row = data.items[1];
    assert.deepEqual(Object.keys(row).sort(), ['action', 'actor', 'createdAt', 'detail', 'id', 'reason', 'requestId', 'surface', 'target'].sort());
    assert.deepEqual(row.actor, { kind: 'user', userId: 'actor-2', label: 'race@example.test', role: 'ddc_admin' });
    assert.deepEqual(row.target, { type: 'user', id: 'u-2', label: null });
    assert.equal(row.reason, 'points.adjust why');
    assert.deepEqual(row.detail, { n: 1 });
    assert.equal(row.surface, 'ops');
  });

  it('filters by exact action, action prefix, actor, target and date range', async () => {
    await seedRows();
    const actions = async (query) => (await getAudit(query)).body.data.items.map((i) => i.action);
    assert.deepEqual(await actions('?action=role.grant'), ['role.grant']);
    assert.deepEqual(await actions('?action=role.'), ['role.revoke', 'role.grant']);
    assert.deepEqual(await actions('?actorUserId=actor-2'), ['points.adjust']);
    assert.deepEqual(await actions('?targetType=user&targetId=u-2'), ['points.adjust', 'account.disable']);
    assert.deepEqual(await actions('?targetType=links'), ['ops.write']);
    assert.deepEqual(
      await actions(`?from=${encodeURIComponent('2026-10-02T00:00:00Z')}&to=${encodeURIComponent('2026-10-03T12:00:00Z')}`),
      ['account.disable', 'role.revoke'],
    );
    const filtered = await getAudit('?action=role.');
    assert.equal(filtered.body.data.total, 2, 'total counts the filtered rows');
  });

  it('pages with limit (1..200, default 50) and offset', async () => {
    await seedRows();
    const page = await getAudit('?limit=2&offset=1');
    assert.equal(page.body.data.total, 5);
    assert.equal(page.body.data.limit, 2);
    assert.equal(page.body.data.offset, 1);
    assert.deepEqual(page.body.data.items.map((i) => i.action), ['points.adjust', 'account.disable']);
    assert.equal((await getAudit('?limit=1000')).body.data.limit, 200);
    assert.equal((await getAudit('?limit=0')).body.data.limit, 50);
    assert.equal((await getAudit('?limit=-3&offset=-1')).body.data.offset, 0);
  });

  it('refuses an unknown action, a malformed prefix or date: 400 INVALID_REQUEST', async () => {
    for (const query of ['?action=role.delete', '?action=Role.', '?action=%27%3B', '?from=yesterday', '?targetId=a%20b']) {
      const res = await getAudit(query);
      assert.equal(res.status, 400, query);
      assert.equal(res.body.code, 'INVALID_REQUEST', query);
    }
  });

  it('is ops.admin only: operator, shared and demo get 403', async () => {
    await seedRows();
    const operatorRes = await getAudit('', auth.operator);
    assert.equal(operatorRes.status, 403);
    assert.equal(operatorRes.body.code, 'FORBIDDEN_ROLE');
    process.env.OPS_SHARED_LOGIN = 'on';
    const shared = await getAudit('', bearer(tokens.shared()));
    assert.equal(shared.status, 403);
    assert.equal(shared.body.code, 'FORBIDDEN_ROLE');
    const demo = await getAudit('', bearer(tokens.demo()));
    assert.equal(demo.status, 403);
    assert.equal(demo.body.data, undefined);
  });
});

describe('the generic ops.write row', () => {
  const LINK = {
    slug: 'spring-promo',
    name: 'Spring promo',
    kind: 'page',
    title: 'Spring',
    body: 'Short copy SECRET-BODY-MARKER.',
    buttonLabel: 'Go',
    targetUrl: 'https://example.com/spring',
  };

  it('a 2xx write leaves one row: actor, target from the route, method, route, params, status; never the body', async () => {
    const created = await request(server).post('/api/ops/links').set('Authorization', auth.operator).send(LINK);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    const patched = await request(server)
      .patch(`/api/ops/links/${id}`)
      .set('Authorization', auth.operator)
      .send({ active: false, title: 'SECRET-BODY-MARKER' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    await settle();

    const rows = prisma.store.opsAuditLog;
    assert.equal(rows.length, 2);
    const [post, patch] = rows;
    assert.equal(post.action, 'ops.write');
    assert.equal(post.actorKind, 'user');
    assert.equal(post.actorUserId, operator.id);
    assert.equal(post.actorLabel, 'op@example.test');
    assert.equal(post.actorRole, 'operator');
    assert.equal(post.surface, 'ops');
    assert.equal(post.targetType, 'links');
    assert.equal(post.targetId, null);
    assert.deepEqual(post.detail, { method: 'POST', route: '/api/ops/links', params: {}, status: 201 });
    assert.ok(post.requestId, 'the request id is recorded');

    assert.equal(patch.targetType, 'links');
    assert.equal(patch.targetId, id);
    assert.deepEqual(patch.detail, { method: 'PATCH', route: '/api/ops/links/:id', params: { id }, status: 200 });
    assert.ok(!JSON.stringify(rows).includes('SECRET-BODY-MARKER'), 'the request body is never recorded');
  });

  it('a client that hangs up mid-request still leaves the row for the change it made', async () => {
    const original = prisma.trackedLink.create;
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // The handler stops inside its change until the client has gone.
    prisma.trackedLink.create = async (args) => {
      enter();
      await gate;
      return original(args);
    };
    const serverSockets = [];
    const onConnection = (socket) => serverSockets.push(socket);
    server.on('connection', onConnection);
    const within = (promise, what) => Promise.race([
      promise,
      new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out: ${what}`)), 2000).unref(); }),
    ]);
    try {
      const payload = JSON.stringify(LINK);
      const client = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: '/api/ops/links',
        agent: false,
        headers: {
          Authorization: auth.operator,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      });
      let answered = false;
      client.on('response', () => { answered = true; });
      client.on('error', () => {}); // the hang-up below
      client.end(payload);
      await within(entered, 'the handler reached its change');

      const local = client.socket.localPort;
      const serverSocket = serverSockets.find((socket) => socket.remotePort === local);
      assert.ok(serverSocket, 'the server side of the connection');
      const closed = once(serverSocket, 'close');
      client.destroy();
      await within(closed, 'the server saw the hang-up');
      release();
      await settle();
      assert.equal(answered, false, 'the client never got an answer');
    } finally {
      release();
      prisma.trackedLink.create = original;
      server.off('connection', onConnection);
    }

    assert.equal(prisma.store.trackedLink.length, 1, 'the change was made');
    const rows = prisma.store.opsAuditLog;
    assert.equal(rows.length, 1, 'and it is in the audit log');
    assert.equal(rows[0].action, 'ops.write');
    assert.equal(rows[0].actorUserId, operator.id);
    assert.equal(rows[0].targetType, 'links');
    assert.deepEqual(rows[0].detail, { method: 'POST', route: '/api/ops/links', params: {}, status: 201 });
  });

  it('res.end called twice still leaves one row, and the real end runs each time', async () => {
    const req = {
      method: 'POST',
      opsAdmin: { kind: 'user', userId: operator.id, username: 'op@example.test', role: 'operator' },
      reqId: 'r-twice',
      opsRoute: { baseUrl: '/api/ops', path: '/links', params: {} },
    };
    const ends = [];
    const res = { statusCode: 201, end(...args) { ends.push(args); return this; } };
    auditOpsWrites(req, res, () => {});
    assert.equal(res.end('{}'), res);
    res.end();
    await req.auditPending;
    assert.deepEqual(ends, [['{}'], []]);
    assert.equal(prisma.store.opsAuditLog.length, 1);
    assert.equal(prisma.store.opsAuditLog[0].requestId, 'r-twice');
  });

  it('a shared session is recorded as actor "shared"', async () => {
    process.env.OPS_SHARED_LOGIN = 'on';
    const res = await request(server).post('/api/ops/links').set('Authorization', bearer(tokens.shared())).send(LINK);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await settle();
    const [row] = prisma.store.opsAuditLog;
    assert.equal(row.actorKind, 'shared');
    assert.equal(row.actorLabel, 'shared');
    assert.equal(row.actorUserId, null);
  });

  it('a 4xx write leaves no row; a refused role leaves no row; a GET leaves no row', async () => {
    const bad = await request(server).post('/api/ops/links').set('Authorization', auth.operator).send({ ...LINK, slug: 'a' });
    assert.equal(bad.status, 400);
    const refused = await request(server).get('/api/ops/roles').set('Authorization', auth.operator);
    assert.equal(refused.status, 403);
    const read = await request(server).get('/api/ops/links').set('Authorization', auth.operator);
    assert.equal(read.status, 200);
    await settle();
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('an endpoint that wrote its own row gets no generic row (points adjust)', async () => {
    const member = await seedUser(prisma, { totalPoints: 10 });
    const res = await request(server)
      .post(`/api/ops/users/${member.id}/points`)
      .set('Authorization', auth.operator)
      .send({ amount: 5, note: 'goodwill credit' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await settle();
    const rows = prisma.store.opsAuditLog;
    assert.deepEqual(rows.map((r) => r.action), ['points.adjust']);
    assert.equal(res.body.data.auditId, rows[0].id);
    assert.equal(rows[0].reason, 'goodwill credit');
    assert.equal(rows[0].targetId, member.id);
    assert.deepEqual(rows[0].detail, {
      amount: 5,
      balanceBefore: 10,
      balanceAfter: 15,
      pointId: res.body.data.pointId,
      sourceId: res.body.data.sourceId,
    });
  });

  it('a points adjust whose audit row cannot be written moves no points', async () => {
    const member = await seedUser(prisma, { totalPoints: 10 });
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw new Error('audit store down'); };
    try {
      const res = await request(server)
        .post(`/api/ops/users/${member.id}/points`)
        .set('Authorization', auth.operator)
        .send({ amount: 5, note: 'goodwill credit' });
      assert.equal(res.status, 500);
    } finally {
      prisma.opsAuditLog.create = original;
    }
    assert.equal(prisma.store.user.find((u) => u.id === member.id).totalPoints, 10);
    assert.equal(prisma.store.point.length, 0);
  });

  it('a failed generic write is logged as an error only; the answer stands', async () => {
    const original = prisma.opsAuditLog.create;
    const originalLog = auditLog.error;
    const logged = [];
    prisma.opsAuditLog.create = async () => { throw Object.assign(new Error('relation does not exist: SECRET'), { name: 'PrismaClientKnownRequestError' }); };
    auditLog.error = (event, entry) => logged.push([event, entry]);
    try {
      const res = await request(server).post('/api/ops/links').set('Authorization', auth.operator).send(LINK);
      assert.equal(res.status, 201);
      await settle();
    } finally {
      prisma.opsAuditLog.create = original;
      auditLog.error = originalLog;
    }
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], 'ops_audit_write_failed');
    assert.equal(logged[0][1].errorName, 'PrismaClientKnownRequestError');
    assert.ok(!JSON.stringify(logged).includes('SECRET'), 'never the error message');
  });

  it('a userId param names a user target; an id param names the path\'s first segment', () => {
    const actor = { kind: 'user', userId: 'a', username: 'a@example.test', role: 'operator' };
    const userRow = _internals.genericWriteRow(
      { method: 'POST', opsAdmin: actor, reqId: 'r1', opsRoute: { baseUrl: '/api/ops', path: '/merchants/:userId/credit', params: { userId: 'u-9' } } },
      { statusCode: 200 },
    );
    assert.deepEqual(userRow.target, { type: 'user', id: 'u-9' });
    assert.deepEqual(userRow.detail, { method: 'POST', route: '/api/ops/merchants/:userId/credit', params: { userId: 'u-9' }, status: 200 });
    const idRow = _internals.genericWriteRow(
      { method: 'POST', opsAdmin: actor, opsRoute: { baseUrl: '/api/ops', path: '/campaigns/:id/raffle/wins/:winId/fulfill', params: { id: 'c-1', winId: 'w-1' } } },
      { statusCode: 200 },
    );
    assert.deepEqual(idRow.target, { type: 'campaigns', id: 'c-1' });
  });
});
