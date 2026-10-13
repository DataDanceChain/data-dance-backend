/**
 * POST /api/ops/sso/planet-manager (admin issue #2, contract §3.8): now ops.admin, a reason is
 * required, the API host is checked against PLANET_MANAGER_API_HOSTS (exact host, not a substring),
 * and the change and its audit row are one transaction. Through the REAL application on the
 * in-memory Prisma stand-in.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens } = require('../helpers/opsApp');

const { prisma, app } = installOpsApp({ unset: ['PLANET_MANAGER_API_HOSTS'] });
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { planetManagerHostAllowed, planetManagerApiHosts } = require('../../src/services/ssoDeveloperLive');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));
after(() => { delete process.env.PLANET_MANAGER_API_HOSTS; });

let admin;
let adminAuth;
let manager;
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  delete process.env.OPS_SHARED_LOGIN;
  // The test API host (PUBLIC_BASE_URL = https://api.test.local) is a Data Planet host here.
  process.env.PLANET_MANAGER_API_HOSTS = 'api.test.local';
  admin = await seedUser(prisma, { email: 'sloan@example.test' });
  await grant(prisma, admin.id, 'ddc_admin');
  adminAuth = bearer(tokens.ops(admin));
  manager = await seedUser(prisma, { email: 'planet@example.test' });
});

const assign = (body, authorization = adminAuth) =>
  request(server).post('/api/ops/sso/planet-manager').set('Authorization', authorization).send(body);
const planetRow = () => prisma.store.ssoDeveloperClient.find((row) => row.clientId === 'sso-rehearsal') || null;

describe('who may assign', () => {
  it('ops.admin only: operator, shared and demo are refused before anything changes', async () => {
    const operator = await seedUser(prisma);
    await grant(prisma, operator.id, 'operator');
    const refused = await assign({ email: 'planet@example.test', reason: 'Data Planet lead' }, bearer(tokens.ops(operator)));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'FORBIDDEN_ROLE');

    process.env.OPS_SHARED_LOGIN = 'on';
    const shared = await assign({ email: 'planet@example.test', reason: 'Data Planet lead' }, bearer(tokens.shared()));
    assert.equal(shared.status, 403);
    assert.equal(shared.body.code, 'FORBIDDEN_ROLE');

    const demo = await assign({ email: 'planet@example.test', reason: 'Data Planet lead' }, bearer(tokens.demo()));
    assert.equal(demo.status, 403);

    assert.equal(planetRow(), null);
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });
});

describe('the assignment', () => {
  it('needs a reason of 3..200 characters: 400 REASON_REQUIRED', async () => {
    for (const reason of [undefined, '', '  ', 'no', 'x'.repeat(201)]) {
      const res = await assign({ email: 'planet@example.test', reason });
      assert.equal(res.status, 400, String(reason));
      assert.equal(res.body.code, 'REASON_REQUIRED');
    }
    assert.equal(planetRow(), null);
  });

  it('creates the client row on first assignment and writes sso.planet_manager.assign', async () => {
    const res = await assign({ email: 'Planet@Example.test', reason: 'Data Planet lead' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, {
      client_id: 'sso-rehearsal',
      email: 'planet@example.test',
      user_id: manager.id,
      network: 'mainnet',
      previous_owner_user_id: null,
    });
    const row = planetRow();
    assert.equal(row.ownerUserId, manager.id);
    assert.equal(row.kind, 'partner');
    assert.equal(row.enabled, false);
    const audit = prisma.store.opsAuditLog;
    assert.equal(audit.length, 1, 'one row: no generic ops.write row on top');
    assert.equal(audit[0].action, 'sso.planet_manager.assign');
    assert.equal(audit[0].targetType, 'sso_client');
    assert.equal(audit[0].targetId, 'sso-rehearsal');
    assert.equal(audit[0].reason, 'Data Planet lead');
    assert.equal(audit[0].actorUserId, admin.id);
    assert.deepEqual(audit[0].detail, { previousOwnerUserId: null, newOwnerUserId: manager.id });
    assert.ok(!JSON.stringify(audit).includes(row.secretHash), 'never the secret hash');
  });

  it('moves an existing row to the new owner and reports the previous one', async () => {
    await assign({ email: 'planet@example.test', reason: 'Data Planet lead' });
    const next = await seedUser(prisma, { email: 'next@example.test' });
    const res = await assign({ email: 'next@example.test', reason: 'handover to the new lead' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.previous_owner_user_id, manager.id);
    assert.equal(planetRow().ownerUserId, next.id);
    assert.equal(prisma.store.ssoDeveloperClient.length, 1);
    const last = prisma.store.opsAuditLog[prisma.store.opsAuditLog.length - 1];
    assert.deepEqual(last.detail, { previousOwnerUserId: manager.id, newOwnerUserId: next.id });
  });

  it('refuses an unknown e-mail (404) and a disabled account (403), changing nothing', async () => {
    const unknown = await assign({ email: 'nobody@example.test', reason: 'Data Planet lead' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'not_found');
    await seedUser(prisma, { email: 'gone@example.test', disabledAt: new Date() });
    const disabled = await assign({ email: 'gone@example.test', reason: 'Data Planet lead' });
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.code, 'account_disabled');
    assert.equal(planetRow(), null);
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('a failed audit write leaves the owner as it was', async () => {
    await assign({ email: 'planet@example.test', reason: 'Data Planet lead' });
    const next = await seedUser(prisma, { email: 'next@example.test' });
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw new Error('audit store down'); };
    try {
      const res = await assign({ email: 'next@example.test', reason: 'handover to the new lead' });
      assert.equal(res.status, 500);
    } finally {
      prisma.opsAuditLog.create = original;
    }
    assert.equal(planetRow().ownerUserId, manager.id);
    assert.notEqual(planetRow().ownerUserId, next.id);
  });
});

describe('the API host check', () => {
  it('this API must be one of PLANET_MANAGER_API_HOSTS: 409 wrong_network otherwise', async () => {
    delete process.env.PLANET_MANAGER_API_HOSTS; // default: api.datadance.ai, api-rehearsal.datadance.ai
    const res = await assign({ email: 'planet@example.test', reason: 'Data Planet lead' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'wrong_network');
    assert.equal(planetRow(), null);
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('matches the exact host of PUBLIC_BASE_URL, never a substring', () => {
    assert.deepEqual(planetManagerApiHosts({}), ['api.datadance.ai', 'api-rehearsal.datadance.ai']);
    assert.deepEqual(planetManagerApiHosts({ PLANET_MANAGER_API_HOSTS: ' API.example.test , ,b.example.test ' }), ['api.example.test', 'b.example.test']);
    const allowed = (base, hosts) => planetManagerHostAllowed({ PUBLIC_BASE_URL: base, PLANET_MANAGER_API_HOSTS: hosts });
    assert.equal(allowed('https://api.datadance.ai'), true);
    assert.equal(allowed('https://api-rehearsal.datadance.ai/'), true);
    assert.equal(allowed('https://API.DataDance.ai'), true);
    assert.equal(allowed('https://api.datadance.ai.evil.example'), false);
    assert.equal(allowed('https://evil.example/api-rehearsal.datadance.ai'), false);
    assert.equal(allowed('https://api-staging.datadance.ai'), false);
    assert.equal(allowed('not a url'), false);
    assert.equal(allowed(''), false);
    assert.equal(allowed('https://api.example.test', 'api.example.test'), true);
    assert.equal(allowed('https://api.datadance.ai', 'api.example.test'), false);
  });
});
