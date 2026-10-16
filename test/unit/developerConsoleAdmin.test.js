/**
 * The developer console's role endpoints (admin issue #2, contract §3.10): GET /me, the DDC admin
 * view of every SSO client, the staff network unlock, and registration by role while self-serve
 * registration is closed. Through the REAL application on the in-memory Prisma stand-in.
 */
const { describe, it, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const jwt = require('jsonwebtoken');
const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, ISSUER, JWT_SECRET } = require('../helpers/opsApp');

const PARTNER_SECRET = 'tge-secret-dev-for-console-admin';
const TGE_INITIATE = 'https://tge.example.com/login/ddc';
const { prisma, app } = installOpsApp({
  env: {
    SSO_TGE_ENABLED: 'true',
    SSO_TGE_CLIENT_ID: 'tge-test',
    SSO_TGE_CLIENT_NAME: 'DDC TGE',
    SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update(PARTNER_SECRET).digest('hex'),
    SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/oauth/callback',
    SSO_TGE_INITIATE_LOGIN_URI: TGE_INITIATE,
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
    assert.deepEqual(plain.body, {
      user_id: people.plain.id, email: 'member@example.test', roles: [], admin: false, can_register: false, verified_session: true,
    });

    const developer = (await get('/me', auth.developer)).body;
    assert.deepEqual([developer.roles, developer.admin, developer.can_register], [['developer'], false, true]);

    const admin = (await get('/me', auth.admin)).body;
    assert.deepEqual([admin.roles, admin.admin, admin.can_register], [['ddc_admin'], true, true]);

    const operator = (await get('/me', auth.operator)).body;
    assert.deepEqual([operator.roles, operator.admin, operator.can_register], [['operator'], false, false]);
  });

  it('verified_session tells the console whether the staff routes will take this sign-in', async () => {
    const older = (await get('/me', bearer(tokens.wallet(people.admin, { ver: 1 })))).body;
    assert.equal(older.verified_session, false);
    assert.equal(older.admin, true);
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
        initiateLoginUri: 'https://planet.example.test/start',
        createdAt: new Date('2026-10-05T00:00:00Z'),
      },
    });
    await prisma.ssoDeveloperClient.create({
      data: {
        clientId: 'sso_member_app', clientName: 'Member app', contactEmail: 'member@example.test', secretHash: SECRET_HASH,
        redirectUris: ['https://member.example.test/cb'], enabled: false, kind: 'developer', ownerUserId: people.plain.id,
        // A developer row never hands off, whatever its column holds.
        initiateLoginUri: 'https://member.example.test/start',
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

    const keys = ['client_id', 'client_name', 'kind', 'managed', 'source', 'enabled', 'redirect_uris', 'scopes', 'initiate_login_uri', 'contact_email', 'owner_user_id', 'owner_email', 'created_at'];
    for (const client of res.body.clients) assert.deepEqual(Object.keys(client).sort(), [...keys].sort(), client.client_id);

    assert.equal(byId['sso-rehearsal'].source, 'registry');
    assert.equal(byId['sso-rehearsal'].kind, 'partner');
    assert.equal(byId['sso-rehearsal'].owner_user_id, people.developer.id);
    assert.equal(byId['sso-rehearsal'].owner_email, 'tge@example.test');
    assert.equal(byId['sso-rehearsal'].contact_email, 'planet@example.test');
    assert.equal(byId.sso_member_app.enabled, false);
    assert.equal(byId.sso_member_app.owner_email, 'member@example.test');
    // The App hand-off target (#71): a partner row's column, the environment's value, never a developer row's.
    assert.deepEqual(
      Object.fromEntries(res.body.clients.map((c) => [c.client_id, c.initiate_login_uri])),
      { 'sso-rehearsal': 'https://planet.example.test/start', sso_member_app: null, 'tge-test': TGE_INITIATE },
    );
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
    // The environment's value wins for its client, as at the hand-off.
    assert.equal(tge[0].initiate_login_uri, TGE_INITIATE);
  });

  it('a partner row whose stored hand-off target fails the rule shows none, as the hand-off reads it', async () => {
    await prisma.ssoDeveloperClient.create({
      data: {
        clientId: 'sso-bad-start', clientName: 'Bad start', contactEmail: 'planet@example.test', secretHash: SECRET_HASH,
        redirectUris: [], enabled: true, kind: 'partner', ownerUserId: people.developer.id,
        initiateLoginUri: 'http://planet.example.test/start',
      },
    });
    const res = await get('/admin/clients', auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.clients.find((c) => c.client_id === 'sso-bad-start').initiate_login_uri, null);
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

/** A wallet JWT issued `secondsAgo` seconds ago. */
const walletIssued = (user, secondsAgo, { ver = 2 } = {}) =>
  bearer(jwt.sign({ id: user.id, ver, iat: Math.floor(Date.now() / 1000) - secondsAgo }, JWT_SECRET, { expiresIn: '1h' }));

describe('the console staff routes need a staff session (the rule of POST /api/ops/auth/code)', () => {
  const register = (authorization) => request(server)
    .post('/api/developer/sso/clients')
    .set('Authorization', authorization)
    .send({ client_name: 'Partner app', contact_email: 'dev@example.test', redirect_uris: ['https://partner.example.test/cb'] });

  it('a ddc_admin with an older sign-in (ver < 2) gets 403 verified_session_required and no data', async () => {
    process.env.STAFF_UNLOCK_TOKEN = UNLOCK;
    const older = bearer(tokens.wallet(people.admin, { ver: 1 }));
    for (const path of ['/admin/clients', '/admin/staff-unlock']) {
      const res = await get(path, older);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error, 'verified_session_required', path);
      assert.equal(res.body.clients, undefined);
      assert.equal(res.body.unlock_token, undefined);
    }
    assert.equal(prisma.store.opsAuditLog.length, 0, 'no unlock was handed out');
  });

  it('registering while registration is closed needs ver 2 too; no client is written', async () => {
    for (const name of ['developer', 'admin']) {
      clearRateLimitStore();
      const res = await register(bearer(tokens.wallet(people[name], { ver: 1 })));
      assert.equal(res.status, 403, name);
      assert.equal(res.body.error, 'verified_session_required', name);
    }
    // An account without the role still gets the answer it got before.
    const plain = await register(bearer(tokens.wallet(people.plain, { ver: 1 })));
    assert.equal(plain.body.error, 'registration_closed');
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('while registration is open, registering needs no role and no verified session (unchanged)', async () => {
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'on' } });
    const res = await register(bearer(tokens.wallet(people.plain, { ver: 1 })));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(prisma.store.opsAuditLog.length, 0, 'open self-serve registration is not a staff action');
  });

  it('a wallet JWT issued before the account was last disabled / re-enabled gets 401 session_revoked', async () => {
    const before = walletIssued(people.admin, 120);
    prisma.store.user.find((u) => u.id === people.admin.id).sessionsResetAt = new Date(Date.now() - 60 * 1000);
    process.env.STAFF_UNLOCK_TOKEN = UNLOCK;
    for (const path of ['/admin/clients', '/admin/staff-unlock']) {
      const res = await get(path, before);
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error, 'session_revoked', path);
    }
    const reg = await register(before);
    assert.equal(reg.status, 401);
    assert.equal(reg.body.error, 'session_revoked');
    // A sign-in after the reset works.
    const after = await get('/admin/clients', walletIssued(people.admin, 0));
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
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

  it('each registration writes one console.client_register row with the role it was made with; never the secret', async () => {
    const made = {};
    for (const name of ['developer', 'admin']) {
      clearRateLimitStore();
      const res = await register(auth[name]);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      made[name] = res.body;
    }
    const rows = prisma.store.opsAuditLog;
    assert.deepEqual(
      rows.map((row) => [row.action, row.surface, row.actorUserId, row.actorRole, row.targetType, row.targetId, row.targetLabel]),
      [
        ['console.client_register', 'console', people.developer.id, 'developer', 'sso_client', made.developer.client_id, 'Partner app'],
        ['console.client_register', 'console', people.admin.id, 'ddc_admin', 'sso_client', made.admin.client_id, 'Partner app'],
      ],
    );
    assert.deepEqual(rows[0].detail, { kind: 'developer', registration: 'closed', redirectUris: 1 });
    const text = JSON.stringify(rows);
    assert.ok(!text.includes(made.developer.client_secret) && !text.includes(made.admin.client_secret), 'no secret in the log');
  });

  it('no audit row, no client: a failed audit write leaves nothing registered', async () => {
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw new Error('audit store down'); };
    let res;
    try {
      res = await register(auth.developer);
    } finally {
      prisma.opsAuditLog.create = original;
    }
    assert.equal(res.status, 500);
    assert.equal(res.body.client_secret, undefined);
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('a failed registration logs the error code and name only, never its message (which can carry the refused row)', async () => {
    const { consoleLog } = require('../../src/routes/developerSsoRoutes');
    const original = prisma.opsAuditLog.create;
    const originalLog = consoleLog.error;
    const logged = [];
    prisma.opsAuditLog.create = async () => {
      throw Object.assign(new Error('Failing row contains (tge@example.test, ddc_client_x, Partner app)'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2010',
      });
    };
    consoleLog.error = (event, entry) => logged.push([event, entry]);
    let res;
    try {
      res = await register(auth.developer);
    } finally {
      prisma.opsAuditLog.create = original;
      consoleLog.error = originalLog;
    }
    assert.equal(res.status, 500);
    assert.deepEqual(logged, [[
      'Developer client registration failed',
      { reqId: logged[0][1].reqId, errorCode: 'P2010', errorName: 'PrismaClientKnownRequestError' },
    ]]);
    const text = JSON.stringify(logged);
    for (const leak of ['tge@example.test', 'Partner app', 'Failing row']) assert.ok(!text.includes(leak), leak);
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

describe('SSO_DEVELOPER_REGISTRATION=allowlist: the list and the roles both admit', () => {
  const GOOGLE = 'web3auth-google-sapphire';
  const body = { client_name: 'Listed app', contact_email: 'dev@example.test', redirect_uris: ['https://listed.example.test/cb'] };
  const register = (authorization) => {
    const req = request(server).post('/api/developer/sso/clients');
    if (authorization) req.set('Authorization', authorization);
    return req.send(body);
  };
  let refusals;
  let originalInfo;
  const routes = require('../../src/routes/developerSsoRoutes');

  beforeEach(async () => {
    people.listed = await seedUser(prisma, { email: 'lead@example.test', web3authVerifier: GOOGLE, web3authVerifierId: 'lead@example.test' });
    auth.listed = bearer(tokens.wallet(people.listed));
    initDeveloperRegistration({
      env: {
        SSO_DEVELOPER_REGISTRATION: 'allowlist',
        SSO_DEVELOPER_ALLOWED_EMAILS: 'lead@example.test',
        WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: GOOGLE,
      },
    });
    refusals = [];
    originalInfo = routes.registrationLog.info;
    routes.registrationLog.info = (event, entry) => refusals.push({ event, entry });
  });
  // After each test, not once at the end: the next beforeEach must save the real logger, not this
  // test's stub, and nothing below this block may inherit a stub.
  afterEach(() => {
    routes.registrationLog.info = originalInfo;
  });
  after(() => {
    initDeveloperRegistration({ env: {} });
  });

  it('a listed account with a verified login e-mail registers with no role and no audit row', async () => {
    const res = await register(auth.listed);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(prisma.store.ssoDeveloperClient[0].ownerUserId, people.listed.id);
    assert.deepEqual(prisma.store.opsAuditLog, []);
    assert.deepEqual(refusals, []);
  });

  it('the developer and ddc_admin roles register though not listed; the audit row names allowlist', async () => {
    for (const name of ['developer', 'admin']) {
      clearRateLimitStore();
      const res = await register(auth[name]);
      assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.body)}`);
    }
    const rows = prisma.store.opsAuditLog;
    assert.deepEqual(rows.map((row) => [row.action, row.actorUserId, row.actorRole]), [
      ['console.client_register', people.developer.id, 'developer'],
      ['console.client_register', people.admin.id, 'ddc_admin'],
    ]);
    assert.deepEqual(rows[0].detail, { kind: 'developer', registration: 'allowlist', redirectUris: 1 });
    assert.deepEqual(refusals, []);
  });

  it('a role still needs a staff session: ver < 2 is 403 verified_session_required, nothing written', async () => {
    const res = await register(bearer(tokens.wallet(people.developer, { ver: 1 })));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'verified_session_required');
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('anyone else gets 403 registration_closed, one refusal line with the allowlist reason, nothing written', async () => {
    for (const name of ['plain', 'operator']) {
      const res = await register(auth[name]);
      assert.equal(res.status, 403, name);
      assert.equal(res.body.error, 'registration_closed');
    }
    assert.deepEqual(refusals.map((r) => [r.entry.userId, r.entry.reason]), [
      [people.plain.id, 'not_listed'],
      [people.operator.id, 'not_listed'],
    ]);
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
    assert.deepEqual(prisma.store.opsAuditLog, []);
  });

  it('anonymous: 401 from the login check, as with on', async () => {
    const res = await register();
    assert.equal(res.status, 401);
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('a listed account\'s session from before its last disable / enable does not count; a newer one does', async () => {
    const older = walletIssued(people.listed, 120);
    prisma.store.user.find((u) => u.id === people.listed.id).sessionsResetAt = new Date(Date.now() - 60 * 1000);

    // The off answer, as for any refused account: it never tells whether the address is listed.
    const res = await register(older);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, 'registration_closed');
    assert.deepEqual(refusals.map((r) => [r.event, r.entry.userId, r.entry.reason]), [
      ['developer_registration.refused', people.listed.id, 'session_revoked'],
    ]);
    assert.equal((await get('/me', older)).body.can_register, false);
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);

    const newer = walletIssued(people.listed, 0);
    assert.equal((await get('/me', newer)).body.can_register, true);
    const ok = await register(newer);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(prisma.store.opsAuditLog, []);
  });

  it('on does not apply the reset rule: any signed-in account still registers (unchanged)', async () => {
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'on' } });
    prisma.store.user.find((u) => u.id === people.listed.id).sessionsResetAt = new Date(Date.now() - 60 * 1000);
    const res = await register(walletIssued(people.listed, 120));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(refusals, []);
  });

  it('GET /me: can_register for a listed account with a verified login e-mail and for the roles, not for anyone else', async () => {
    const answers = {};
    for (const name of ['listed', 'developer', 'admin', 'plain', 'operator']) answers[name] = (await get('/me', auth[name])).body.can_register;
    assert.deepEqual(answers, { listed: true, developer: true, admin: true, plain: false, operator: false });
  });
});
