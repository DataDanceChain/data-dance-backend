/**
 * protectOps (admin issue #2): personal ops sessions are checked against the account and its roles
 * on every request; the shared login stays on for the move to personal sign-in unless
 * OPS_SHARED_LOGIN=off; the demo login stays read-only. Through the REAL application on the
 * in-memory Prisma stand-in.
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
const { sharedLoginOn } = require('../../src/services/opsSignIn');

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
  // Unset: the default, which is on.
  delete process.env.OPS_SHARED_LOGIN;
  process.env.OPS_ADMIN_USERNAME = SHARED.username;
  process.env.OPS_ADMIN_PASSWORD = SHARED.password;
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
    // Issued after the reset: accepted.
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

  it('a token issued before a reset within the same second cannot regain staff access', async () => {
    const operator = await seedUser(prisma);
    await grant(prisma, operator.id, 'operator');
    const iat = Math.floor(Date.now() / 1000) - 1;
    const oldOps = jwt.sign({ type: 'ops_admin', kind: 'user', sub: operator.id, iat }, JWT_SECRET, { expiresIn: '5m' });
    const oldWallet = jwt.sign({ id: operator.id, ver: 2, iat }, JWT_SECRET, { expiresIn: '5m' });
    prisma.store.user.find((u) => u.id === operator.id).sessionsResetAt = new Date(iat * 1000 + 500);

    const refused = await me(bearer(oldOps));
    assert.equal(refused.status, 401, 'the legacy ops token predates the reset by 500 ms');
    assert.equal(refused.body.code, 'OPS_SESSION_INVALID');
    const code = await request(server).post('/api/ops/auth/code').set('Authorization', bearer(oldWallet))
      .send({ code_challenge: 'a'.repeat(43) });
    assert.equal(code.status, 401, 'the legacy wallet token must not mint a new ops session');
    assert.equal(code.body.code, 'SESSION_REVOKED');

    // A new-format token retains the ordering within the second for both token families.
    const sign = (claims, iatMs) => jwt.sign({ ...claims, iat, iatMs }, JWT_SECRET, { expiresIn: '5m' });
    assert.equal((await me(bearer(sign({ type: 'ops_admin', kind: 'user', sub: operator.id }, iat * 1000 + 100)))).status, 401);
    assert.equal((await me(bearer(sign({ type: 'ops_admin', kind: 'user', sub: operator.id }, iat * 1000 + 750)))).status, 200);
    const staleWallet = sign({ id: operator.id, ver: 2 }, iat * 1000 + 100);
    const staleCode = await request(server).post('/api/ops/auth/code').set('Authorization', bearer(staleWallet))
      .send({ code_challenge: 'a'.repeat(43) });
    assert.equal(staleCode.status, 401, 'a precise wallet token from before the reset stays revoked');
    const freshWallet = sign({ id: operator.id, ver: 2 }, iat * 1000 + 750);
    const freshCode = await request(server).post('/api/ops/auth/code').set('Authorization', bearer(freshWallet))
      .send({ code_challenge: 'a'.repeat(43) });
    assert.equal(freshCode.status, 200, JSON.stringify(freshCode.body));

    for (const iatMs of ['invalid', iat * 1000 + 1500, null]) {
      const malformed = sign({ type: 'ops_admin', kind: 'user', sub: operator.id }, iatMs);
      assert.equal((await me(bearer(malformed))).status, 401, `malformed iatMs: ${iatMs}`);
    }
    const futureMs = Date.now() + 60000;
    const future = jwt.sign({ type: 'ops_admin', kind: 'user', sub: operator.id, iat: Math.floor(futureMs / 1000), iatMs: futureMs }, JWT_SECRET, { expiresIn: '5m' });
    assert.equal((await me(bearer(future))).status, 401, 'a future issue time cannot bypass reset');

    // Actual production issuers, rather than test helpers, preserve millisecond ordering.
    const { signUserOpsToken } = require('../../src/services/opsSignIn');
    const { generateToken } = require('../../src/utils/jwtUtils');
    const expires = process.env.JWT_EXPIRES_IN;
    try {
      process.env.JWT_EXPIRES_IN = '1h';
      for (const token of [signUserOpsToken(operator.id).token, generateToken(operator.id, { ver: 2 })]) {
        const claims = jwt.verify(token, JWT_SECRET);
        assert.ok(Number.isSafeInteger(claims.iatMs));
        assert.equal(Math.floor(claims.iatMs / 1000), claims.iat);
      }
    } finally {
      if (expires === undefined) delete process.env.JWT_EXPIRES_IN;
      else process.env.JWT_EXPIRES_IN = expires;
    }
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

describe('the shared login stays on unless OPS_SHARED_LOGIN=off', () => {
  const login = (body) => request(server).post('/api/ops/auth/login').send(body);
  const OFF_VALUES = ['off', 'OFF', ' off ', 'Off\n'];

  it('the switch: only "off" (trimmed, any case) turns it off', () => {
    assert.equal(sharedLoginOn({}), true, 'unset');
    for (const value of ['', 'on', 'ON', ' on ', 'yes', 'no', 'false', '0', 'of', 'offf', 'off-']) {
      assert.equal(sharedLoginOn({ OPS_SHARED_LOGIN: value }), true, JSON.stringify(value));
    }
    for (const value of OFF_VALUES) {
      assert.equal(sharedLoginOn({ OPS_SHARED_LOGIN: value }), false, JSON.stringify(value));
    }
  });

  it('unset: on. The shared credentials sign in and are audited as "shared"', async () => {
    assert.equal(process.env.OPS_SHARED_LOGIN, undefined);
    process.env.OPS_USER_TOKEN_TTL_SEC = '600';
    try {
      const on = await login(SHARED);
      assert.equal(on.status, 200, JSON.stringify(on.body));
      assert.equal(on.body.data.role, 'shared');
      assert.equal(on.body.data.kind, 'shared');
      assert.equal(on.body.data.username, 'shared');
      assert.deepEqual(on.body.data.permissions, ['ops.read', 'ops.write']);
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
      assert.equal(rows[0].actorUserId, null);
      assert.equal(rows[0].surface, 'ops');
      assert.ok(!JSON.stringify(rows).includes(SHARED.password), 'the password is never recorded');

      const session = await me(bearer(on.body.data.token));
      assert.equal(session.status, 200);
      assert.equal(session.body.data.role, 'shared');
    } finally {
      delete process.env.OPS_USER_TOKEN_TTL_SEC;
    }
  });

  it('unset: a legacy shared token (role admin) is accepted as the shared role', async () => {
    const res = await me(bearer(tokens.legacyShared()));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      { kind: res.body.data.kind, role: res.body.data.role, username: res.body.data.username, userId: res.body.data.userId },
      { kind: 'shared', role: 'shared', username: 'shared', userId: null },
    );
    assert.deepEqual(res.body.data.permissions, ['ops.read', 'ops.write']);
  });

  it('"on", and any value other than "off", is on', async () => {
    for (const value of ['on', 'ON', ' on ', 'yes', 'false']) {
      process.env.OPS_SHARED_LOGIN = value;
      assert.equal((await me(bearer(tokens.legacyShared()))).status, 200, JSON.stringify(value));
      assert.equal((await me(bearer(tokens.shared()))).status, 200, JSON.stringify(value));
    }
    process.env.OPS_SHARED_LOGIN = 'on';
    const on = await login(SHARED);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.data.role, 'shared');
    assert.equal(prisma.store.opsAuditLog.length, 1);
  });

  it('"off" (also "OFF" and " off "): the shared credentials answer exactly like a wrong password, and nothing is recorded', async () => {
    const wrong = await login({ username: SHARED.username, password: 'nope' });
    assert.equal(wrong.status, 401);
    for (const value of ['off', 'OFF', ' off ']) {
      process.env.OPS_SHARED_LOGIN = value;
      const off = await login(SHARED);
      assert.equal(off.status, 401, JSON.stringify(value));
      assert.deepEqual(off.body, wrong.body, JSON.stringify(value));
      assert.equal(off.body.data, undefined);
    }
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('off: a legacy shared token (role admin) and a current shared token are refused: 401 OPS_SESSION_INVALID', async () => {
    const legacy = bearer(tokens.legacyShared());
    const current = bearer(tokens.shared());
    assert.equal((await me(legacy)).status, 200, 'on before the switch');
    for (const value of OFF_VALUES) {
      process.env.OPS_SHARED_LOGIN = value;
      for (const [name, authorization] of [['legacy', legacy], ['current', current]]) {
        const res = await me(authorization);
        assert.equal(res.status, 401, `${name} ${JSON.stringify(value)}`);
        assert.equal(res.body.code, 'OPS_SESSION_INVALID', `${name} ${JSON.stringify(value)}`);
      }
    }
    // Off stops writes too, not only /auth/me.
    process.env.OPS_SHARED_LOGIN = 'off';
    const user = await seedUser(prisma);
    const write = await request(server).post(`/api/ops/users/${user.id}/points`).set('Authorization', legacy).send({ amount: 5, note: 'after the switch' });
    assert.equal(write.status, 401);
    assert.equal(prisma.store.point.length, 0);
  });

  it('an unset or empty OPS_ADMIN_PASSWORD (or username) never signs anyone in, while the switch is on', async () => {
    const tries = [
      { username: SHARED.username, password: '' },
      { username: SHARED.username },
      { username: SHARED.username, password: SHARED.password },
    ];
    for (const value of [undefined, 'on']) {
      if (value === undefined) delete process.env.OPS_SHARED_LOGIN;
      else process.env.OPS_SHARED_LOGIN = value;
      for (const password of [undefined, '']) {
        clearRateLimitStore();
        if (password === undefined) delete process.env.OPS_ADMIN_PASSWORD;
        else process.env.OPS_ADMIN_PASSWORD = password;
        for (const body of tries) {
          const res = await login(body);
          assert.equal(res.status, 401, `${value} ${JSON.stringify(password)} ${JSON.stringify(body)}`);
          assert.equal(res.body.data, undefined);
        }
      }
      clearRateLimitStore();
      process.env.OPS_ADMIN_PASSWORD = SHARED.password;
      for (const username of [undefined, '']) {
        if (username === undefined) delete process.env.OPS_ADMIN_USERNAME;
        else process.env.OPS_ADMIN_USERNAME = username;
        for (const body of [{ username: '', password: SHARED.password }, { password: SHARED.password }]) {
          const res = await login(body);
          assert.equal(res.status, 401, `${value} username ${JSON.stringify(username)} ${JSON.stringify(body)}`);
          assert.equal(res.body.data, undefined);
        }
      }
      process.env.OPS_ADMIN_USERNAME = SHARED.username;
    }
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('with no shared password and no demo login, the login answers 503 not configured and issues nothing', async () => {
    const saved = { user: process.env.OPS_DEMO_USERNAME, pass: process.env.OPS_DEMO_PASSWORD, file: process.env.OPS_DEMO_FILE };
    delete process.env.OPS_ADMIN_PASSWORD;
    delete process.env.OPS_DEMO_USERNAME;
    delete process.env.OPS_DEMO_PASSWORD;
    process.env.OPS_DEMO_FILE = '/nonexistent/ops-demo-for-tests.json';
    try {
      const res = await login({ username: SHARED.username, password: '' });
      assert.equal(res.status, 503);
      assert.equal(res.body.data, undefined);
      assert.equal(prisma.store.opsAuditLog.length, 0);
    } finally {
      process.env.OPS_DEMO_USERNAME = saved.user;
      process.env.OPS_DEMO_PASSWORD = saved.pass;
      if (saved.file === undefined) delete process.env.OPS_DEMO_FILE;
      else process.env.OPS_DEMO_FILE = saved.file;
    }
  });

  it('the shared sign-in does not happen when it cannot be recorded', async () => {
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
