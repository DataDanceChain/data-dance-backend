/** Current-main token freshness and non-blocking bookkeeping. No server or database. */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
const SECRET = 'synthetic-performance-client-secret';
const NEXT_SECRET = 'synthetic-performance-rotated-secret';
const ISSUER = 'https://api.example.test';
const RESOURCE = `${ISSUER}/partner/sso`;
const REDIRECT = 'https://partner.example.test/callback';
const CLIENT = 'performance-registry-client';
const CONFIGURED = 'performance-configured-client';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

Object.assign(process.env, {
  LOG_LEVEL: 'error',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: CONFIGURED,
  SSO_TGE_CLIENT_NAME: 'Synthetic configured client',
  SSO_TGE_CLIENT_SECRET_SHA256: hash(SECRET),
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.example.test',
});

const clients = require('../../src/services/ssoDeveloperClient');
const oauth = require('../../src/services/oauthService');
const tokens = require('../../src/services/mcpTokenService');
const { getPartnerClient, PARTNER_TOKEN_PREFIX } = require('../../src/constants/partnerClient');
const { installReadOnlyGuard, readOnlyScope, runReadOnly } = require('../../src/utils/prismaReadOnly');
installReadOnlyGuard(prisma);

const originals = {
  clientFind: prisma.ssoDeveloperClient.findUnique,
  userFind: prisma.user.findUnique,
  tokenUpdate: prisma.mcpToken.update,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  prisma.reset();
  oauth.issuedTokensByCode.clear();
  process.env.SSO_TGE_ENABLED = 'true';
  prisma.user.rows.push({ id: 'synthetic-user', email: 'synthetic@example.test', disabledAt: null });
  prisma.ssoDeveloperClient.rows.push({
    clientId: CLIENT, clientName: 'Synthetic registry client', enabled: true,
    kind: 'partner', secretHash: hash(SECRET), ownerUserId: 'must-not-be-loaded',
    redirectUris: [REDIRECT],
  });
});

afterEach(async () => {
  await tick();
  prisma.ssoDeveloperClient.findUnique = originals.clientFind;
  prisma.user.findUnique = originals.userFind;
  prisma.mcpToken.update = originals.tokenUpdate;
});

function request(clientId = CLIENT, secret = SECRET) {
  const header = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
  return { get: (name) => name.toLowerCase() === 'authorization' ? header : '' };
}

function authorization(clientId = CLIENT, resource = RESOURCE) {
  const code = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const row = {
    id: crypto.randomUUID(), codeHash: hash(code), clientId, userId: 'synthetic-user',
    resource, scope: resource === RESOURCE ? 'sso:identity' : 'openid email',
    redirectUri: REDIRECT, codeChallengeMethod: 'S256',
    codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
  };
  prisma.oAuthAuthorization.rows.push(row);
  return { row, body: { code, code_verifier: verifier, redirect_uri: REDIRECT, resource } };
}

async function refused(promise, status, error, row) {
  await assert.rejects(promise, (failure) => {
    assert.ok(failure instanceof oauth.OAuthError);
    assert.equal(failure.statusCode, status);
    assert.equal(failure.error, error);
    return true;
  });
  assert.equal(row.consumedAt, null);
  assert.equal(prisma.mcpToken.rows.length, 0);
}

test('configured token lookup makes no registry/owner read and keeps disabled state', async () => {
  prisma.ssoDeveloperClient.findUnique = () => assert.fail('configured client queried registry');
  prisma.user.findUnique = () => assert.fail('token lookup queried owner');
  assert.equal((await clients.loadPartnerTokenClient(CONFIGURED)).clientId, CONFIGURED);
  process.env.SSO_TGE_ENABLED = 'false';
  assert.equal((await clients.loadPartnerTokenClient(CONFIGURED)).enabled, false);
});

test('registry lookup selects exactly four fields and never reads owner identity', async () => {
  let observed;
  prisma.ssoDeveloperClient.findUnique = async (args) => {
    observed = args;
    return originals.clientFind(args);
  };
  prisma.user.findUnique = () => assert.fail('token lookup queried owner');
  const client = await clients.loadPartnerTokenClient(CLIENT);
  assert.deepEqual(observed.select, { clientId: true, clientName: true, enabled: true, secretHash: true });
  assert.equal(client.secretHash, hash(SECRET));
  assert.equal(client.kind, 'partner');
  assert.equal(client.ownerUserId, undefined);
  assert.equal(client.autoApprove, undefined);
});

test('direct partner code exchange has two fresh client reads around one current subject read', async () => {
  const { row, body } = authorization();
  const order = [];
  prisma.ssoDeveloperClient.findUnique = async (args) => {
    assert.deepEqual(Object.keys(args.select).sort(), ['clientId', 'clientName', 'enabled', 'secretHash']);
    order.push('client');
    return originals.clientFind(args);
  };
  prisma.user.findUnique = async (args) => {
    order.push('subject');
    return originals.userFind(args);
  };
  const result = await oauth.exchangeAuthorizationCode(request(), body);
  assert.deepEqual(order, ['client', 'subject', 'client']);
  assert.ok(result.access_token.startsWith(PARTNER_TOKEN_PREFIX));
  assert.ok(row.consumedAt instanceof Date);
});

for (const mutation of ['disable', 'rotate']) {
  test(`current ${mutation} committed after subject lookup refuses the old secret before consumption`, async () => {
    const { row, body } = authorization();
    prisma.user.findUnique = async (args) => {
      const user = await originals.userFind(args);
      const client = prisma.ssoDeveloperClient.rows[0];
      if (mutation === 'disable') client.enabled = false;
      else client.secretHash = hash(NEXT_SECRET);
      return user;
    };
    await refused(oauth.exchangeAuthorizationCode(request(), body), 401, 'invalid_client', row);
    if (mutation === 'rotate') {
      const result = await oauth.exchangeAuthorizationCode(request(CLIENT, NEXT_SECRET), body);
      assert.ok(result.access_token.startsWith(PARTNER_TOKEN_PREFIX));
      assert.equal(prisma.mcpToken.rows.length, 1);
    }
  });
}

const invalidRequests = [
  { name: 'wrong client', status: 401, error: 'invalid_client', req: () => request(CONFIGURED) },
  { name: 'wrong PKCE', status: 400, error: 'invalid_grant', body: { code_verifier: 'x'.repeat(43) } },
  { name: 'wrong redirect', status: 400, error: 'invalid_grant', body: { redirect_uri: 'https://other.example.test/callback' } },
  { name: 'wrong audience', status: 400, error: 'invalid_target', body: { resource: 'https://other.example.test/partner/sso' } },
  { name: 'duplicate client authentication', status: 400, error: 'invalid_request', body: { client_secret: SECRET } },
];
for (const fixture of invalidRequests) {
  test(`${fixture.name} keeps the code unconsumed and mints nothing`, async () => {
    const { row, body } = authorization();
    await refused(oauth.exchangeAuthorizationCode(fixture.req ? fixture.req() : request(), { ...body, ...fixture.body }), fixture.status, fixture.error, row);
  });
}

test('a current disabled subject cannot exchange a valid partner code', async () => {
  const { row, body } = authorization();
  prisma.user.rows[0].disabledAt = new Date();
  await refused(oauth.exchangeAuthorizationCode(request(), body), 400, 'invalid_grant', row);
});

test('a successful partner exchange still consumes the code once and rejects replay', async () => {
  const { body } = authorization();
  await oauth.exchangeAuthorizationCode(request(), body);
  await assert.rejects(oauth.exchangeAuthorizationCode(request(), body), (error) => error.error === 'invalid_grant');
});

test('ordinary public MCP checks PKCE before a disabled subject and keeps its original error', async () => {
  const { row, body } = authorization('synthetic-public-mcp', `${ISSUER}/mcp`);
  prisma.user.rows[0].disabledAt = new Date();
  prisma.user.findUnique = () => assert.fail('subject checked before invalid public PKCE');
  await assert.rejects(oauth.exchangeAuthorizationCode({ get: () => '' }, { ...body, code_verifier: 'x'.repeat(43) }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.error, 'invalid_grant');
    assert.equal(error.description, 'PKCE verification failed.');
    return true;
  });
  assert.equal(row.consumedAt, null);
  assert.equal(prisma.mcpToken.rows.length, 0);
});

test('ordinary public MCP still returns access and refresh tokens', async () => {
  const clientId = 'synthetic-public-mcp';
  prisma.oAuthClient.rows.push({ clientId, clientName: 'Synthetic assistant', redirectUris: [REDIRECT], tokenEndpointAuthMethod: 'none' });
  const { row, body } = authorization(clientId, `${ISSUER}/mcp`);
  const result = await oauth.exchangeAuthorizationCode({ get: () => '' }, { ...body, client_id: clientId });
  assert.ok(result.access_token.startsWith(tokens.TOKEN_PREFIX));
  assert.ok(result.refresh_token.startsWith('ddc_rt_'));
  assert.ok(row.consumedAt instanceof Date);
});

async function partnerToken() {
  return (await tokens.issuePartnerToken('synthetic-user', getPartnerClient(CONFIGURED), { resource: RESOURCE, scope: 'sso:identity' })).token;
}

test('profile identity resolves before a blocked bookkeeping update and the write retains its original scope', async () => {
  const raw = await partnerToken();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started = false;
  let scopeBefore;
  let scopeAfter;
  let finished;
  prisma.mcpToken.update = async (args) => {
    started = true;
    scopeBefore = readOnlyScope();
    await blocked;
    scopeAfter = readOnlyScope();
    finished = await originals.tokenUpdate(args);
    return finished;
  };
  try {
    const result = await Promise.race([tokens.findUserByPartnerToken(raw, RESOURCE), tick().then(() => null)]);
    assert.equal(started, true);
    assert.notEqual(result, null);
    assert.equal(result.user.id, 'synthetic-user');
    assert.equal(scopeBefore, null);
    assert.equal(prisma.mcpToken.rows[0].lastUsedAt, undefined);
    await runReadOnly('synthetic partner profile', () => assert.rejects(prisma.user.update({ where: { id: 'synthetic-user' }, data: { name: 'refused' } }), (error) => error.code === 'READ_ONLY_VIOLATION'));
  } finally {
    release();
    await tick();
  }
  assert.equal(scopeAfter, null);
  assert.ok(finished.lastUsedAt instanceof Date);
});

test('synchronous or rejected bookkeeping never rejects identity or leaks an unhandled promise', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const update of [() => { throw new Error('Synthetic synchronous telemetry failure'); }, () => Promise.reject(new Error('Synthetic telemetry rejection'))]) {
      const raw = await partnerToken();
      prisma.mcpToken.update = update;
      assert.equal((await tokens.findUserByPartnerToken(raw, RESOURCE)).user.id, 'synthetic-user');
      await tick();
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the existing 30-second bookkeeping throttle is retained', async () => {
  const raw = await partnerToken();
  prisma.mcpToken.rows[0].lastUsedAt = new Date();
  let writes = 0;
  prisma.mcpToken.update = () => { writes += 1; return Promise.resolve(); };
  assert.equal((await tokens.findUserByPartnerToken(raw, RESOURCE)).user.id, 'synthetic-user');
  assert.equal(writes, 0);
});

test('expired, missing, foreign-source and wrong-audience tokens fail before bookkeeping', async () => {
  prisma.mcpToken.update = () => assert.fail('invalid token triggered bookkeeping');
  for (const mutation of ['expiry', 'missing', 'source', 'audience']) {
    prisma.mcpToken.rows.length = 0;
    const raw = await partnerToken();
    const row = prisma.mcpToken.rows[0];
    if (mutation === 'expiry') row.expiresAt = new Date(0);
    if (mutation === 'missing') prisma.mcpToken.rows.length = 0;
    if (mutation === 'source') row.source = 'manual';
    if (mutation === 'audience') row.resource = 'https://other.example.test/partner/sso';
    assert.equal(await tokens.findUserByPartnerToken(raw, RESOURCE), null);
  }
});
