/**
 * SSO_DEVELOPER_REGISTRATION: self-serve SSO client registration is closed unless the switch is "on".
 *
 * Exercised through the REAL application (src/app.js), so the mount and the order of the route's
 * guards are under test. Also covers the boot half: the value is read once, and a value that is
 * neither off nor on refuses to start in production.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  // passWebServiceController builds an APNs provider at load time; identifiers only.
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_NAME: 'DDC TGE',
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update('tge-secret-dev').digest('hex'),
  SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/oauth/callback',
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'developer-registration-jwt-key',
  SSO_SESSION_SECRET: 'developer-registration-session-key',
});
delete process.env.SSO_DEVELOPER_REGISTRATION;

const app = require('../../src/app');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const {
  readDeveloperRegistration,
  initDeveloperRegistration,
  developerRegistrationOpen,
} = require('../../src/constants/developerRegistration');
const { sha256Hex, verifyClientSecret } = require('../../src/constants/partnerClient');
const { resolveClient } = require('../../src/services/oauthService');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const CLOSED = {
  error: 'registration_closed',
  error_description: 'Self-serve client registration is closed. Contact DataDance to register a client.',
};
const PARTNER_REDIRECT = 'https://partner.example.com/callback';
const registration = (overrides = {}) => ({
  client_name: 'Northwind',
  contact_email: 'dev@example.com',
  redirect_uris: [PARTNER_REDIRECT],
  ...overrides,
});
const register = (body) => request(server).post('/api/developer/sso/clients').send(body);

/** Counts every call into the in-memory Prisma (models, $transaction, $executeRaw) until restored. */
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
  return {
    get calls() { return calls; },
    restore: () => undo.forEach((fn) => fn()),
  };
}

const storeSnapshot = () => JSON.stringify({ store: prisma.store, raw: prisma.rawStatements });

describe('SSO_DEVELOPER_REGISTRATION is read once, at boot', () => {
  after(() => initDeveloperRegistration({ env: {} }));

  it('is off when unset, blank or "off", and on only for "on" (trimmed, any case)', () => {
    for (const value of [undefined, '', '   ', 'off', 'OFF', ' Off ']) {
      assert.deepEqual(readDeveloperRegistration({ SSO_DEVELOPER_REGISTRATION: value }), { open: false, problem: null }, String(value));
    }
    for (const value of ['on', 'ON', ' On ']) {
      assert.deepEqual(readDeveloperRegistration({ SSO_DEVELOPER_REGISTRATION: value }), { open: true, problem: null }, value);
    }
  });

  it('refuses to start in production on any other value', () => {
    for (const value of ['true', 'yes', '1', 'open', 'enabled', 'of', 'on,off']) {
      assert.throws(
        () => initDeveloperRegistration({ env: { NODE_ENV: 'production', SSO_DEVELOPER_REGISTRATION: value } }),
        /^Error: SSO_DEVELOPER_REGISTRATION must be "off" or "on" \(got ".*"\); refusing to start$/,
        value,
      );
    }
  });

  it('outside production, another value is one warning and reads as off', () => {
    const warnings = [];
    const state = initDeveloperRegistration({
      env: { NODE_ENV: 'development', SSO_DEVELOPER_REGISTRATION: 'yes' },
      log: { warn: (...args) => warnings.push(args.join(' ')) },
    });
    assert.equal(state.open, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SSO_DEVELOPER_REGISTRATION must be "off" or "on" \(got "yes"\); reading it as "off"/);
  });

  it('a running process does not re-read the environment', async () => {
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'off' } });
    process.env.SSO_DEVELOPER_REGISTRATION = 'on';
    try {
      assert.equal(developerRegistrationOpen(), false);
      const res = await register(registration());
      assert.equal(res.status, 403);
      assert.deepEqual(res.body, CLOSED);
    } finally {
      delete process.env.SSO_DEVELOPER_REGISTRATION;
    }
  });

  it('src/server.js reads it after dotenv.config() and before the server listens', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    const initAt = src.indexOf('initDeveloperRegistration();');
    assert.ok(initAt > -1, 'server.js must call initDeveloperRegistration()');
    assert.ok(src.indexOf('dotenv.config();') < initAt, 'after dotenv.config()');
    assert.ok(initAt < src.indexOf('app.listen('), 'before app.listen()');
  });

  it('the money-path boot line reports it next to publicClientRegistration', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    const line = src.slice(src.indexOf('Partner SSO money-path assertions OK'));
    assert.match(line, /publicClientRegistration=\$\{moneyPath\.publicRegistration \? 'open' : 'closed'\} ` \+\s+`developerRegistration=\$\{moneyPath\.developerRegistration \? 'open' : 'closed'\}`/);
  });
});

describe('registration closed (the default)', () => {
  beforeEach(() => {
    prisma.reset();
    clearRateLimitStore();
    initDeveloperRegistration({ env: {} });
  });

  it('answers 403 registration_closed and touches no table', async () => {
    const before = storeSnapshot();
    const db = watchDatabase();
    let res;
    try {
      res = await register(registration());
    } finally {
      db.restore();
    }
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, CLOSED);
    assert.equal(db.calls, 0, 'no database call at all');
    assert.equal(storeSnapshot(), before, 'nothing written');
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('answers every request the same way, before validation and before the rate limiter', async () => {
    const bodies = [registration(), {}, registration({ redirect_uris: ['http://example.com/cb'] }), registration({ contact_email: 'x' })];
    // Seven in a row: the per-IP limit is 5 an hour, so a 429 here would mean the limiter ran first.
    for (let i = 0; i < 7; i += 1) {
      const res = await register(bodies[i % bodies.length]);
      assert.equal(res.status, 403, `request ${i + 1}`);
      assert.deepEqual(res.body, CLOSED);
    }
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('a logged-in account is refused as well', async () => {
    await prisma.user.create({ data: { id: 'user-dev-1', email: 'member@example.com', isOrganization: false, userType: 'regular', disabledAt: null } });
    const userJwt = jwt.sign({ id: 'user-dev-1', ver: 2 }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const res = await register(registration()).set('Authorization', `Bearer ${userJwt}`);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, CLOSED);
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('a client registered earlier keeps working', async () => {
    const secret = 'ddc_sso_secret_registered-before-the-switch';
    await prisma.ssoDeveloperClient.create({
      data: {
        id: 'dev-client-1',
        clientId: 'sso_registered_earlier',
        clientName: 'Northwind',
        contactEmail: 'dev@example.com',
        secretHash: sha256Hex(secret),
        redirectUris: [PARTNER_REDIRECT],
        enabled: true,
      },
    });
    const client = await resolveClient('sso_registered_earlier');
    assert.equal(client.developer, true);
    assert.equal(client.enabled, true);
    assert.equal(verifyClientSecret(client, secret), true);

    const challenge = crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url');
    const res = await request(server).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'sso_registered_earlier',
      redirect_uri: PARTNER_REDIRECT,
      state: 's'.repeat(24),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'sso:identity',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^https:\/\/app\.test\.local\/oauth\/consent\?request=/);
  });
});

describe('registration open (SSO_DEVELOPER_REGISTRATION=on)', () => {
  beforeEach(() => {
    prisma.reset();
    clearRateLimitStore();
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'on' } });
  });
  after(() => initDeveloperRegistration({ env: {} }));

  it('creates the client as before, with no login needed: the secret once, only its hash stored', async () => {
    const res = await register(registration({ contact_email: 'Dev@Example.com', redirect_uris: [PARTNER_REDIRECT, PARTNER_REDIRECT] }));
    assert.equal(res.status, 201);
    assert.match(res.body.client_id, /^sso_[A-Za-z0-9_-]+$/);
    assert.match(res.body.client_secret, /^ddc_sso_secret_/);
    assert.deepEqual(
      { ...res.body, client_id: '*', client_secret: '*' },
      {
        client_id: '*',
        client_secret: '*',
        client_name: 'Northwind',
        redirect_uris: [PARTNER_REDIRECT],
        token_endpoint_auth_method: 'client_secret_post',
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        userinfo_endpoint: `${ISSUER}/partner/sso/me`,
        resource: `${ISSUER}/partner/sso`,
        scopes: ['sso:identity', 'sso:status', 'sso:email', 'sso:wallet'],
      },
    );
    assert.equal(prisma.store.ssoDeveloperClient.length, 1);
    const row = prisma.store.ssoDeveloperClient[0];
    assert.equal(row.clientId, res.body.client_id);
    assert.equal(row.contactEmail, 'dev@example.com');
    assert.equal(row.secretHash, sha256Hex(res.body.client_secret));
    assert.equal(JSON.stringify(prisma.store).includes(res.body.client_secret), false);
  });

  it('validates and rate-limits as before', async () => {
    const bad = await register(registration({ redirect_uris: ['http://example.com/cb'] }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_redirect_uri');
    for (let i = 0; i < 4; i += 1) assert.equal((await register(registration())).status, 201, `request ${i + 2}`);
    const limited = await register(registration());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'slow_down');
    assert.equal(prisma.store.ssoDeveloperClient.length, 4);
  });
});
