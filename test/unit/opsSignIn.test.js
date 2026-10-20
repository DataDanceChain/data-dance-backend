/**
 * Personal ops sign-in (admin issue #2): the developer console mints a one-time code with the
 * wallet JWT (POST /api/ops/auth/code), the ops site exchanges it with the PKCE verifier
 * (POST /api/ops/auth/exchange). Through the REAL application on the in-memory Prisma stand-in.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, JWT_SECRET } = require('../helpers/opsApp');

const { prisma, app } = installOpsApp();
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { opsUserTokenTtlSec, opsAdminUrl } = require('../../src/services/opsSignIn');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const mint = (authorization, body) => {
  const req = request(server).post('/api/ops/auth/code');
  if (authorization) req.set('Authorization', authorization);
  return req.send(body);
};
const exchange = (body) => request(server).post('/api/ops/auth/exchange').send(body);

let admin;
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  process.env.OPS_ADMIN_URL = 'https://admin.test.local';
  delete process.env.OPS_USER_TOKEN_TTL_SEC;
  admin = await seedUser(prisma, { email: 'admin@example.test', name: 'Admin' });
  await grant(prisma, admin.id, 'ddc_admin');
});

describe('POST /api/ops/auth/code', () => {
  it('needs a wallet sign-in (`protect`): no token or an ops token is 401', async () => {
    const { challenge } = pkce();
    assert.equal((await mint(undefined, { code_challenge: challenge })).status, 401);
    assert.equal((await mint(bearer(tokens.ops(admin)), { code_challenge: challenge })).status, 401);
    assert.equal(prisma.store.opsSignInCode.length, 0);
  });

  it('needs a verified session (ver >= 2): 403 VERIFIED_SESSION_REQUIRED', async () => {
    const res = await mint(bearer(tokens.wallet(admin, { ver: 1 })), { code_challenge: pkce().challenge });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'VERIFIED_SESSION_REQUIRED');
    assert.equal(prisma.store.opsSignInCode.length, 0);
  });

  it('needs a wallet sign-in from the last 10 minutes: 403 RECENT_SIGN_IN_REQUIRED', async () => {
    const old = await mint(bearer(tokens.wallet(admin, { ageSec: 601 })), { code_challenge: pkce().challenge });
    assert.equal(old.status, 403);
    assert.equal(old.body.code, 'RECENT_SIGN_IN_REQUIRED');
    assert.equal(prisma.store.opsSignInCode.length, 0);
    const recent = await mint(bearer(tokens.wallet(admin, { ageSec: 590 })), { code_challenge: pkce().challenge });
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
  });

  it('a wallet JWT issued before the last disable / re-enable: 401 SESSION_REVOKED', async () => {
    const before = bearer(tokens.wallet(admin, { ageSec: 120 }));
    prisma.store.user.find((u) => u.id === admin.id).sessionsResetAt = new Date(Date.now() - 60 * 1000);
    const res = await mint(before, { code_challenge: pkce().challenge });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'SESSION_REVOKED');
    assert.equal(prisma.store.opsSignInCode.length, 0);
    assert.equal((await mint(bearer(tokens.wallet(admin)), { code_challenge: pkce().challenge })).status, 200);
  });

  it('needs a staff account: 403 NOT_STAFF (a developer is not staff)', async () => {
    const developer = await seedUser(prisma);
    await grant(prisma, developer.id, 'developer');
    const res = await mint(bearer(tokens.wallet(developer)), { code_challenge: pkce().challenge });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NOT_STAFF');
    assert.equal(prisma.store.opsSignInCode.length, 0);
  });

  it('needs a 43-character base64url challenge: 400 INVALID_REQUEST', async () => {
    for (const code_challenge of [undefined, '', 'short', `${'a'.repeat(42)}=`, 'a'.repeat(44), `${'a'.repeat(42)}+`]) {
      clearRateLimitStore(); // 5 a minute per account
      const res = await mint(bearer(tokens.wallet(admin)), { code_challenge });
      assert.equal(res.status, 400, String(code_challenge));
      assert.equal(res.body.code, 'INVALID_REQUEST');
    }
    assert.equal(prisma.store.opsSignInCode.length, 0);
  });

  it('answers a code, 60 s, the redirect from OPS_ADMIN_URL only, and stores only the hash', async () => {
    const { challenge } = pkce();
    const res = await mint(bearer(tokens.wallet(admin)), {
      code_challenge: challenge,
      redirect_uri: 'https://evil.example/steal',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    const { code, expires_in: expiresIn, redirect_uri: redirectUri, email } = res.body.data;
    assert.match(code, /^osc_[A-Za-z0-9_-]{43}$/);
    assert.equal(expiresIn, 60);
    assert.equal(redirectUri, 'https://admin.test.local/auth/callback');
    assert.equal(email, 'admin@example.test');
    const rows = prisma.store.opsSignInCode;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].codeHash, crypto.createHash('sha256').update(code).digest('hex'));
    assert.equal(rows[0].challenge, challenge);
    assert.ok(!JSON.stringify(rows).includes(code), 'the code itself is never stored');
    assert.ok(rows[0].expiresAt.getTime() - Date.now() <= 60 * 1000);
    assert.equal(prisma.store.opsAuditLog.length, 0, 'minting writes no audit row');
  });

  it('deletes codes that expired more than a day ago', async () => {
    await prisma.opsSignInCode.create({
      data: { codeHash: 'old', userId: admin.id, challenge: 'c', expiresAt: new Date(Date.now() - 2 * 86400000) },
    });
    await prisma.opsSignInCode.create({
      data: { codeHash: 'recent', userId: admin.id, challenge: 'c', expiresAt: new Date(Date.now() - 3600000) },
    });
    await mint(bearer(tokens.wallet(admin)), { code_challenge: pkce().challenge });
    assert.deepEqual(prisma.store.opsSignInCode.map((row) => row.codeHash).filter((h) => h.length < 10), ['recent']);
  });

  it('OPS_ADMIN_URL must be https or http://localhost:<port>; anything else is a 500', async () => {
    assert.equal(opsAdminUrl({}), 'https://admin.datadance.ai');
    assert.equal(opsAdminUrl({ OPS_ADMIN_URL: 'http://localhost:5174' }), 'http://localhost:5174');
    assert.equal(opsAdminUrl({ OPS_ADMIN_URL: 'https://admin.test.local/' }), 'https://admin.test.local');
    for (const bad of ['http://admin.example', 'http://localhost', 'javascript:alert(1)', 'https://admin.example/path', 'https://u:p@admin.example', 'not a url']) {
      assert.equal(opsAdminUrl({ OPS_ADMIN_URL: bad }), null, bad);
    }
    process.env.OPS_ADMIN_URL = 'http://admin.example';
    const res = await mint(bearer(tokens.wallet(admin)), { code_challenge: pkce().challenge });
    assert.equal(res.status, 500);
    assert.equal(prisma.store.opsSignInCode.length, 0);
  });

  it('is limited to 5 a minute per account', async () => {
    const auth = bearer(tokens.wallet(admin));
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await mint(auth, { code_challenge: pkce().challenge })).status, 200);
    }
    assert.equal((await mint(auth, { code_challenge: pkce().challenge })).status, 429);
  });
});

describe('POST /api/ops/auth/exchange', () => {
  async function minted(user = admin) {
    const { verifier, challenge } = pkce();
    const res = await mint(bearer(tokens.wallet(user)), { code_challenge: challenge });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { code: res.body.data.code, verifier };
  }

  it('answers a personal session that never carries `id`, and writes auth.sign_in', async () => {
    const { code, verifier } = await minted();
    const res = await exchange({ code, code_verifier: verifier });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.kind, 'user');
    assert.equal(data.userId, admin.id);
    assert.equal(data.email, 'admin@example.test');
    assert.equal(data.role, 'ddc_admin');
    assert.deepEqual(data.roles, ['ddc_admin']);
    assert.deepEqual(data.permissions, ['ops.read', 'ops.write', 'ops.support', 'ops.payouts', 'ops.admin']);
    assert.equal(data.expiresIn, 43200);
    const claims = jwt.verify(data.token, JWT_SECRET);
    assert.deepEqual(
      { type: claims.type, kind: claims.kind, sub: claims.sub, id: claims.id },
      { type: 'ops_admin', kind: 'user', sub: admin.id, id: undefined },
    );
    assert.equal(claims.exp - claims.iat, 43200);

    const audit = prisma.store.opsAuditLog;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'auth.sign_in');
    assert.equal(audit[0].actorKind, 'user');
    assert.equal(audit[0].actorUserId, admin.id);
    assert.equal(audit[0].targetType, 'user');
    assert.equal(audit[0].targetId, admin.id);
    assert.deepEqual(audit[0].detail, { role: 'ddc_admin' });
    assert.ok(!JSON.stringify(audit).includes(code), 'the code is never in the audit row');
    assert.ok(!JSON.stringify(audit).includes(verifier), 'nor the verifier');

    // The session works on ops and is refused by the wallet API.
    const me = await request(server).get('/api/ops/auth/me').set('Authorization', bearer(data.token));
    assert.equal(me.status, 200);
    const wallet = await request(server).get('/api/developer/sso/clients').set('Authorization', bearer(data.token));
    assert.equal(wallet.status, 401);
  });

  it('a code is single use', async () => {
    const { code, verifier } = await minted();
    assert.equal((await exchange({ code, code_verifier: verifier })).status, 200);
    const again = await exchange({ code, code_verifier: verifier });
    assert.equal(again.status, 400);
    assert.equal(again.body.code, 'INVALID_GRANT');
  });

  it('an expired code is refused', async () => {
    const { code, verifier } = await minted();
    prisma.store.opsSignInCode[0].expiresAt = new Date(Date.now() - 1000);
    const res = await exchange({ code, code_verifier: verifier });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_GRANT');
  });

  it('a wrong verifier is refused and burns the code', async () => {
    const { code, verifier } = await minted();
    const wrong = await exchange({ code, code_verifier: pkce().verifier });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'INVALID_GRANT');
    const right = await exchange({ code, code_verifier: verifier });
    assert.equal(right.status, 400, 'the code was consumed by the failed attempt');
    assert.equal(right.body.code, 'INVALID_GRANT');
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('every malformed request is the same 400 INVALID_GRANT', async () => {
    const { code } = await minted();
    for (const body of [{}, { code: 'nope', code_verifier: 'x'.repeat(43) }, { code, code_verifier: 'short' }, { code, code_verifier: `${'a'.repeat(42)}!` }]) {
      const res = await exchange(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_GRANT');
    }
  });

  it('an account disabled between mint and exchange is refused', async () => {
    const { code, verifier } = await minted();
    prisma.store.user.find((u) => u.id === admin.id).disabledAt = new Date();
    const res = await exchange({ code, code_verifier: verifier });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_GRANT');
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('a code minted before the account was disabled and re-enabled is refused', async () => {
    const { code, verifier } = await minted();
    const row = prisma.store.user.find((u) => u.id === admin.id);
    row.sessionsResetAt = new Date(Date.now() + 1000);
    const res = await exchange({ code, code_verifier: verifier });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_GRANT');
    assert.equal(prisma.store.opsAuditLog.length, 0);
  });

  it('an account whose staff role was removed between mint and exchange is refused', async () => {
    const operator = await seedUser(prisma);
    await grant(prisma, operator.id, 'operator');
    const { code, verifier } = await minted(operator);
    await prisma.userRoleGrant.deleteMany({ where: { userId: operator.id } });
    const res = await exchange({ code, code_verifier: verifier });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_GRANT');
  });

  it('OPS_USER_TOKEN_TTL_SEC sets the session length, clamped to 300..43200', async () => {
    assert.equal(opsUserTokenTtlSec({}), 43200);
    assert.equal(opsUserTokenTtlSec({ OPS_USER_TOKEN_TTL_SEC: '10' }), 300);
    assert.equal(opsUserTokenTtlSec({ OPS_USER_TOKEN_TTL_SEC: '999999' }), 43200);
    assert.equal(opsUserTokenTtlSec({ OPS_USER_TOKEN_TTL_SEC: '3600' }), 3600);
    assert.equal(opsUserTokenTtlSec({ OPS_USER_TOKEN_TTL_SEC: 'soon' }), 43200);
    process.env.OPS_USER_TOKEN_TTL_SEC = '900';
    const { code, verifier } = await minted();
    const res = await exchange({ code, code_verifier: verifier });
    assert.equal(res.body.data.expiresIn, 900);
    const claims = jwt.verify(res.body.data.token, JWT_SECRET);
    assert.equal(claims.exp - claims.iat, 900);
  });
});
