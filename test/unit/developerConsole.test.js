/**
 * The developer account console: GET /api/developer/sso/clients, POST /clients/update and
 * POST /clients/secret. A signed-in account sees and changes only the clients it owns.
 *
 * Exercised through the REAL application (src/app.js), like developerRegistration.test.js, so the
 * mount, `protect`, the per-account limiters and the response headers are all under test.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();
// `protect` constructs its own PrismaClient at load; route it to the same in-memory store.
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const ISSUER = 'https://api.test.local';
const ENV_PARTNER_ID = 'planet-env';
const ENV_PARTNER_REDIRECT = 'https://planet.example.com/oauth/callback';
Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  // passWebServiceController builds an APNs provider at load time; identifiers only.
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: ENV_PARTNER_ID,
  SSO_TGE_CLIENT_NAME: 'Data Planet',
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update('env-partner-secret-dev').digest('hex'),
  SSO_TGE_REDIRECT_URIS: ENV_PARTNER_REDIRECT,
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'developer-console-jwt-key',
  SSO_SESSION_SECRET: 'developer-console-session-key',
});
delete process.env.SSO_DEVELOPER_REGISTRATION;

const app = require('../../src/app');
const developerSsoRoutes = require('../../src/routes/developerSsoRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { initDeveloperRegistration } = require('../../src/constants/developerRegistration');
const { sha256Hex, verifyClientSecret, availablePartnerScopes } = require('../../src/constants/partnerClient');
const { resolveClient } = require('../../src/services/oauthService');
const {
  listOwnedClients,
  updateOwnedClient,
  rotateOwnedSecret,
  loadPartnerClient,
} = require('../../src/services/ssoDeveloperClient');
const { signSsoSession } = require('../../src/routes/ssoRoutes');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const DEVELOPER_SCOPES = ['sso:identity', 'sso:status', 'sso:email', 'sso:wallet'];
const OWNER = { id: 'user-owner-1', email: 'owner@example.com', isOrganization: false, userType: 'regular', disabledAt: null };
const OTHER = { id: 'user-other-2', email: 'other@example.com', isOrganization: false, userType: 'regular', disabledAt: null };
const NOBODY = { id: 'user-empty-3', email: 'empty@example.com', isOrganization: false, userType: 'regular', disabledAt: null };
const OWN_REDIRECT = 'https://owner.example.com/callback';
const OTHER_REDIRECT = 'https://other.example.com/callback';
const NOT_ON_ACCOUNT = { error: 'not_found', error_description: 'This client is not on this account.' };
const LOGIN_REQUIRED = { status: 'fail', message: 'Authentication required. Please login first.' };

const SECRETS = {
  own: 'ddc_sso_secret_owner-dev-client',
  ownPartner: 'ddc_sso_secret_owner-partner-row',
  ownManaged: 'ddc_sso_secret_owner-env-shadowed-row',
  other: 'ddc_sso_secret_other-dev-client',
  orphan: 'ddc_sso_secret_unowned-client',
};

const signedIn = (user = OWNER) => `Bearer ${jwt.sign({ id: user.id, ver: 2 }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;

const list = (authorization) => {
  const req = request(server).get('/api/developer/sso/clients');
  if (authorization) req.set('Authorization', authorization);
  return req;
};
const update = (body, authorization) => {
  const req = request(server).post('/api/developer/sso/clients/update');
  if (authorization) req.set('Authorization', authorization);
  return req.send(body);
};
const rotate = (body, authorization) => {
  const req = request(server).post('/api/developer/sso/clients/secret');
  if (authorization) req.set('Authorization', authorization);
  return req.send(body);
};

async function seedClient(data) {
  return prisma.ssoDeveloperClient.create({
    data: {
      contactEmail: 'dev@example.com',
      enabled: true,
      kind: 'developer',
      ownerUserId: null,
      ...data,
    },
  });
}

async function seed() {
  for (const user of [OWNER, OTHER, NOBODY]) await prisma.user.create({ data: { ...user } });
  await seedClient({
    clientId: 'sso_owner_dev', clientName: 'Owner App', secretHash: sha256Hex(SECRETS.own),
    redirectUris: [OWN_REDIRECT], ownerUserId: OWNER.id, createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  // A first-party partner row the owner was assigned to manage, not shadowed by the environment.
  await seedClient({
    clientId: 'planet-registry', clientName: 'Data Planet (registry)', secretHash: sha256Hex(SECRETS.ownPartner),
    redirectUris: [], enabled: false, kind: 'partner', ownerUserId: OWNER.id, createdAt: new Date('2026-10-02T00:00:00Z'),
  });
  // A row with the environment partner's id: the environment's settings and secret win.
  await seedClient({
    clientId: ENV_PARTNER_ID, clientName: 'Data Planet', secretHash: sha256Hex(SECRETS.ownManaged),
    redirectUris: [], enabled: false, kind: 'partner', ownerUserId: OWNER.id, createdAt: new Date('2026-10-03T00:00:00Z'),
  });
  await seedClient({
    clientId: 'sso_other_dev', clientName: 'Other App', secretHash: sha256Hex(SECRETS.other),
    redirectUris: [OTHER_REDIRECT], ownerUserId: OTHER.id,
  });
  await seedClient({
    clientId: 'sso_unowned', clientName: 'Unowned', secretHash: sha256Hex(SECRETS.orphan),
    redirectUris: [OTHER_REDIRECT], ownerUserId: null,
  });
}

const row = (clientId) => prisma.store.ssoDeveloperClient.find((r) => r.clientId === clientId);
const rowsSnapshot = () => JSON.stringify(prisma.store.ssoDeveloperClient);

/** Collects the console's audit lines until restored. */
function captureAudit() {
  const lines = [];
  const original = developerSsoRoutes.consoleAudit.write;
  developerSsoRoutes.consoleAudit.write = (event, entry) => lines.push({ event, entry });
  return { lines, restore: () => { developerSsoRoutes.consoleAudit.write = original; } };
}

/** Collects the console's failure log lines until restored. */
function captureConsoleLog() {
  const lines = [];
  const original = developerSsoRoutes.consoleLog.error;
  developerSsoRoutes.consoleLog.error = (event, entry) => lines.push({ event, entry });
  return { lines, restore: () => { developerSsoRoutes.consoleLog.error = original; } };
}

/** Swaps one method of the in-memory client registry; returns the undo. */
function replaceRegistryMethod(name, impl) {
  const model = prisma.ssoDeveloperClient;
  const original = model[name];
  model[name] = impl;
  return () => { model[name] = original; };
}

/** No hash, no stored contact address, no owner id, no plaintext secret anywhere in a body. */
function assertNoSecretMaterial(body) {
  const text = JSON.stringify(body);
  for (const r of prisma.store.ssoDeveloperClient) {
    assert.equal(text.includes(r.secretHash), false, `hash of ${r.clientId} leaked`);
  }
  for (const secret of Object.values(SECRETS)) assert.equal(text.includes(secret), false, 'a stored secret leaked');
  assert.doesNotMatch(text, /secretHash|secret_hash|contactEmail|contact_email|ownerUserId|owner_user_id/);
}

beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  initDeveloperRegistration({ env: {} });
  await seed();
});

describe('every console route requires a DataDance session', () => {
  const routes = [
    ['GET /clients', (auth) => list(auth)],
    ['POST /clients/update', (auth) => update({ client_id: 'sso_owner_dev', redirect_uris: [OWN_REDIRECT], enabled: false }, auth)],
    ['POST /clients/secret', (auth) => rotate({ client_id: 'sso_owner_dev' }, auth)],
  ];

  it('anonymous: 401 in the usual auth shape, nothing changed', async () => {
    const before = rowsSnapshot();
    for (const [name, send] of routes) {
      const res = await send();
      assert.equal(res.status, 401, name);
      assert.deepEqual(res.body, LOGIN_REQUIRED, name);
      assert.equal(res.headers['cache-control'], 'no-store', name);
    }
    assert.equal(rowsSnapshot(), before);
  });

  it('a token that does not verify, an SSO session or a partner access token: 401, nothing changed', async () => {
    const before = rowsSnapshot();
    const forged = `Bearer ${jwt.sign({ id: OWNER.id, ver: 2 }, 'not-the-server-key', { expiresIn: '5m' })}`;
    const { token: ssoSession } = signSsoSession({ userId: OWNER.id, clientId: ENV_PARTNER_ID, jti: 'console-j-1' });
    const credentials = [forged, 'Bearer not-a-jwt', `Bearer ${ssoSession}`, `Bearer ddc_sso_${'x'.repeat(43)}`];
    for (const [name, send] of routes) {
      for (const authorization of credentials) {
        const res = await send(authorization);
        assert.equal(res.status, 401, `${name} with ${authorization.slice(0, 16)}`);
        assert.equal(res.body.status, 'fail');
      }
    }
    assert.equal(rowsSnapshot(), before);
  });

  it('a disabled account: 403 ACCOUNT_DISABLED, nothing changed', async () => {
    await prisma.user.update({ where: { id: OWNER.id }, data: { disabledAt: new Date('2026-10-01T00:00:00Z') } });
    const before = rowsSnapshot();
    for (const [name, send] of routes) {
      const res = await send(signedIn());
      assert.equal(res.status, 403, name);
      assert.equal(res.body.code, 'ACCOUNT_DISABLED', name);
    }
    assert.equal(rowsSnapshot(), before);
  });
});

describe('GET /api/developer/sso/clients', () => {
  it('lists only the clients this account owns, with the settings in effect and no secret material', async () => {
    const res = await list(signedIn());
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.email, OWNER.email);
    const byId = Object.fromEntries(res.body.clients.map((c) => [c.client_id, c]));
    assert.deepEqual(Object.keys(byId).sort(), ['planet-env', 'planet-registry', 'sso_owner_dev']);
    assert.deepEqual(byId.sso_owner_dev, {
      client_id: 'sso_owner_dev',
      client_name: 'Owner App',
      kind: 'developer',
      redirect_uris: [OWN_REDIRECT],
      enabled: true,
      scopes: DEVELOPER_SCOPES,
      managed: false,
      created_at: '2026-10-01T00:00:00.000Z',
    });
    assert.equal(byId['planet-registry'].kind, 'partner');
    assert.equal(byId['planet-registry'].managed, false);
    assert.deepEqual(byId['planet-registry'].scopes, [...availablePartnerScopes()]);
    // The environment partner: what the token endpoint uses, not the shadowed row.
    assert.equal(byId['planet-env'].managed, true);
    assert.equal(byId['planet-env'].kind, 'partner');
    assert.deepEqual(byId['planet-env'].redirect_uris, [ENV_PARTNER_REDIRECT]);
    assert.equal(byId['planet-env'].enabled, true);
    assertNoSecretMaterial(res.body);
  });

  it('another account sees only its own; an account with none gets an empty list', async () => {
    const other = await list(signedIn(OTHER));
    assert.equal(other.status, 200);
    assert.equal(other.body.email, OTHER.email);
    assert.deepEqual(other.body.clients.map((c) => c.client_id), ['sso_other_dev']);
    assertNoSecretMaterial(other.body);
    const empty = await list(signedIn(NOBODY));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { email: NOBODY.email, clients: [] });
  });

  it('is rate-limited per account', async () => {
    for (let i = 0; i < 30; i += 1) assert.equal((await list(signedIn())).status, 200, `request ${i + 1}`);
    const limited = await list(signedIn());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'slow_down');
    assert.equal((await list(signedIn(OTHER))).status, 200, 'another account keeps its own budget');
  });
});

describe('POST /api/developer/sso/clients/update', () => {
  it('changes the redirect URIs and the switch of an owned client, and nothing else', async () => {
    const audit = captureAudit();
    try {
      const before = { ...row('sso_owner_dev') };
      const next = ['https://owner.example.com/v2/callback', 'http://localhost:3000/cb', 'https://owner.example.com/v2/callback'];
      const res = await update({ client_id: 'sso_owner_dev', redirect_uris: next, enabled: false, client_name: 'Renamed' }, signedIn());
      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(res.body, {
        client_id: 'sso_owner_dev',
        client_name: 'Owner App',
        kind: 'developer',
        redirect_uris: ['https://owner.example.com/v2/callback', 'http://localhost:3000/cb'],
        enabled: false,
        scopes: DEVELOPER_SCOPES,
        managed: false,
        created_at: '2026-10-01T00:00:00.000Z',
      });
      const after = row('sso_owner_dev');
      assert.deepEqual(after.redirectUris, ['https://owner.example.com/v2/callback', 'http://localhost:3000/cb']);
      assert.equal(after.enabled, false);
      assert.deepEqual(
        { ...after, redirectUris: before.redirectUris, enabled: before.enabled },
        before,
        'name, secret hash, kind and owner are unchanged',
      );
      assertNoSecretMaterial(res.body);
      assert.deepEqual(audit.lines, [{
        event: 'developer_console.update',
        entry: { reqId: audit.lines[0].entry.reqId, userId: OWNER.id, clientId: 'sso_owner_dev', outcome: 'ok' },
      }]);
      assert.match(audit.lines[0].entry.reqId, /^[0-9a-f-]{36}$/);
    } finally {
      audit.restore();
    }
  });

  it('keeps the switch as it is when enabled is not sent', async () => {
    const res = await update({ client_id: 'sso_owner_dev', redirect_uris: [OWN_REDIRECT] }, signedIn());
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(row('sso_owner_dev').enabled, true);
  });

  it("another account's client answers 404 exactly like an unknown id, and nothing changes", async () => {
    const audit = captureAudit();
    try {
      const before = rowsSnapshot();
      const body = (clientId) => ({ client_id: clientId, redirect_uris: ['https://elsewhere.example.com/cb'], enabled: true });
      for (const clientId of ['sso_other_dev', 'sso_unowned', 'sso_does_not_exist']) {
        const res = await update(body(clientId), signedIn());
        assert.equal(res.status, 404, clientId);
        assert.deepEqual(res.body, NOT_ON_ACCOUNT, clientId);
      }
      // And the other way round.
      const reverse = await update(body('sso_owner_dev'), signedIn(OTHER));
      assert.equal(reverse.status, 404);
      assert.deepEqual(reverse.body, NOT_ON_ACCOUNT);
      assert.equal(rowsSnapshot(), before);
      assert.deepEqual(audit.lines.map((l) => [l.entry.userId, l.entry.clientId, l.entry.outcome]), [
        [OWNER.id, 'sso_other_dev', 'not_found'],
        [OWNER.id, 'sso_unowned', 'not_found'],
        [OWNER.id, 'sso_does_not_exist', 'not_found'],
        [OTHER.id, 'sso_owner_dev', 'not_found'],
      ]);
    } finally {
      audit.restore();
    }
  });

  it('validates redirect URIs with the registration rules, and the other fields, before anything is written', async () => {
    const before = rowsSnapshot();
    const cases = [
      [{ redirect_uris: ['http://owner.example.com/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://owner.example.com/cb#frag'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://user:pass@owner.example.com/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['ftp://owner.example.com/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: [`https://owner.example.com/${'a'.repeat(520)}`] }, 'invalid_redirect_uri'],
      [{ redirect_uris: [] }, 'invalid_redirect_uri'],
      [{ redirect_uris: 'https://owner.example.com/cb' }, 'invalid_redirect_uri'],
      [{ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://owner.example.com/cb${i}`) }, 'invalid_redirect_uri'],
      [{ redirect_uris: [OWN_REDIRECT], enabled: 'false' }, 'invalid_request'],
      [{ redirect_uris: [OWN_REDIRECT], enabled: 0 }, 'invalid_request'],
    ];
    for (const [extra, code] of cases) {
      const res = await update({ client_id: 'sso_owner_dev', ...extra }, signedIn());
      assert.equal(res.status, 400, JSON.stringify(extra).slice(0, 80));
      assert.equal(res.body.error, code, JSON.stringify(extra).slice(0, 80));
      assert.equal(typeof res.body.error_description, 'string');
    }
    for (const clientId of [undefined, '', 42, ['sso_owner_dev'], { not: 'sso_other_dev' }, 'sso owner', 'x'.repeat(129)]) {
      const res = await update({ client_id: clientId, redirect_uris: [OWN_REDIRECT] }, signedIn());
      assert.equal(res.status, 400, JSON.stringify(clientId));
      assert.deepEqual(res.body, { error: 'invalid_request', error_description: 'client_id is required.' });
    }
    assert.equal(rowsSnapshot(), before);
  });

  it('a client the environment configures is not changed from the console', async () => {
    const before = rowsSnapshot();
    const res = await update({ client_id: ENV_PARTNER_ID, redirect_uris: [OWN_REDIRECT], enabled: true }, signedIn());
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: 'managed_client',
      error_description: 'DataDance manages this client. Contact DataDance to change it.',
    });
    // To anyone else it is just not on their account.
    const other = await update({ client_id: ENV_PARTNER_ID, redirect_uris: [OWN_REDIRECT] }, signedIn(OTHER));
    assert.equal(other.status, 404);
    assert.deepEqual(other.body, NOT_ON_ACCOUNT);
    assert.equal(rowsSnapshot(), before);
  });

  it('an assigned partner row follows its manager: the manager can configure it', async () => {
    const res = await update({ client_id: 'planet-registry', redirect_uris: ['https://planet.example.com/cb'], enabled: true }, signedIn());
    assert.equal(res.status, 200);
    assert.equal(res.body.kind, 'partner');
    assert.deepEqual(row('planet-registry').redirectUris, ['https://planet.example.com/cb']);
    assert.equal(row('planet-registry').enabled, true);
    assert.equal(row('planet-registry').kind, 'partner');
  });

  it('is rate-limited per account', async () => {
    const body = { client_id: 'sso_owner_dev', redirect_uris: [OWN_REDIRECT], enabled: true };
    for (let i = 0; i < 20; i += 1) assert.equal((await update(body, signedIn())).status, 200, `request ${i + 1}`);
    const limited = await update(body, signedIn());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'slow_down');
    assert.equal((await update({ ...body, client_id: 'sso_other_dev', redirect_uris: [OTHER_REDIRECT] }, signedIn(OTHER))).status, 200);
  });
});

describe('POST /api/developer/sso/clients/secret', () => {
  it('returns a new secret once, stores only its hash, and the old secret stops working', async () => {
    const audit = captureAudit();
    try {
      const res = await rotate({ client_id: 'sso_owner_dev' }, signedIn());
      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers.pragma, 'no-cache');
      assert.match(res.body.client_secret, /^ddc_sso_secret_[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(
        { ...res.body, client_secret: '*' },
        {
          client_id: 'sso_owner_dev',
          client_secret: '*',
          client_name: 'Owner App',
          redirect_uris: [OWN_REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          userinfo_endpoint: `${ISSUER}/partner/sso/me`,
          resource: `${ISSUER}/partner/sso`,
          scopes: DEVELOPER_SCOPES,
        },
      );
      const fresh = res.body.client_secret;
      assert.equal(row('sso_owner_dev').secretHash, sha256Hex(fresh));
      assert.equal(JSON.stringify(prisma.store).includes(fresh), false, 'the plaintext is never stored');

      const client = await resolveClient('sso_owner_dev');
      assert.equal(verifyClientSecret(client, fresh), true, 'the token endpoint accepts the new secret');
      assert.equal(verifyClientSecret(client, SECRETS.own), false, 'the old secret no longer works');

      // Shown once: nothing reads it back.
      const listed = await list(signedIn());
      assert.equal(JSON.stringify(listed.body).includes(fresh), false);
      assertNoSecretMaterial(listed.body);

      // Rotating again issues a different secret and retires the previous one.
      const again = await rotate({ client_id: 'sso_owner_dev' }, signedIn());
      assert.equal(again.status, 200);
      assert.notEqual(again.body.client_secret, fresh);
      const reloaded = await resolveClient('sso_owner_dev');
      assert.equal(verifyClientSecret(reloaded, fresh), false);
      assert.equal(verifyClientSecret(reloaded, again.body.client_secret), true);

      assert.deepEqual(audit.lines.map((l) => [l.event, l.entry.userId, l.entry.clientId, l.entry.outcome]), [
        ['developer_console.rotate_secret', OWNER.id, 'sso_owner_dev', 'ok'],
        ['developer_console.rotate_secret', OWNER.id, 'sso_owner_dev', 'ok'],
      ]);
      for (const { entry } of audit.lines) {
        assert.deepEqual(Object.keys(entry).sort(), ['clientId', 'outcome', 'reqId', 'userId']);
        assert.equal(JSON.stringify(entry).includes('ddc_sso_secret_'), false);
      }
    } finally {
      audit.restore();
    }
  });

  it("another account's client answers 404 like an unknown id, and its secret keeps working", async () => {
    const before = rowsSnapshot();
    for (const clientId of ['sso_other_dev', 'sso_unowned', 'sso_does_not_exist']) {
      const res = await rotate({ client_id: clientId }, signedIn());
      assert.equal(res.status, 404, clientId);
      assert.deepEqual(res.body, NOT_ON_ACCOUNT, clientId);
      assert.equal(res.body.client_secret, undefined);
    }
    assert.equal(rowsSnapshot(), before);
    assert.equal(verifyClientSecret(await resolveClient('sso_other_dev'), SECRETS.other), true);
  });

  it('a malformed client_id is refused before any lookup', async () => {
    const before = rowsSnapshot();
    for (const body of [{}, { client_id: { not: 'x' } }, { client_id: ['sso_owner_dev'] }, { client_id: 'a b' }]) {
      const res = await rotate(body, signedIn());
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.body, { error: 'invalid_request', error_description: 'client_id is required.' });
    }
    assert.equal(rowsSnapshot(), before);
  });

  it('a client the environment configures keeps its secret in the environment: 409, nothing issued', async () => {
    const before = rowsSnapshot();
    const res = await rotate({ client_id: ENV_PARTNER_ID }, signedIn());
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'managed_client');
    assert.equal(res.body.client_secret, undefined);
    assert.equal(rowsSnapshot(), before);
  });

  it('an assigned partner row: its manager rotates it and the token endpoint takes the new secret', async () => {
    const res = await rotate({ client_id: 'planet-registry' }, signedIn());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.scopes, [...availablePartnerScopes()]);
    // The seeded row is still switched off, so read it the way the token endpoint does, without the enabled gate.
    const client = await loadPartnerClient('planet-registry');
    assert.equal(client.firstParty, true);
    assert.equal(verifyClientSecret(client, res.body.client_secret), true);
    assert.equal(verifyClientSecret(client, SECRETS.ownPartner), false);
  });

  it('reads the issuer before writing: when it cannot be read, the old secret stays and nothing is issued', async () => {
    const audit = captureAudit();
    const log = captureConsoleLog();
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    let res;
    const before = rowsSnapshot();
    try {
      res = await rotate({ client_id: 'sso_owner_dev' }, signedIn());
    } finally {
      process.env.PUBLIC_BASE_URL = saved;
      audit.restore();
      log.restore();
    }
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'server_error', error_description: 'Could not complete that request.' });
    assert.equal(rowsSnapshot(), before, 'the stored hash is unchanged');
    assert.equal(verifyClientSecret(await resolveClient('sso_owner_dev'), SECRETS.own), true, 'the old secret still works');
    assert.deepEqual(audit.lines.map((l) => [l.event, l.entry.outcome]), [['developer_console.rotate_secret', 'server_error']]);
    assert.deepEqual(log.lines, [{
      event: 'Developer console secret rotation failed',
      entry: { reqId: res.headers['x-request-id'], errorCode: null, errorName: 'Error' },
    }]);
    assert.equal(JSON.stringify(log.lines).includes('PUBLIC_BASE_URL'), false, 'the message is not logged');
  });

  it('a failing audit line after the write does not cost the caller the new secret', async () => {
    const log = captureConsoleLog();
    const original = developerSsoRoutes.consoleAudit.write;
    developerSsoRoutes.consoleAudit.write = () => { throw new Error('audit sink down ddc_sso_secret_in-a-message'); };
    let res;
    try {
      res = await rotate({ client_id: 'sso_owner_dev' }, signedIn());
    } finally {
      developerSsoRoutes.consoleAudit.write = original;
      log.restore();
    }
    assert.equal(res.status, 200);
    assert.match(res.body.client_secret, /^ddc_sso_secret_[A-Za-z0-9_-]{43}$/);
    assert.equal(res.body.issuer, ISSUER);
    assert.equal(row('sso_owner_dev').secretHash, sha256Hex(res.body.client_secret));
    const client = await resolveClient('sso_owner_dev');
    assert.equal(verifyClientSecret(client, res.body.client_secret), true);
    assert.equal(verifyClientSecret(client, SECRETS.own), false);
    assert.deepEqual(log.lines, [{
      event: 'developer_console.audit_failed',
      entry: { reqId: res.headers['x-request-id'], action: 'rotate_secret', errorName: 'Error' },
    }]);
  });

  it('is rate-limited per account, failed attempts included', async () => {
    for (let i = 0; i < 4; i += 1) assert.equal((await rotate({ client_id: 'sso_owner_dev' }, signedIn())).status, 200, `request ${i + 1}`);
    assert.equal((await rotate({ client_id: 'sso_other_dev' }, signedIn())).status, 404);
    const limited = await rotate({ client_id: 'sso_owner_dev' }, signedIn());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'slow_down');
    assert.equal(limited.body.client_secret, undefined);
    assert.equal((await rotate({ client_id: 'sso_other_dev' }, signedIn(OTHER))).status, 200, 'another account keeps its own budget');
  });
});

describe('a console failure is logged by request id, error code and name, never by message', () => {
  const SERVER_ERROR = { error: 'server_error', error_description: 'Could not complete that request.' };

  it('a Prisma validation error on the rotate write: the hash it printed is not logged, nothing changes', async () => {
    const log = captureConsoleLog();
    let attemptedHash = null;
    const restoreWrite = replaceRegistryMethod('updateMany', async ({ data }) => {
      attemptedHash = data.secretHash;
      // How Prisma 5 reports a rejected call: the arguments, values included.
      const error = new Error(
        `Invalid \`prisma.ssoDeveloperClient.updateMany()\` invocation:\n\n{\n  data: {\n    secretHash: "${data.secretHash}"\n  }\n}\n\nUnknown argument \`secretHash\`.`,
      );
      error.name = 'PrismaClientValidationError';
      throw error;
    });
    const before = rowsSnapshot();
    let res;
    try {
      res = await rotate({ client_id: 'sso_owner_dev' }, signedIn());
    } finally {
      restoreWrite();
      log.restore();
    }
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, SERVER_ERROR);
    assert.equal(rowsSnapshot(), before);
    assert.match(attemptedHash, /^[0-9a-f]{64}$/);
    assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.deepEqual(log.lines, [{
      event: 'Developer console secret rotation failed',
      entry: { reqId: res.headers['x-request-id'], errorCode: null, errorName: 'PrismaClientValidationError' },
    }]);
    const logged = JSON.stringify(log.lines);
    assert.equal(logged.includes(attemptedHash), false, 'the attempted hash is not logged');
    assert.doesNotMatch(logged, /secretHash|invocation/);
  });

  it('a known request error on the list: its code and name are logged, its message is not', async () => {
    const log = captureConsoleLog();
    const restoreRead = replaceRegistryMethod('findMany', async () => {
      const error = new Error(`Foreign key constraint failed on ownerUserId = ${OWNER.id} (${OWNER.email})`);
      error.name = 'PrismaClientKnownRequestError';
      error.code = 'P2003';
      throw error;
    });
    let res;
    try {
      res = await list(signedIn());
    } finally {
      restoreRead();
      log.restore();
    }
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, SERVER_ERROR);
    assert.deepEqual(log.lines, [{
      event: 'Developer console list failed',
      entry: { reqId: res.headers['x-request-id'], errorCode: 'P2003', errorName: 'PrismaClientKnownRequestError' },
    }]);
    const logged = JSON.stringify(log.lines);
    assert.equal(logged.includes(OWNER.id), false);
    assert.equal(logged.includes(OWNER.email), false);
  });

  it('a code or name that is not a plain identifier is dropped, not logged', async () => {
    const hash = sha256Hex(SECRETS.own);
    const hostile = [
      [hash, hash],
      ['ddc_sso_secret_abc', 'ddc_sso_secret_abc'],
      [`P2025 ${hash}`, `Error: ${hash}`],
      [{ value: hash }, ['TypeError']],
    ];
    for (const [code, name] of hostile) {
      const log = captureConsoleLog();
      const restoreRead = replaceRegistryMethod('findFirst', async () => {
        const error = new Error(hash);
        error.code = code;
        error.name = name;
        throw error;
      });
      let res;
      try {
        res = await update({ client_id: 'sso_owner_dev', redirect_uris: [OWN_REDIRECT] }, signedIn());
      } finally {
        restoreRead();
        log.restore();
      }
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, SERVER_ERROR);
      assert.deepEqual(log.lines, [{
        event: 'Developer console update failed',
        entry: { reqId: res.headers['x-request-id'], errorCode: null, errorName: null },
      }], JSON.stringify(code).slice(0, 40));
      assert.equal(JSON.stringify(log.lines).includes('ddc_sso_secret_'), false);
      assert.equal(JSON.stringify(log.lines).includes(hash), false);
    }
  });
});

describe('the service never runs without an owner', () => {
  it('listing, updating and rotating refuse a missing owner instead of matching every row', async () => {
    const before = rowsSnapshot();
    for (const owner of [undefined, null, '', 42, { not: OWNER.id }]) {
      await assert.rejects(listOwnedClients(owner), { status: 401, code: 'login_required' });
      await assert.rejects(updateOwnedClient(owner, { client_id: 'sso_owner_dev', redirect_uris: [OWN_REDIRECT] }), { status: 401 });
      await assert.rejects(rotateOwnedSecret(owner, 'sso_owner_dev'), { status: 401 });
    }
    assert.equal(rowsSnapshot(), before);
  });
});

describe('registration is unchanged', () => {
  it('POST /clients still answers 403 registration_closed while the switch is off, signed in or not', async () => {
    for (const authorization of [undefined, signedIn()]) {
      const req = request(server).post('/api/developer/sso/clients');
      if (authorization) req.set('Authorization', authorization);
      const res = await req.send({ client_name: 'X', contact_email: 'x@example.com', redirect_uris: [OWN_REDIRECT] });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'registration_closed');
    }
  });
});
