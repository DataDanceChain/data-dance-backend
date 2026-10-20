/** Persisted partner account choice on disposable Postgres. No provider or real identity calls. */
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a disposable test database');
const RUN = `pe${crypto.randomBytes(4).toString('hex')}`;
const REDIRECT = 'https://planet.example.test/oauth/callback';
const JWT_SECRET = 'planet-entry-policy-synthetic-jwt-key';
Object.assign(process.env, {
  DATABASE_URL: url, LOG_LEVEL: 'error', SSO_ENVIRONMENT: 'test', SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: RUN, SSO_TGE_CLIENT_NAME: 'Synthetic Planet',
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update('synthetic-client-secret').digest('hex'),
  SSO_TGE_REDIRECT_URIS: REDIRECT, SSO_TGE_INITIATE_LOGIN_URI: 'https://planet.example.test/login/ddc',
  SSO_TGE_AUTO_APPROVE: 'app,web', PUBLIC_BASE_URL: 'https://api.example.test', APP_PUBLIC_URL: 'https://app.example.test',
  JWT_SECRET, SSO_SESSION_SECRET: 'planet-entry-policy-synthetic-sso-key',
});
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../../src/utils/prisma');
const clientFile = require.resolve('@prisma/client');
require.cache[clientFile].exports = { ...require.cache[clientFile].exports, PrismaClient: function () { return prisma; } };
const { listenLoopback } = require('../helpers/loopbackServer');
const app = express();
app.use(express.json());
app.use('/api/sso', require('../../src/routes/ssoRoutes'));
app.use(require('../../src/routes/oauthRoutes'));
let server;
let wallet;
let chosenWallet;
before(async () => {
  for (const name of ['original', 'chosen']) {
    await prisma.user.create({ data: { id: `${RUN}-${name}`, email: `${RUN}-${name}@example.test`, referralCode: `${RUN}-${name}` } });
  }
  wallet = jwt.sign({ id: `${RUN}-original`, ver: 2 }, JWT_SECRET, { expiresIn: '10m' });
  chosenWallet = jwt.sign({ id: `${RUN}-chosen`, ver: 2 }, JWT_SECRET, { expiresIn: '10m' });
  server = await listenLoopback(app);
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.oAuthAuthorization.deleteMany({ where: { clientId: RUN } });
  await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.$disconnect();
});

async function authorize(prompt) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const query = {
    client_id: RUN, redirect_uri: REDIRECT, response_type: 'code', state: `${RUN}-state-with-enough-entropy`,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(prompt ? { prompt } : {}),
  };
  const res = await request(server).get('/oauth/authorize').query(query);
  assert.equal(res.status, 302, res.text);
  const target = new URL(res.headers.location);
  const id = target.searchParams.get('request');
  assert.ok(id, res.headers.location);
  target.searchParams.delete('prompt');
  return { id, cookie: res.headers['set-cookie'][0].split(';')[0], strippedUrl: target.toString() };
}
const decision = (id, cookie, token, auto = false) => request(server).post('/api/oauth/consent')
  .set('Authorization', `Bearer ${token}`).set('Cookie', cookie).send({ requestId: id, allow: true, auto });
async function handoff() {
  const mint = await request(server).post('/api/sso/app-ticket').set('Authorization', `Bearer ${wallet}`).send({ client_id: RUN });
  assert.equal(mint.status, 200, mint.text);
  const exchange = await request(server).post('/api/sso/ticket/exchange').send({ ticket: mint.body.data.ticket });
  assert.equal(exchange.status, 200, exchange.text);
  return exchange.body.data.session_token;
}

it('the additive migration preserves pre-existing requests with a nullable null prompt', async () => {
  // Replay the real SQL against a private clone of the pre-migration table, with a real old row.
  const probe = `${RUN}_migration`;
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${probe}"`);
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${probe}"."OAuthAuthorization" (LIKE public."OAuthAuthorization" INCLUDING ALL)`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "${probe}"."OAuthAuthorization" DROP COLUMN prompt`);
    await prisma.$executeRawUnsafe(`INSERT INTO "${probe}"."OAuthAuthorization" (id,"clientId","redirectUri","codeChallenge","codeChallengeMethod",resource,scope,"expiresAt") VALUES ('old','legacy','https://example.test/callback','challenge','S256','resource','scope',NOW()+INTERVAL '10 minutes')`);
    const migration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261019160000_oauth_authorization_prompt/migration.sql'), 'utf8');
    const statements = migration.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter((s) => s && !['BEGIN', 'COMMIT'].includes(s));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${probe}"`);
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    });
    assert.deepEqual(await prisma.$queryRawUnsafe(`SELECT id,prompt FROM "${probe}"."OAuthAuthorization"`), [{ id: 'old', prompt: null }]);
    const columns = await prisma.$queryRawUnsafe('SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=\'OAuthAuthorization\' AND column_name=\'prompt\'', probe);
    assert.deepEqual(columns, [{ is_nullable: 'YES' }]);
  } finally {
    await prisma.$executeRawUnsafe(`DROP SCHEMA "${probe}" CASCADE`);
  }
});

it('an ordinary request stores null; standalone auto is refused but the scoped ticket can approve it', async () => {
  const { id, cookie } = await authorize();
  assert.equal((await prisma.oAuthAuthorization.findUnique({ where: { id } })).prompt, null);
  const denied = await decision(id, cookie, wallet, true);
  assert.equal(denied.status, 403, denied.text);
  assert.equal(denied.body.code, 'AUTO_APPROVE_NOT_ALLOWED');
  const row = await prisma.oAuthAuthorization.findUnique({ where: { id } });
  assert.equal(row.codeHash, null);
  assert.equal(row.consumedAt, null);
  const allowed = await decision(id, cookie, await handoff(), true);
  assert.equal(allowed.status, 200, allowed.text);
  assert.ok(new URL(allowed.body.data.redirectTo).searchParams.get('code'));
});

for (const prompt of ['login', 'select_account']) {
  it(`${prompt} survives a URL without prompt; automatic refusals leave it for the chosen JWT account`, async () => {
    const { id, cookie, strippedUrl } = await authorize(prompt);
    const summary = await request(server).get(`/api/oauth/requests/${new URL(strippedUrl).searchParams.get('request')}`);
    assert.equal(summary.status, 200, summary.text);
    assert.equal(summary.body.data.prompt, prompt);
    assert.deepEqual(summary.body.data.autoApprove, { app: false, web: false });
    assert.equal((await prisma.oAuthAuthorization.findUnique({ where: { id } })).prompt, prompt);
    const session = await handoff();
    for (const token of [wallet, session]) {
      const res = await decision(id, cookie, token, true);
      assert.equal(res.status, 403, res.text);
      assert.equal(res.body.code, 'AUTO_APPROVE_NOT_ALLOWED');
    }
    if (prompt === 'select_account') {
      const stale = await decision(id, cookie, session);
      assert.equal(stale.status, 403, stale.text);
      assert.equal(stale.body.error, 'access_denied');
    }
    const undecided = await prisma.oAuthAuthorization.findUnique({ where: { id } });
    assert.equal(undecided.codeHash, null);
    assert.equal(undecided.consumedAt, null);
    const manual = await decision(id, cookie, chosenWallet);
    assert.equal(manual.status, 200, manual.text);
    assert.equal((await prisma.oAuthAuthorization.findUnique({ where: { id } })).userId, `${RUN}-chosen`);
    const redirect = new URL(manual.body.data.redirectTo);
    assert.equal(redirect.searchParams.get('state'), `${RUN}-state-with-enough-entropy`);
  });
}
