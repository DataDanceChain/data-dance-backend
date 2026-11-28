'use strict';
// Explicit real-Postgres fixture only. This is intentionally outside the ordinary dbtest glob.
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const url = new URL(process.env.TEST_DATABASE_URL || 'http://refused.invalid');
assert.equal(process.env.DDC_OAUTH_PG_FIXTURE, 'OWNED_DISPOSABLE_UNIX_SOCKET_V1');
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.hostname, 'localhost');
assert.equal(url.pathname, '/sso_test');
assert.equal(url.searchParams.get('schema'), 'public');
const socket = url.searchParams.get('host');
assert.match(socket, /^\/private\/tmp\/ddc-oa-[a-zA-Z0-9]+\/socket$/);
assert.ok(fs.statSync(path.join(socket,`.s.PGSQL.${url.port}`)).isSocket());
Object.assign(process.env, {
  DATABASE_URL: url.href, DDC_SHARED_AUTH_STATE: 'true', LOG_LEVEL: 'error',
  SSO_ENVIRONMENT: 'test', SSO_TGE_ENABLED: 'false',
  PUBLIC_BASE_URL: 'https://api.example.test', APP_PUBLIC_URL: 'https://app.example.test',
});

const prisma = require('../../src/utils/prisma');
const SECRET = 'synthetic-dedicated-client-secret';
const PARTNER = 'https://api.example.test/partner/sso';
const MCP = 'https://api.example.test/mcp';
const REDIRECT = 'https://partner.example.test/callback';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function proveFixture() {
  const rows = await prisma.$queryRaw`
    SELECT current_database() AS database, current_schema() AS schema, inet_client_addr() IS NULL AS local
  `;
  assert.deepEqual(rows, [{ database: 'sso_test', schema: 'public', local: true }]);
}

if (process.argv[2] === '--worker') {
  runWorker().catch(() => { process.send?.({ error: 'fixture_failure' }); process.exitCode = 1; process.disconnect?.(); });
} else {
  const { test, before, after } = require('node:test');
  const runId = randomBytes(6).toString('hex');
  const children = new Set();

  before(async () => { await proveFixture(); assert.equal(await prisma.user.count(), 0); });
  after(async () => {
    for (const child of children) child.kill('SIGTERM');
    await prisma.$disconnect();
  });

  async function fixture(label, partner = true, expiresAt = new Date(Date.now() + 60_000)) {
    const id = `shared-${runId}-${label}`;
    await prisma.user.create({ data: { id, email: `${id}@example.test`, referralCode: id.toUpperCase() } });
    if (partner) {
      await prisma.ssoDeveloperClient.create({
        data: { clientId: id, clientName: 'Synthetic partner', contactEmail: `${id}@example.test`,
          kind: 'partner', secretHash: hash(SECRET), redirectUris: [REDIRECT], enabled: true },
      });
    } else {
      await prisma.oAuthClient.create({ data: { clientId: id, clientName: 'Synthetic public client', redirectUris: [REDIRECT] } });
    }
    const code = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const resource = partner ? PARTNER : MCP;
    const row = await prisma.oAuthAuthorization.create({
      data: { clientId: id, userId: id, redirectUri: REDIRECT, codeHash: hash(code),
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256',
        resource, scope: partner ? 'sso:identity' : 'openid email', expiresAt },
    });
    return { id, rowId: row.id, partner, body: { client_id: id, code, code_verifier: verifier, redirect_uri: REDIRECT, resource } };
  }

  function worker(f, options = {}) {
    const child = fork(__filename, ['--worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(child);
    child.once('exit', () => children.delete(child));
    let onRead;
    const read = new Promise(resolve => { onRead = resolve; });
    const result = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Worker exited without a result')));
      child.on('message', (message) => { if (message.read) onRead(); else resolve(message); });
    });
    // Attach a handler immediately, including paired-worker setup failures.
    result.catch(() => {});
    child.send({ id: f.id, partner: f.partner, body: f.body, ...options });
    return { read, result, release: () => child.send({ release: true }) };
  }

  async function associations(codeId) {
    return prisma.$queryRaw`SELECT "tokenHash", "refreshHash", "expiresAt"
      FROM "DdcOAuthCodeIssuance" WHERE "codeId"=${codeId}`;
  }
  const access = (f) => prisma.mcpToken.count({ where: { userId: f.id } });
  const refresh = (f) => prisma.oAuthRefreshToken.count({ where: { userId: f.id, revokedAt: null } });
  const consumed = async (f) => (await prisma.oAuthAuthorization.findUnique({ where: { id: f.rowId } })).consumedAt;

  for (const partner of [true, false]) {
    test(`authorized second process revokes initial ${partner ? 'partner' : 'public access and refresh'} issuance`, { timeout: 10_000 }, async () => {
      const f = await fixture(partner ? 'partner' : 'public', partner);
      const first = await worker(f).result;
      assert.equal(first.ok, true);
      assert.equal(await access(f), 1);
      assert.equal(await refresh(f), partner ? 0 : 1);
      const entries = await associations(f.rowId);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].tokenHash, first.accessHash);
      assert.equal(entries[0].refreshHash, first.refreshHash);
      assert.ok(entries[0].expiresAt.getTime() >= Date.now() + 290_000);
      assert.equal((await worker(f, { badProof: true }).result).error, 'invalid_grant');
      if (partner) assert.equal((await worker(f, { badSecret: true }).result).error, 'invalid_client');
      assert.equal((await associations(f.rowId)).length, 1);
      assert.equal(await access(f), 1);
      const second = await worker(f).result;
      assert.notEqual(second.pid, first.pid);
      assert.equal(second.error, 'invalid_grant');
      assert.equal((await associations(f.rowId)).length, 0);
      assert.equal(await access(f), 0);
      assert.equal(await refresh(f), 0);
    });
  }

  test('two processes that both observed an unused code mint at most once', { timeout: 10_000 }, async () => {
    const f = await fixture('race');
    const a = worker(f, { barrier: true }), b = worker(f, { barrier: true });
    await Promise.all([a.read,b.read]); a.release(); b.release();
    const results = await Promise.all([a.result,b.result]);
    assert.notEqual(results[0].pid, results[1].pid);
    assert.equal(results.filter(x=>x.ok).length, 1);
    assert.equal(results.filter(x=>x.error==='invalid_grant').length, 1);
    assert.equal(await access(f), 1);
    assert.equal((await associations(f.rowId)).length, 1);
  });

  test('post-insert failure rolls back code, tokens and association together; a new worker can retry', { timeout: 10_000 }, async () => {
    const f = await fixture('issue-rollback', false);
    assert.equal((await worker(f, { failIssue: true }).result).error, 'synthetic_failure');
    assert.equal(await consumed(f), null);
    assert.equal(await access(f), 0);
    assert.equal(await refresh(f), 0);
    assert.equal((await associations(f.rowId)).length, 0);
    assert.equal((await worker(f).result).ok, true);
    assert.ok(await consumed(f));
    assert.equal(await access(f), 1);
    assert.equal(await refresh(f), 1);
  });

  test('revocation failure preserves both tokens and the retryable association', { timeout: 10_000 }, async () => {
    const f = await fixture('revoke-rollback', false);
    assert.equal((await worker(f).result).ok, true);
    assert.equal((await worker(f, { failRevocation: true }).result).error, 'invalid_grant');
    assert.equal((await associations(f.rowId)).length, 1);
    assert.equal(await access(f), 1);
    assert.equal(await refresh(f), 1);
    assert.equal((await worker(f).result).error, 'invalid_grant');
    assert.equal((await associations(f.rowId)).length, 0);
    assert.equal(await access(f), 0);
    assert.equal(await refresh(f), 0);
  });

  test('expired association never revokes a token', { timeout: 10_000 }, async () => {
    const f = await fixture('expiry', false);
    assert.equal((await worker(f).result).ok, true);
    await prisma.$executeRaw`UPDATE "DdcOAuthCodeIssuance" SET "expiresAt"=(clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE "codeId"=${f.rowId}`;
    assert.equal((await worker(f).result).error, 'invalid_grant');
    assert.equal(await access(f), 1);
    assert.equal(await refresh(f), 1);
  });
}

async function runWorker() {
  const [cmd] = await once(process, 'message');
  await proveFixture();
  if (cmd.barrier) {
    const find = prisma.oAuthAuthorization.findUnique.bind(prisma.oAuthAuthorization);
    prisma.oAuthAuthorization.findUnique = async (...args) => {
      const row = await find(...args);
      assert.equal(row.consumedAt, null);
      const gate = once(process, 'message');
      process.send({ read: true });
      assert.equal((await gate)[0].release, true);
      return row;
    };
  }
  if (cmd.failIssue || cmd.failRevocation) {
    const original = prisma.$transaction.bind(prisma);
    prisma.$transaction = callback => original(tx => {
      const wrapped = {
        ...tx, oAuthAuthorization: tx.oAuthAuthorization, oAuthRefreshToken: tx.oAuthRefreshToken,
        mcpToken: tx.mcpToken, $queryRaw: tx.$queryRaw.bind(tx), $executeRaw: tx.$executeRaw.bind(tx),
      };
      if (cmd.failIssue) wrapped.$executeRaw = async (strings,...args) => {
        const out=await tx.$executeRaw(strings,...args);
        if (strings.join('').includes('INSERT INTO "DdcOAuthCodeIssuance"')) throw new Error('synthetic_failure');
        return out;
      };
      if (cmd.failRevocation) wrapped.mcpToken = {
        deleteMany: async (...args) => { await tx.mcpToken.deleteMany(...args); throw new Error('synthetic_failure'); },
      };
      return callback(wrapped);
    });
  }
  const oauth = require('../../src/services/oauthService');
  let outcome;
  try {
    const get = (name) => name.toLowerCase()==='authorization' && cmd.partner
      ? `Basic ${Buffer.from(`${cmd.id}:${cmd.badSecret ? 'wrong-synthetic-secret' : SECRET}`).toString('base64')}` : '';
    const body = cmd.badProof ? { ...cmd.body, code_verifier: 'x'.repeat(43) } : cmd.body;
    const issued = await oauth.exchangeAuthorizationCode({ get }, body);
    outcome = { ok: true, accessHash: hash(issued.access_token), refreshHash: issued.refresh_token ? hash(issued.refresh_token) : null };
  } catch (e) {
    outcome = { error: e.error || (e.message==='synthetic_failure' ? e.message : 'unexpected_failure') };
  } finally {
    await prisma.$disconnect();
  }
  process.send({ pid: process.pid, ...outcome }, () => process.disconnect());
}
