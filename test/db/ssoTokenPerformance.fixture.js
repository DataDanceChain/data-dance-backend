/** Four synthetic real-Postgres cases. Only a positively owned throwaway fixture is admitted. */
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const url = new URL(process.env.TEST_DATABASE_URL || 'http://refused.invalid');
assert.equal(process.env.SSO_PG_FIXTURE_APPROVED, 'OWNED_DISPOSABLE_SSO_V1');
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, process.env.SSO_PG_FIXTURE_PORT);
assert.match(url.pathname, /^\/sso_test$/);
assert.equal(url.searchParams.get('schema'), 'public');
Object.assign(process.env, { DATABASE_URL: url.href, LOG_LEVEL: 'error', SSO_ENVIRONMENT: 'test', SSO_TGE_ENABLED: 'false', PUBLIC_BASE_URL: 'https://api.example.test', APP_PUBLIC_URL: 'https://app.example.test' });
const { PrismaClient } = require('@prisma/client');
const prisma = require('../../src/utils/prisma');
const control = new PrismaClient();
const oauth = require('../../src/services/oauthService');
const tokens = require('../../src/services/mcpTokenService');
const RUN = `sso-pg-${crypto.randomBytes(8).toString('hex')}`;
const SECRET = 'synthetic-sso-current-secret';
const NEXT = 'synthetic-sso-rotated-secret';
const RESOURCE = 'https://api.example.test/partner/sso';
const REDIRECT = 'https://partner.example.test/callback';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const originals = { userFind: prisma.user.findUnique, consume: prisma.oAuthAuthorization.updateMany };
const bounded = (promise, label, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
};
function gate() { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; }
const req = (id, secret = SECRET) => ({ get: (name) => name.toLowerCase() === 'authorization' ? `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` : '' });
async function fixture(label) {
  const id = `${RUN}-${label}`;
  await prisma.user.create({ data: { id, email: `${id}@example.test`, referralCode: id.toUpperCase() } });
  await prisma.ssoDeveloperClient.create({ data: { clientId: id, clientName: 'Synthetic PG partner', contactEmail: `${id}@example.test`, kind: 'partner', secretHash: hash(SECRET), redirectUris: [REDIRECT], enabled: true } });
  const code = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const row = await prisma.oAuthAuthorization.create({ data: { clientId: id, userId: id, redirectUri: REDIRECT, codeHash: hash(code), codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256', resource: RESOURCE, scope: 'sso:identity', expiresAt: new Date(Date.now() + 60000) } });
  return { id, row, body: { code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE } };
}
before(async () => {
  const rows = await prisma.$queryRaw`SELECT current_database() AS database, current_schema() AS schema`;
  assert.deepEqual(rows, [{ database: 'sso_test', schema: 'public' }]);
  assert.equal(await prisma.user.count(), 0);
  assert.equal(await prisma.ssoDeveloperClient.count(), 0);
});
afterEach(() => { prisma.user.findUnique = originals.userFind; prisma.oAuthAuthorization.updateMany = originals.consume; });
after(async () => {
  prisma.user.findUnique = originals.userFind; prisma.oAuthAuthorization.updateMany = originals.consume;
  try {
    await prisma.ssoDeveloperClient.deleteMany({ where: { clientId: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
  } finally { await Promise.all([prisma.$disconnect(), control.$disconnect()]); }
});
for (const change of ['disable', 'rotate']) {
  test(`committed late ${change} refuses old credentials before real code consume`, async () => {
    const f = await fixture(change);
    prisma.user.findUnique = async (args) => {
      const user = await originals.userFind.call(prisma.user, args);
      await control.ssoDeveloperClient.update({ where: { clientId: f.id }, data: change === 'disable' ? { enabled: false } : { secretHash: hash(NEXT) } });
      return user;
    };
    await assert.rejects(oauth.exchangeAuthorizationCode(req(f.id), f.body), (error) => error.error === 'invalid_client' && error.statusCode === 401);
    assert.equal((await control.oAuthAuthorization.findUnique({ where: { id: f.row.id } })).consumedAt, null);
    assert.equal(await control.mcpToken.count({ where: { userId: f.id } }), 0);
    prisma.user.findUnique = originals.userFind;
    if (change === 'rotate') {
      const result = await oauth.exchangeAuthorizationCode(req(f.id, NEXT), f.body);
      assert.ok(result.access_token.startsWith('ddc_sso_'));
      assert.equal(await control.mcpToken.count({ where: { userId: f.id } }), 1);
    }
  });
}
test('two real updateMany contenders consume once and mint exactly one token', async () => {
  const f = await fixture('consume'); const ready = gate(); const release = gate(); let arrived = 0;
  prisma.oAuthAuthorization.updateMany = async (args) => {
    assert.deepEqual(args.where.id, f.row.id); assert.equal(args.where.consumedAt, null);
    arrived += 1; if (arrived === 2) ready.release();
    await release.promise; return originals.consume.call(prisma.oAuthAuthorization, args);
  };
  const settled = Promise.allSettled([oauth.exchangeAuthorizationCode(req(f.id), f.body), oauth.exchangeAuthorizationCode(req(f.id), f.body)]);
  let firstFailure;
  try { await bounded(ready.promise, 'BOTH_REAL_CONSUMERS_NOT_REACHED'); } catch (error) { firstFailure = error; } finally { release.release(); }
  const results = await settled;
  if (firstFailure) throw firstFailure;
  assert.equal(arrived, 2); assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const denied = results.find((r) => r.status === 'rejected'); assert.equal(denied.reason.error, 'invalid_grant');
  assert.ok((await control.oAuthAuthorization.findUnique({ where: { id: f.row.id } })).consumedAt instanceof Date);
  assert.equal(await control.mcpToken.count({ where: { userId: f.id } }), 1);
});
test('identity completes during a real bookkeeping row lock then update completes after release', async () => {
  const f = await fixture('bookkeeping'); const client = { kind: 'partner', clientId: f.id, clientName: 'Synthetic PG partner', enabled: true, accessTtlSec: 3600 };
  const issued = await tokens.issuePartnerToken(f.id, client, { resource: RESOURCE, scope: 'sso:identity' });
  const row = await control.mcpToken.findUnique({ where: { tokenHash: tokens.hashToken(issued.token) } });
  const acquired = gate(); const release = gate(); let held = false;
  const locking = control.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
    await tx.$queryRaw`SELECT id FROM "McpToken" WHERE id = ${row.id} FOR UPDATE`;
    held = true; acquired.release(); await release.promise; held = false;
  }, { timeout: 12000 });
  locking.catch(() => {});
  try {
    await bounded(acquired.promise, 'OWN_ROW_LOCK_NOT_ACQUIRED');
    const identity = await bounded(tokens.findUserByPartnerToken(issued.token, RESOURCE), 'IDENTITY_BLOCKED_BY_BOOKKEEPING');
    assert.equal(identity.user.id, f.id); assert.equal(held, true);
    assert.equal((await prisma.mcpToken.findUnique({ where: { id: row.id } })).lastUsedAt, null);
  } finally { release.release(); await locking; }
  const until = Date.now() + 5000; let observed;
  do { observed = await prisma.mcpToken.findUnique({ where: { id: row.id } }); if (observed.lastUsedAt) break; await new Promise((r) => setTimeout(r, 20)); } while (Date.now() < until);
  assert.ok(observed.lastUsedAt instanceof Date);
});
