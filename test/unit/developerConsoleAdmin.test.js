/**
 * The developer console's role endpoints (admin issue #2, contract §3.10): GET /me, the DDC admin
 * view of every SSO client, the staff network unlock, and registration by role while self-serve
 * registration is closed. Through the REAL application on the in-memory Prisma stand-in.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, ISSUER } = require('../helpers/opsApp');

const PARTNER_SECRET = 'tge-secret-dev-for-console-admin';
const { prisma, app } = installOpsApp({
  env: {
    SSO_TGE_ENABLED: 'true',
    SSO_TGE_CLIENT_ID: 'tge-test',
    SSO_TGE_CLIENT_NAME: 'DDC TGE',
    SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update(PARTNER_SECRET).digest('hex'),
    SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/oauth/callback',
  },
  unset: ['STAFF_UNLOCK_TOKEN'],
});
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { initDeveloperRegistration } = require('../../src/constants/developerRegistration');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const UNLOCK = 'ab'.repeat(32);
const SECRET_HASH = 'f'.repeat(64);

const people = {};
const auth = {};
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  initDeveloperRegistration({ env: {} });
  delete process.env.STAFF_UNLOCK_TOKEN;
  people.admin = await seedUser(prisma, { email: 'sloan@example.test' });
  await grant(prisma, people.admin.id, 'ddc_admin');
  people.operator = await seedUser(prisma, { email: 'op@example.test' });
  await grant(prisma, people.operator.id, 'operator');
  people.developer = await seedUser(prisma, { email: 'tge@example.test' });
  await grant(prisma, people.developer.id, 'developer');
  people.plain = await seedUser(prisma, { email: 'member@example.test' });
  for (const [name, user] of Object.entries(people)) auth[name] = bearer(tokens.wallet(user));
});
after(() => {
  initDeveloperRegistration({ env: {} });
  delete process.env.STAFF_UNLOCK_TOKEN;
});

const get = (path, authorization) => {
  const req = request(server).get(`/api/developer/sso${path}`);
  if (authorization) req.set('Authorization', authorization);
  return req;
};

/** Counts every call into the in-memory Prisma until restored. */
function watchDatabase() {
  let calls = 0;
  const undo = [];
  const wrap = (owner, key) => {
    const original = owner[key];
    owner[key] = function counted(...args) {
      calls += 1;
      return original.apply(this, args);
    };
    undo.push(() => { owner[key] = original; });
  };
  for (const [name, value] of Object.entries(prisma)) {
    if (name === 'reset' || name === 'store') continue;
    if (typeof value === 'function') wrap(prisma, name);
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [method, fn] of Object.entries(value)) if (typeof fn === 'function') wrap(value, method);
    }
  }
  return { get calls() { return calls; }, restore: () => undo.forEach((fn) => fn()) };
}

describe('GET /api/developer/sso/me', () => {
  it('answers any signed-in account with its roles, admin and can_register', async () => {
    const plain = await get('/me', auth.plain);
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(plain.headers['cache-control'], 'no-store');
    assert.deepEqual(plain.body, { user_id: people.plain.id, email: 'member@example.test', roles: [], admin: false, can_register: false });

    const developer = (await get('/me', auth.developer)).body;
    assert.deepEqual([developer.roles, developer.admin, developer.can_register], [['developer'], false, true]);

    const admin = (await get('/me', auth.admin)).body;
    assert.deepEqual([admin.roles, admin.admin, admin.can_register], [['ddc_admin'], true, true]);

    const operator = (await get('/me', auth.operator)).body;
    assert.deepEqual([operator.roles, operator.admin, operator.can_register], [['operator'], false, false]);
  });

  it('can_register is true for everyone while registration is open', async () => {
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'on' } });
    assert.equal((await get('/me', auth.plain)).body.can_register, true);
  });

  it('needs a wallet sign-in: none is 401, an ops token is 401', async () => {
    assert.equal((await get('/me')).status, 401);
    assert.equal((await get('/me', bearer(tokens.ops(people.admin)))).status, 401);
  });
});

describe('GET /api/developer/sso/admin/clients', () => {
  beforeEach(async () => {
    await prisma.ssoDeveloperClient.create({
      data: {
        clientId: 'sso-rehearsal', clientName: 'Data Planet', contactEmail: 'planet@example.test', secretHash: SECRET_HASH,
        redirectUris: ['https://planet.example.test/cb'], enabled: true, kind: 'partner', ownerUserId: people.developer.id,
        createdAt: new Date('2026-10-05T00:00:00Z'),
      },
    });
    await prisma.ssoDeveloperClient.create({
      data: {
        clientId: 'sso_member_app', clientName: 'Member app', contactEmail: 'member@example.test', secretHash: SECRET_HASH,
        redirectUris: ['https://member.example.test/cb'], enabled: false, kind: 'developer', ownerUserId: people.plain.id,
        createdAt: new Date('2026-10-06T00:00:00Z'),
      },
    });
  });

  it('is ddc_admin only: everyone else gets 403 forbidden and no data', async () => {
    for (const name of ['operator', 'developer', 'plain']) {
      const res = await get('/admin/clients', auth[name]);
      assert.equal(res.status, 403, name);
      assert.equal(res.body.error, 'forbidden', name);
      assert.equal(res.body.clients, undefined, name);
    }
    assert.equal((await get('/admin/clients')).status, 401);
  });

  it('lists every registry row and the environment partner, read-only, with owners and never a secret', async () => {
    const res = await get('/admin/clients', auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.issuer, ISSUER);
    const byId = Object.fromEntries(res.body.clients.map((c) => [c.client_id, c]));
    assert.deepEqual(Object.keys(byId).sort(), ['sso-rehearsal', 'sso_member_app', 'tge-test']);

    const keys = ['client_id', 'client_name', 'kind', 'managed', 'source', 'enabled', 'redirect_uris', 'scopes', 'contact_email', 'owner_user_id', 'owner_email', 'created_at'];
    for (const client of res.body.clients) assert.deepEqual(Object.keys(client).sort(), [...keys].sort(), client.client_id);

    assert.equal(byId['sso-rehearsal'].source, 'registry');
    assert.equal(byId['sso-rehearsal'].kind, 'partner');
    assert.equal(byId['sso-rehearsal'].owner_user_id, people.developer.id);
    assert.equal(byId['sso-rehearsal'].owner_email, 'tge@example.test');
    assert.equal(byId['sso-rehearsal'].contact_email, 'planet@example.test');
    assert.equal(byId.sso_member_app.enabled, false);
    assert.equal(byId.sso_member_app.owner_email, 'member@example.test');
    assert.deepEqual(
      { source: byId['tge-test'].source, managed: byId['tge-test'].managed, kind: byId['tge-test'].kind, owner: byId['tge-test'].owner_user_id },
      { source: 'environment', managed: true, kind: 'partner', owner: null },
    );
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(SECRET_HASH), 'never a secret hash');
    assert.ok(!text.includes(PARTNER_SECRET), 'never a secret');
    assert.ok(!text.includes(crypto.createHash('sha256').update(PARTNER_SECRET).digest('hex')), 'never the partner secret hash');
    assert.ok(!/secret/i.test(Object.keys(res.body.clients[0]).join(',')));
  });

  it('the environment partner is listed once when it also has a registry row', async () => {
    await prisma.ssoDeveloperClient.create({
      data: { clientId: 'tge-test', clientName: 'TGE row', contactEmail: 'tge@example.test', secretHash: SECRET_HASH, redirectUris: [], enabled: true, kind: 'partner', ownerUserId: people.developer.id },
    });
    const res = await get('/admin/clients', auth.admin);
    const tge = res.body.clients.filter((c) => c.client_id === 'tge-test');
    assert.equal(tge.length, 1);
    assert.equal(tge[0].source, 'registry');
  });
});

describe('GET /api/developer/sso/admin/staff-unlock', () => {
  it('is ddc_admin only', async () => {
    process.env.STAFF_UNLOCK_TOKEN = UNLOCK;
    for (const name of ['operator', 'developer', 'plain']) {
      const res = await get('/admin/staff-unlock', auth[name]);
      assert.equal(res.status, 403, name);
      assert.equal(res.body.error, 'forbidden');
      assert.ok(!JSON.stringify(res.body).includes(UNLOCK));
    }
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('answers 404 not_configured when unset or not 64 lower-case hex', async () => {
    for (const value of [undefined, '', 'AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32)]) {
      if (value === undefined) delete process.env.STAFF_UNLOCK_TOKEN;
      else process.env.STAFF_UNLOCK_TOKEN = value;
      const res = await get('/admin/staff-unlock', auth.admin);
      assert.equal(res.status, 404, String(value));
      assert.equal(res.body.error, 'not_configured');
    }
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('hands a ddc_admin the unlock and writes console.staff_unlock on the console surface', async () => {
    process.env.STAFF_UNLOCK_TOKEN = UNLOCK;
    const res = await get('/admin/staff-unlock', auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, { unlock_token: UNLOCK });
    const rows = prisma.store.opsAuditLog;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'console.staff_unlock');
    assert.equal(rows[0].surface, 'console');
    assert.equal(rows[0].actorKind, 'user');
    assert.equal(rows[0].actorUserId, people.admin.id);
    assert.equal(rows[0].actorLabel, 'sloan@example.test');
    assert.equal(rows[0].actorRole, 'ddc_admin');
    assert.ok(!JSON.stringify(rows).includes(UNLOCK), 'the unlock itself is never recorded');
  });

  it('is not handed out when the audit row cannot be written', async () => {
    process.env.STAFF_UNLOCK_TOKEN = UNLOCK;
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw new Error('audit store down'); };
    try {
      const res = await get('/admin/staff-unlock', auth.admin);
      assert.equal(res.status, 500);
      assert.ok(!JSON.stringify(res.body).includes(UNLOCK));
    } finally {
      prisma.opsAuditLog.create = original;
    }
  });
});

describe('POST /api/developer/sso/clients while registration is closed', () => {
  const body = { client_name: 'Partner app', contact_email: 'dev@example.test', redirect_uris: ['https://partner.example.test/cb'] };
  const register = (authorization) => {
    const req = request(server).post('/api/developer/sso/clients');
    if (authorization) req.set('Authorization', authorization);
    return req.send(body);
  };
  const CLOSED = 'registration_closed';

  it('the developer and ddc_admin roles may register; the client belongs to the caller', async () => {
    for (const name of ['developer', 'admin']) {
      clearRateLimitStore();
      const res = await register(auth[name]);
      assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.body)}`);
      const row = prisma.store.ssoDeveloperClient.find((c) => c.clientId === res.body.client_id);
      assert.equal(row.ownerUserId, people[name].id);
    }
  });

  it('any other account gets 403 registration_closed and nothing is written', async () => {
    for (const name of ['plain', 'operator']) {
      const res = await register(auth[name]);
      assert.equal(res.status, 403, name);
      assert.equal(res.body.error, CLOSED);
    }
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('a disabled developer is refused by the login check', async () => {
    prisma.store.user.find((u) => u.id === people.developer.id).disabledAt = new Date();
    const res = await register(auth.developer);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ACCOUNT_DISABLED');
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('no token: 403 registration_closed with no database access at all', async () => {
    const db = watchDatabase();
    let res;
    try {
      res = await register();
    } finally {
      db.restore();
    }
    assert.equal(res.status, 403);
    assert.equal(res.body.error, CLOSED);
    assert.equal(db.calls, 0);
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });
});
