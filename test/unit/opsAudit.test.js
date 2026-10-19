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

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, settle, recordLabel, JWT_SECRET } = require('../helpers/opsApp');

const { prisma, app } = installOpsApp();
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const {
  writeAudit, auditLog, auditOpsWrites, auditInChange, noteCreated, _internals,
  actorFromOps, actorFromUser, recordLabelOf, staffRecordLabel, SCRIPT_ACTOR,
} = require('../../src/services/opsAudit');
const { opsRoutes } = require('../../src/routes/opsAdminRoutes');

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
  admin = await seedUser(prisma, { email: 'admin@example.test' });
  await grant(prisma, admin.id, 'ddc_admin');
  operator = await seedUser(prisma, { email: 'op@example.test' });
  await grant(prisma, operator.id, 'operator');
  auth.admin = bearer(tokens.ops(admin));
  auth.operator = bearer(tokens.ops(operator));
});

const getAudit = (query = '', authorization = auth.admin) =>
  request(server).get(`/api/ops/audit${query}`).set('Authorization', authorization);

const ACTOR = { kind: 'user', userId: 'actor-1', label: 'admin@example.test', role: 'ddc_admin' };

/** Rows with fixed times, oldest first, so filters and paging have something to bite on. */
async function seedRows() {
  const rows = [
    ['2026-10-01T00:00:00Z', 'role.grant', { type: 'user', id: 'u-1' }, ACTOR],
    ['2026-10-02T00:00:00Z', 'role.revoke', { type: 'user', id: 'u-1' }, ACTOR],
    ['2026-10-03T00:00:00Z', 'account.disable', { type: 'user', id: 'u-2' }, ACTOR],
    ['2026-10-04T00:00:00Z', 'points.adjust', { type: 'user', id: 'u-2' }, { ...ACTOR, userId: 'actor-2', label: 'second-admin@example.test' }],
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
    assert.deepEqual(row.actor, { kind: 'user', userId: 'actor-2', label: 'second-admin@example.test', role: 'ddc_admin' });
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
    assert.equal(post.targetId, id, 'a create records the id it made');
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

  it('a personal session writes its record label into the point, never its e-mail; the audit row keeps who acted', async () => {
    const member = await seedUser(prisma, { totalPoints: 10 });
    const res = await request(server)
      .post(`/api/ops/users/${member.id}/points`)
      .set('Authorization', auth.operator)
      .send({ amount: -4, note: 'duplicate grant' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const label = recordLabel(operator.id);
    const [point] = prisma.store.point;
    assert.ok(point.sourceId.endsWith(`__${label}`), point.sourceId);
    assert.equal(res.body.data.adjustedBy, label);
    assert.ok(!JSON.stringify(point).includes('op@example.test'));
    assert.ok(!JSON.stringify(res.body.data.sourceId).includes('@'));
    await settle();
    const [row] = prisma.store.opsAuditLog;
    assert.equal(row.actorLabel, 'op@example.test');
    assert.equal(row.actorUserId, operator.id);
  });

  it('a deduction larger than the balance is refused (400) and moves nothing', async () => {
    const member = await seedUser(prisma, { totalPoints: 3 });
    const res = await request(server)
      .post(`/api/ops/users/${member.id}/points`)
      .set('Authorization', auth.operator)
      .send({ amount: -4, note: 'too much' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /Insufficient balance: 3/);
    assert.equal(prisma.store.user.find((u) => u.id === member.id).totalPoints, 3);
    assert.equal(prisma.store.point.length, 0);
    await settle();
    assert.equal(prisma.store.opsAuditLog.length, 0);
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

  it('a refused generic audit fails the request and rolls the business write back', async () => {
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw Object.assign(new Error('relation does not exist: SECRET'), { name: 'PrismaClientKnownRequestError' }); };
    try {
      const res = await request(server).post('/api/ops/links').set('Authorization', auth.operator).send(LINK);
      assert.equal(res.status, 500);
      assert.ok(!JSON.stringify(res.body).includes('SECRET'));
    } finally {
      prisma.opsAuditLog.create = original;
    }
    assert.equal(prisma.store.trackedLink.length, 0);
    assert.equal(prisma.store.opsAuditLog.length, 0);
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

  it('a create names what it made (noteCreated): its id, and a type when the path segment is not one', () => {
    const actor = { kind: 'user', userId: 'a', username: 'a@example.test', role: 'operator' };
    const created = { method: 'POST', opsAdmin: actor, opsRoute: { baseUrl: '/api/ops', path: '/campaigns', params: {} } };
    noteCreated(created, 'camp-1');
    assert.deepEqual(_internals.genericWriteRow(created, { statusCode: 200 }).target, { type: 'campaigns', id: 'camp-1' });
    const cover = { method: 'POST', opsAdmin: actor, opsRoute: { baseUrl: '/api/ops', path: '/campaigns/cover', params: {} } };
    noteCreated(cover, '/assets/campaigns/x.png', 'campaign_cover');
    assert.deepEqual(_internals.genericWriteRow(cover, { statusCode: 200 }).target, { type: 'campaign_cover', id: '/assets/campaigns/x.png' });
    const none = { method: 'POST', opsAdmin: actor, opsRoute: { baseUrl: '/api/ops', path: '/campaigns/translate', params: {} } };
    noteCreated(none, null);
    assert.deepEqual(_internals.genericWriteRow(none, { statusCode: 200 }).target, { type: 'campaigns', id: null });
  });

  it('every ops create route without an id in its path names what it made', () => {
    // POST routes whose path has no parameter: each either creates and calls noteCreated, or
    // creates nothing (translate) or writes its own row (planet manager).
    const paramless = opsRoutes.filter((route) => route.method === 'post' && !route.path.includes(':')).map((route) => route.path).sort();
    assert.deepEqual(paramless, ['/campaigns', '/campaigns/cover', '/campaigns/translate', '/links', '/sso/planet-manager']);
    const fs = require('fs');
    const path = require('path');
    const read = (file) => fs.readFileSync(path.join(__dirname, '../../src/controllers', file), 'utf8');
    const campaigns = read('opsCampaignController.js');
    assert.match(campaigns, /exports\.create = [\s\S]*?noteCreated\(req, row\.id\)/);
    assert.match(campaigns, /exports\.uploadCover = [\s\S]*?noteCreated\(req, pathName, 'campaign_cover'\)/);
    assert.match(read('trackedLinkController.js'), /async function create[\s\S]*?noteCreated\(req, data && data\.id\)/);
  });
});

describe('money routes write their row inside the change', () => {
  it('every mounted mutation declares exactly one explicit audit boundary', () => {
    for (const route of opsRoutes) {
      if (['get', 'head', 'options'].includes(route.method)) continue;
      assert.equal([route.audit, route.genericAudit, route.selfAudit].filter(Boolean).length, 1, `${route.method} ${route.path}`);
    }
    assert.equal(opsRoutes.filter((route) => route.genericAudit === 'transaction').length, 12);
    assert.deepEqual(opsRoutes.filter((route) => route.genericAudit === 'external').map((r) => r.path).sort(), ['/campaigns/cover', '/campaigns/translate']);
  });
  it('the route table marks exactly the routes that move money or balances, each with its action', () => {
    const marked = opsRoutes.filter((route) => route.audit).map((route) => `${route.method} ${route.path} ${route.audit}`).sort();
    assert.deepEqual(marked, [
      'post /campaigns/:id/raffle/draw raffle.draw',
      'post /demands/:id/fulfill demand.fulfill',
      'post /disbursements/items/:id/process disbursement.process',
      'post /disbursements/redemptions/:id/disburse disbursement.disburse',
      'post /merchants/:userId/credit merchant.credit',
      'post /orders/:id/attest order.attest',
      'post /payments/:id/confirm payment.confirm',
      'post /payments/:id/reject payment.reject',
    ]);
  });

  it('an unknown action is refused when the route is declared', () => {
    assert.throws(() => auditInChange('payment.anything'), /Unknown audit action/);
  });

  it('a marked route gets no generic row, also when it changed nothing', async () => {
    const req = { method: 'POST', opsAdmin: { kind: 'user', userId: admin.id, username: admin.email, role: 'ddc_admin' }, reqId: 'r-money' };
    let nextCalled = false;
    auditInChange('payment.confirm')(req, {}, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.equal(typeof req.auditChange, 'function');
    const res = { statusCode: 200, end() {} };
    auditOpsWrites(req, res, () => {});
    res.end();
    await settle();
    assert.equal(prisma.store.opsAuditLog.length, 0);

    const row = await req.auditChange(prisma, { target: { type: 'payment', id: 'pay-1' }, detail: { amount: 1 } });
    assert.equal(row.action, 'payment.confirm');
    assert.equal(row.actorUserId, admin.id);
    assert.equal(row.requestId, 'r-money');
    assert.equal(row.surface, 'ops');
  });
});

describe('who acted, inside and outside the audit log', () => {
  it('a personal session: the audit label is its e-mail, the record label is a keyed hash of its id', () => {
    const userId = '0f1e2d3c-aaaa-bbbb-cccc-000000000000';
    const ops = { kind: 'user', userId, username: recordLabel(userId), email: 'person@example.test', role: 'operator' };
    const actor = actorFromOps(ops);
    assert.equal(actor.label, 'person@example.test');
    assert.equal(actor.recordLabel, recordLabel(userId));
    assert.match(actor.recordLabel, /^ops:[0-9a-f]{10}$/);
    assert.equal(recordLabelOf(actor), recordLabel(userId));
    // Even an actor built with only an e-mail label writes no e-mail into a record.
    assert.equal(recordLabelOf({ kind: 'user', userId: '0f1e2d3c-1', label: 'person@example.test' }), recordLabel('0f1e2d3c-1'));
    assert.equal(recordLabelOf(actorFromUser({ id: 'abcdef012345', email: 'dev@example.test' }, 'developer')), recordLabel('abcdef012345'));
  });

  it('the record label holds no part of the id, is stable per account and depends on the server key', () => {
    const ids = ['0f1e2d3c-aaaa-bbbb-cccc-000000000000', 'abcdef012345', 'cm0000000000000000000001', 'cm0000000000000000000002'];
    const labels = ids.map((id) => staffRecordLabel(id));
    labels.forEach((label, i) => {
      assert.match(label, /^ops:[0-9a-f]{10}$/);
      assert.ok(!label.includes(ids[i].slice(0, 6)), `${label} carries no prefix of ${ids[i]}`);
      assert.equal(staffRecordLabel(ids[i]), label, 'the same account gets the same label');
    });
    assert.equal(new Set(labels).size, ids.length, 'ids that share a prefix get different labels');

    const saved = process.env.JWT_SECRET;
    try {
      process.env.JWT_SECRET = 'another-server-key';
      assert.equal(staffRecordLabel(ids[0]), recordLabel(ids[0], 'another-server-key'));
      assert.notEqual(staffRecordLabel(ids[0]), labels[0], 'another key gives another label');
      delete process.env.JWT_SECRET;
      assert.equal(staffRecordLabel(ids[0]), 'ops', 'no key: no label that could be computed from the id');
    } finally {
      process.env.JWT_SECRET = saved;
    }
    assert.equal(process.env.JWT_SECRET, JWT_SECRET);
  });

  it('the shared login and the script keep their names; an empty id gives "ops"', () => {
    assert.equal(recordLabelOf(actorFromOps({ kind: 'shared', username: 'shared', role: 'shared' })), 'shared');
    assert.equal(recordLabelOf(SCRIPT_ACTOR), 'script');
    assert.equal(staffRecordLabel(''), 'ops');
    assert.throws(() => actorFromOps({ kind: 'demo', role: 'demo' }), /cannot change/);
  });
});
