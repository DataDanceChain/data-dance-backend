/**
 * protectOps (admin issue #2): personal ops sessions are checked against the account and its roles
 * on every request; the shared login is an emergency fallback behind OPS_SHARED_LOGIN; the demo
 * login stays read-only. Through the REAL application on the in-memory Prisma stand-in.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, JWT_SECRET, recordLabel } = require('../helpers/opsApp');

const SHARED = { username: 'shared-ops', password: 'shared-ops-password-for-tests' };
const DEMO = { username: 'demo-viewer', password: 'demo-password-for-tests' };
const { prisma, app } = installOpsApp({
  env: {
    OPS_ADMIN_USERNAME: SHARED.username,
    OPS_ADMIN_PASSWORD: SHARED.password,
    OPS_DEMO_USERNAME: DEMO.username,
    OPS_DEMO_PASSWORD: DEMO.password,
  },
});
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const me = (authorization) => {
  const req = request(server).get('/api/ops/auth/me');
  if (authorization) req.set('Authorization', authorization);
  return req;
};

beforeEach(() => {
  prisma.reset();
  clearRateLimitStore();
  delete process.env.OPS_SHARED_LOGIN;
});

describe('personal ops session (kind: user)', () => {
  it('a ddc_admin token passes and /auth/me reports the account, its roles and permissions', async () => {
    const admin = await seedUser(prisma, { email: 'admin@example.test', name: 'Admin' });
    await grant(prisma, admin.id, 'ddc_admin');
    const res = await me(bearer(tokens.ops(admin)));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, {
      kind: 'user',
      userId: admin.id,
      email: 'admin@example.test',
      name: 'Admin',
      // Records outside the audit log get this label, never the e-mail.
      username: recordLabel(admin.id),
      role: 'ddc_admin',
      roles: ['ddc_admin'],
      permissions: ['ops.read', 'ops.write', 'ops.support', 'ops.payouts', 'ops.admin'],
    });
  });

  it('an operator passes with the operator permissions; ddc_admin + operator acts as ddc_admin', async () => {
    const operator = await seedUser(prisma);
    await grant(prisma, operator.id, 'operator');
    const res = await me(bearer(tokens.ops(operator)));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.role, 'operator');
    assert.deepEqual(res.body.data.permissions, ['ops.read', 'ops.write', 'ops.support']);

    const both = await seedUser(prisma);
    await grant(prisma, both.id, 'operator');
    await grant(prisma, both.id, 'ddc_admin');
    const twice = await me(bearer(tokens.ops(both)));
    assert.equal(twice.body.data.role, 'ddc_admin');
    assert.deepEqual(twice.body.data.roles, ['ddc_admin', 'operator']);
  });

  it('a disabled account is refused: 403 ACCOUNT_DISABLED', async () => {
    const admin = await seedUser(prisma, { disabledAt: new Date() });
    await grant(prisma, admin.id, 'ddc_admin');
    const res = await me(bearer(tokens.ops(admin)));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ACCOUNT_DISABLED');
  });

  it('an account with no staff role is refused: 403 NOT_STAFF (developer gives no ops access)', async () => {
    const plain = await seedUser(prisma);
    const res = await me(bearer(tokens.ops(plain)));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NOT_STAFF');

    const developer = await seedUser(prisma);
    await grant(prisma, developer.id, 'developer');
    const dev = await me(bearer(tokens.ops(developer)));
    assert.equal(dev.status, 403);
    assert.equal(dev.body.code, 'NOT_STAFF');
  });

  it('a role revoked mid-session stops the next call', async () => {
    const operator = await seedUser(prisma);
    await grant(prisma, operator.id, 'operator');
    const token = bearer(tokens.ops(operator));
    assert.equal((await me(token)).status, 200);
    await prisma.userRoleGrant.deleteMany({ where: { userId: operator.id } });
    const after = await me(token);
    assert.equal(after.status, 403);
    assert.equal(after.body.code, 'NOT_STAFF');
  });

  it('a session issued before the account was last disabled / re-enabled is 401 OPS_SESSION_INVALID', async () => {
    const operator = await seedUser(prisma);
    await grant(prisma, operator.id, 'operator');
    const older = bearer(tokens.ops(operator, { ageSec: 120 }));
    assert.equal((await me(older)).status, 200);
    prisma.store.user.find((u) => u.id === operator.id).sessionsResetAt = new Date(Date.now() - 60 * 1000);
    const refused = await me(older);
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, 'OPS_SESSION_INVALID');
    // Issued after the reset (or in its second): accepted.
    assert.equal((await me(bearer(tokens.ops(operator, { ageSec: 30 })))).status, 200);
    assert.equal((await me(bearer(tokens.ops(operator)))).status, 200);
  });

  it('an unknown account, a bad signature, no token and an expired token are 401', async () => {
    const ghost = { id: 'no-such-user' };
    const unknown = await me(bearer(tokens.ops(ghost)));
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.code, 'OPS_SESSION_INVALID');

    const forged = jwt.sign({ type: 'ops_admin', kind: 'user', sub: 'x' }, 'another-secret');
    assert.equal((await me(bearer(forged))).body.code, 'OPS_SESSION_INVALID');

    const none = await me();
    assert.equal(none.status, 401);
    assert.equal(none.body.code, 'OPS_SESSION_INVALID');

    const admin = await seedUser(prisma);
    await grant(prisma, admin.id, 'ddc_admin');
    const expired = jwt.sign(
      { type: 'ops_admin', kind: 'user', sub: admin.id, iat: Math.floor(Date.now() / 1000) - 100, exp: Math.floor(Date.now() / 1000) - 10 },
      JWT_SECRET,
    );
    const res = await me(bearer(expired));
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'OPS_SESSION_EXPIRED');
  });
});

describe('the two token families never cross', () => {
  it('a wallet JWT sent to ops is refused: 403', async () => {
    const admin = await seedUser(prisma);
    await grant(prisma, admin.id, 'ddc_admin');
    const res = await me(bearer(tokens.wallet(admin)));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'OPS_SESSION_INVALID');
  });

  it('an ops token sent to the wallet API (`protect`) is refused: 401', async () => {
    const admin = await seedUser(prisma);
    await grant(prisma, admin.id, 'ddc_admin');
    const res = await request(server).get('/api/developer/sso/clients').set('Authorization', bearer(tokens.ops(admin)));
    assert.equal(res.status, 401);
  });
});

describe('the shared login is off unless OPS_SHARED_LOGIN=on', () => {
  const login = (body) => request(server).post('/api/ops/auth/login').send(body);

  it('a legacy shared token (role admin) is 401 while off, and the shared role while on', async () => {
    const legacy = bearer(tokens.legacyShared());
    const off = await me(legacy);
    assert.equal(off.status, 401);
    assert.equal(off.body.code, 'OPS_SESSION_INVALID');

    process.env.OPS_SHARED_LOGIN = 'yes';
    assert.equal((await me(legacy)).status, 401, 'anything but "on" is off');

    process.env.OPS_SHARED_LOGIN = 'on';
    const on = await me(legacy);
    assert.equal(on.status, 200);
    assert.deepEqual(
      { kind: on.body.data.kind, role: on.body.data.role, username: on.body.data.username, userId: on.body.data.userId },
      { kind: 'shared', role: 'shared', username: 'shared', userId: null },
    );
    assert.deepEqual(on.body.data.permissions, ['ops.read', 'ops.write']);
    const current = await me(bearer(tokens.shared()));
    assert.equal(current.body.data.role, 'shared');
  });

  it('the shared credentials answer like a wrong password while off; on, they sign in and are audited', async () => {
    const wrong = await login({ username: SHARED.username, password: 'nope' });
    const off = await login(SHARED);
    assert.equal(off.status, 401);
    assert.deepEqual(off.body, wrong.body);
    assert.equal(prisma.store.opsAuditLog.length, 0);

    process.env.OPS_SHARED_LOGIN = 'on';
    process.env.OPS_USER_TOKEN_TTL_SEC = '600';
    try {
      const on = await login(SHARED);
      assert.equal(on.status, 200, JSON.stringify(on.body));
      assert.equal(on.body.data.role, 'shared');
      assert.equal(on.body.data.kind, 'shared');
      assert.equal(on.body.data.expiresIn, 600);
      const claims = jwt.verify(on.body.data.token, JWT_SECRET);
      assert.equal(claims.type, 'ops_admin');
      assert.equal(claims.kind, 'shared');
      assert.equal(claims.sub, 'shared');
      assert.equal(claims.role, 'shared');
      assert.equal(claims.id, undefined);
      assert.equal(claims.exp - claims.iat, 600);
      const rows = prisma.store.opsAuditLog;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'auth.shared_sign_in');
      assert.equal(rows[0].actorKind, 'shared');
      assert.equal(rows[0].actorLabel, 'shared');
      assert.equal(rows[0].surface, 'ops');
      assert.ok(!JSON.stringify(rows).includes(SHARED.password), 'the password is never recorded');
    } finally {
      delete process.env.OPS_USER_TOKEN_TTL_SEC;
    }
  });

  it('the shared sign-in does not happen when it cannot be recorded', async () => {
    process.env.OPS_SHARED_LOGIN = 'on';
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw new Error('audit store down'); };
    try {
      const res = await login(SHARED);
      assert.equal(res.status, 500);
      assert.equal(res.body.data, undefined);
    } finally {
      prisma.opsAuditLog.create = original;
    }
  });
});

describe('the demo login is unchanged', () => {
  it('signs in whatever the switch says, writes no audit row, reads but cannot write', async () => {
    const res = await request(server).post('/api/ops/auth/login').send(DEMO);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.role, 'demo');
    assert.equal(res.body.data.expiresIn, '7d');
    assert.equal(prisma.store.opsAuditLog.length, 0);

    const demo = bearer(res.body.data.token);
    const read = await me(demo);
    assert.equal(read.status, 200);
    assert.equal(read.body.data.role, 'demo');
    assert.deepEqual(read.body.data.permissions, ['ops.read']);

    const user = await seedUser(prisma);
    const write = await request(server).post(`/api/ops/users/${user.id}/points`).set('Authorization', demo).send({ amount: 5, note: 'demo try' });
    assert.equal(write.status, 403);
    assert.equal(prisma.store.point.length, 0);
  });
});
