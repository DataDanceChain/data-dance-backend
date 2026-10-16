/**
 * SSO_DEVELOPER_REGISTRATION: self-serve SSO client registration is closed unless the switch is "on"
 * (any signed-in account) or "allowlist" (only the accounts in SSO_DEVELOPER_ALLOWED_EMAILS, from a
 * verified login e-mail).
 *
 * Exercised through the REAL application (src/app.js), so the mount and the order of the route's
 * guards are under test. Also covers the boot half: the value is read once, and a value that is
 * not off, on or allowlist, or an allowlist entry that is not an e-mail, refuses to start in production.
 */
const { describe, it, before, beforeEach, after, afterEach } = require('node:test');
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
delete process.env.SSO_DEVELOPER_ALLOWED_EMAILS;

const app = require('../../src/app');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const {
  readDeveloperRegistration,
  describeDeveloperRegistration,
  initDeveloperRegistration,
  developerRegistrationMode,
  developerRegistrationOpen,
  registrationDecision,
} = require('../../src/constants/developerRegistration');
const developerSsoRoutes = require('../../src/routes/developerSsoRoutes');
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
const register = (body, authorization) => {
  const req = request(server).post('/api/developer/sso/clients');
  if (authorization) req.set('Authorization', authorization);
  return req.send(body);
};
const MEMBER = { id: 'user-dev-1', email: 'member@example.com', isOrganization: false, userType: 'regular', disabledAt: null };
const signedIn = (id = MEMBER.id, claims = { ver: 2 }) => `Bearer ${jwt.sign({ ...claims, id }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;
// protect's answer to a request without a token, as on every other /api route that requires a login.
const LOGIN_REQUIRED = { status: 'fail', message: 'Authentication required. Please login first.' };

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

/** Runs one request and reports its answer, how many database calls it made and whether the store changed. */
async function observe(send) {
  const before = storeSnapshot();
  const db = watchDatabase();
  let res;
  try {
    res = await send();
  } finally {
    db.restore();
  }
  return { res, dbCalls: db.calls, written: storeSnapshot() !== before };
}

const CLOSED_READ = { mode: 'off', open: false, allowedEmails: [], trustedVerifiers: [], problem: null, warnings: [] };
const GOOGLE = 'web3auth-google-sapphire-mainnet';
const EMAIL_OTP = 'web3auth-auth0-email-passwordless-sapphire-mainnet';
const X_LOGIN = 'web3auth-auth0-twitter-sapphire-mainnet';
const TRUSTED = `${GOOGLE},${EMAIL_OTP}`;

/** Boot with a capturing log; returns the warnings it wrote. */
function boot(env) {
  const warnings = [];
  const state = initDeveloperRegistration({ env, log: { warn: (...args) => warnings.push(args.join(' ')) } });
  return { state, warnings };
}

describe('SSO_DEVELOPER_REGISTRATION is read once, at boot', () => {
  after(() => initDeveloperRegistration({ env: {} }));

  it('is off when unset, blank or "off", on only for "on", allowlist only for "allowlist" (trimmed, any case)', () => {
    for (const value of [undefined, '', '   ', 'off', 'OFF', ' Off ']) {
      assert.deepEqual(readDeveloperRegistration({ SSO_DEVELOPER_REGISTRATION: value }), CLOSED_READ, String(value));
    }
    for (const value of ['on', 'ON', ' On ']) {
      assert.deepEqual(readDeveloperRegistration({ SSO_DEVELOPER_REGISTRATION: value }), { ...CLOSED_READ, mode: 'on', open: true }, value);
    }
    for (const value of ['allowlist', 'ALLOWLIST', ' Allowlist ']) {
      const state = readDeveloperRegistration({ SSO_DEVELOPER_REGISTRATION: value, SSO_DEVELOPER_ALLOWED_EMAILS: 'a@example.com' });
      assert.equal(state.mode, 'allowlist', value);
      assert.equal(state.open, false, 'allowlist is not "any signed-in account"');
      assert.equal(state.problem, null);
    }
  });

  it('refuses to start in production on any other value', () => {
    for (const value of ['true', 'yes', '1', 'open', 'enabled', 'of', 'on,off', 'allow-list', 'whitelist', 'allowlist,on']) {
      assert.throws(
        () => initDeveloperRegistration({ env: { NODE_ENV: 'production', SSO_DEVELOPER_REGISTRATION: value } }),
        /^Error: SSO_DEVELOPER_REGISTRATION must be "off", "on" or "allowlist" \(got ".*"\); refusing to start$/,
        value,
      );
    }
  });

  it('outside production, another value is one warning and reads as off', () => {
    const { state, warnings } = boot({ NODE_ENV: 'development', SSO_DEVELOPER_REGISTRATION: 'yes' });
    assert.equal(state.mode, 'off');
    assert.equal(state.open, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SSO_DEVELOPER_REGISTRATION must be "off", "on" or "allowlist" \(got "yes"\); reading it as "off"/);
  });

  it('a running process does not re-read the environment', async () => {
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'off' } });
    process.env.SSO_DEVELOPER_REGISTRATION = 'on';
    try {
      assert.equal(developerRegistrationOpen(), false);
      assert.equal(developerRegistrationMode(), 'off');
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

  it('the money-path boot line reports it next to publicClientRegistration: closed, open or allowlist:<count>', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    const line = src.slice(src.indexOf('Partner SSO money-path assertions OK'));
    assert.match(line, /publicClientRegistration=\$\{moneyPath\.publicRegistration \? 'open' : 'closed'\} ` \+\s+`developerRegistration=\$\{moneyPath\.developerRegistration\}`/);
    const summary = (env) => describeDeveloperRegistration(readDeveloperRegistration(env));
    assert.equal(summary({}), 'closed');
    assert.equal(summary({ SSO_DEVELOPER_REGISTRATION: 'off' }), 'closed');
    assert.equal(summary({ SSO_DEVELOPER_REGISTRATION: 'on' }), 'open');
    assert.equal(summary({ SSO_DEVELOPER_REGISTRATION: 'allowlist', SSO_DEVELOPER_ALLOWED_EMAILS: 'a@example.com, b@example.com' }), 'allowlist:2');
    assert.equal(summary({ SSO_DEVELOPER_REGISTRATION: 'allowlist' }), 'allowlist:0');
  });
});

describe('SSO_DEVELOPER_ALLOWED_EMAILS (allowlist mode), read at boot', () => {
  after(() => initDeveloperRegistration({ env: {} }));
  const allowlist = (emails, extra = {}) => ({
    SSO_DEVELOPER_REGISTRATION: 'allowlist',
    SSO_DEVELOPER_ALLOWED_EMAILS: emails,
    WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: TRUSTED,
    ...extra,
  });

  it('trims, lower-cases and de-duplicates the entries; blank entries are skipped', () => {
    const state = readDeveloperRegistration(allowlist('  Lead@DDC-TEAM.EXAMPLE , dev@tge.example.com,, LEAD@ddc-team.example ,'));
    assert.deepEqual(state.allowedEmails, ['lead@ddc-team.example', 'dev@tge.example.com']);
    assert.deepEqual(state.trustedVerifiers, [GOOGLE, EMAIL_OTP]);
    assert.equal(state.problem, null);
    assert.deepEqual(state.warnings, []);
  });

  it('external-wallet never counts as a connection that verifies an e-mail', () => {
    const state = readDeveloperRegistration(allowlist('a@example.com', { WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: `external-wallet, ${GOOGLE}` }));
    assert.deepEqual(state.trustedVerifiers, [GOOGLE]);
  });

  it('refuses to start in production on an entry that is not an e-mail address, naming positions, never addresses', () => {
    const cases = [
      ['lead@ddc-team.example,not-an-email', /entry #2 must be an e-mail address/],
      ['lead@ddc-team.example; dev@tge.example.com', /entry #1 must be an e-mail address/],
      ['lead@ddc-team.example dev@tge.example.com', /entry #1 must be an e-mail address/],
      ['a@@example.com,lead@ddc-team.example,b@example', /entries #1, #3 must be an e-mail address/],
      [`${'x'.repeat(250)}@example.com`, /entry #1 must be an e-mail address/],
    ];
    for (const [emails, pattern] of cases) {
      assert.throws(
        () => initDeveloperRegistration({ env: { NODE_ENV: 'production', ...allowlist(emails) } }),
        (error) => {
          assert.match(error.message, /^SSO_DEVELOPER_ALLOWED_EMAILS /);
          assert.match(error.message, pattern);
          assert.match(error.message, /; refusing to start$/);
          assert.equal(error.message.includes('ddc-team.example'), false, 'no address in the message');
          return true;
        },
        emails,
      );
    }
  });

  it('outside production, an unparsable list is one warning and reads as empty: closed', () => {
    const { state, warnings } = boot({ NODE_ENV: 'development', ...allowlist('lead@ddc-team.example,not-an-email') });
    assert.equal(state.mode, 'allowlist');
    assert.deepEqual(state.allowedEmails, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /entry #2 must be an e-mail address .*; reading the list as empty \(closed\)$/);
    assert.equal(warnings[0].includes('lead@ddc-team.example'), false);
  });

  it('an empty list starts, in production too, with one warning, and admits nobody', () => {
    for (const emails of [undefined, '', '  ', ' , ']) {
      const { state, warnings } = boot({ NODE_ENV: 'production', ...allowlist(emails) });
      assert.equal(state.mode, 'allowlist');
      assert.deepEqual(state.allowedEmails, []);
      assert.equal(warnings.length, 1, String(emails));
      assert.match(warnings[0], /empty SSO_DEVELOPER_ALLOWED_EMAILS: registration stays closed/);
    }
  });

  it('a list with no trusted login connection is one warning: nobody has a verified login e-mail', () => {
    const { state, warnings } = boot({ NODE_ENV: 'production', ...allowlist('lead@ddc-team.example', { WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: '' }) });
    assert.deepEqual(state.trustedVerifiers, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WEB3AUTH_EMAIL_TRUSTED_VERIFIERS names no login connection/);
  });

  it('the list is ignored, with one warning, unless the mode is allowlist: off and on are unchanged', () => {
    for (const mode of ['off', 'on']) {
      const { state, warnings } = boot({ NODE_ENV: 'production', SSO_DEVELOPER_REGISTRATION: mode, SSO_DEVELOPER_ALLOWED_EMAILS: 'lead@ddc-team.example' });
      assert.equal(state.mode, mode);
      assert.equal(state.open, mode === 'on');
      assert.deepEqual(state.allowedEmails, []);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], new RegExp(`SSO_DEVELOPER_ALLOWED_EMAILS is ignored unless SSO_DEVELOPER_REGISTRATION=allowlist \\(it is "${mode}"\\)`));
    }
    assert.deepEqual(boot({ SSO_DEVELOPER_REGISTRATION: 'on' }).warnings, [], 'no list, no warning');
  });

  it('a running process does not re-read the list', async () => {
    initDeveloperRegistration({ env: allowlist('someone@example.com') });
    const saved = { ...process.env };
    Object.assign(process.env, allowlist('lead@ddc-team.example'));
    try {
      const user = { email: 'lead@ddc-team.example', web3authVerifier: GOOGLE, web3authVerifierId: 'lead@ddc-team.example' };
      assert.deepEqual(registrationDecision(user, { ver: 2 }), { allowed: false, reason: 'not_listed' });
    } finally {
      for (const key of ['SSO_DEVELOPER_REGISTRATION', 'SSO_DEVELOPER_ALLOWED_EMAILS', 'WEB3AUTH_EMAIL_TRUSTED_VERIFIERS']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe('registrationDecision: who may register, from the account row and the verified JWT only', () => {
  const state = (mode, emails = 'lead@ddc-team.example') => readDeveloperRegistration({
    SSO_DEVELOPER_REGISTRATION: mode,
    SSO_DEVELOPER_ALLOWED_EMAILS: emails,
    WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: TRUSTED,
  });
  const lead = { email: 'lead@ddc-team.example', web3authVerifier: GOOGLE, web3authVerifierId: 'lead@ddc-team.example' };

  it('off refuses everyone, on admits every signed-in account', () => {
    assert.deepEqual(registrationDecision(lead, { ver: 2 }, state('off')), { allowed: false, reason: 'closed' });
    for (const user of [lead, { email: 'anyone@example.com' }, { email: 'pw@example.com', authType: 'traditional' }]) {
      assert.deepEqual(registrationDecision(user, {}, state('on')), { allowed: true });
    }
  });

  it('allowlist admits a listed account whose login e-mail is verified; e-mail compared trimmed and case-insensitively', () => {
    assert.deepEqual(registrationDecision(lead, { ver: 2 }, state('allowlist')), { allowed: true });
    const mixed = { email: ' Lead@DDC-TEAM.EXAMPLE ', web3authVerifier: EMAIL_OTP, web3authVerifierId: 'LEAD@ddc-team.example' };
    assert.deepEqual(registrationDecision(mixed, { ver: 2 }, state('allowlist', '  LEAD@DDC-TEAM.EXAMPLE ')), { allowed: true });
  });

  it('allowlist refuses an unlisted account, and an empty list refuses everyone', () => {
    const other = { email: 'other@example.com', web3authVerifier: GOOGLE, web3authVerifierId: 'other@example.com' };
    assert.deepEqual(registrationDecision(other, { ver: 2 }, state('allowlist')), { allowed: false, reason: 'not_listed' });
    assert.deepEqual(registrationDecision(lead, { ver: 2 }, state('allowlist', '')), { allowed: false, reason: 'not_listed' });
    assert.deepEqual(registrationDecision(null, { ver: 2 }, state('allowlist')), { allowed: false, reason: 'not_listed' });
  });

  it('allowlist refuses a listed e-mail that is not a verified login e-mail', () => {
    const cases = [
      // A password or legacy body-asserted session: no ver 2.
      [lead, {}, 'session_not_verified'],
      [lead, { ver: 1 }, 'session_not_verified'],
      [lead, null, 'session_not_verified'],
      // Linked to a connection that does not verify the address (X), or to none (password account).
      [{ ...lead, web3authVerifier: X_LOGIN }, { ver: 2 }, 'connection_not_trusted'],
      [{ ...lead, web3authVerifier: null, web3authVerifierId: null, authType: 'traditional' }, { ver: 2 }, 'connection_not_trusted'],
      // external-wallet carries an address in the e-mail column, whatever the trusted list says.
      [{ ...lead, web3authVerifier: 'external-wallet' }, { ver: 2 }, 'connection_not_trusted'],
      // A legacy row linked through the wallet its token proved: the column is not the proved identity.
      [{ ...lead, web3authVerifierId: 'someone.else@example.net' }, { ver: 2 }, 'email_not_login_identity'],
      [{ ...lead, web3authVerifierId: null }, { ver: 2 }, 'email_not_login_identity'],
    ];
    for (const [user, claims, reason] of cases) {
      assert.deepEqual(registrationDecision(user, claims, state('allowlist')), { allowed: false, reason }, JSON.stringify([user, claims]));
    }
    const trustingWallets = readDeveloperRegistration({
      SSO_DEVELOPER_REGISTRATION: 'allowlist',
      SSO_DEVELOPER_ALLOWED_EMAILS: 'lead@ddc-team.example',
      WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: `external-wallet,${GOOGLE}`,
    });
    assert.deepEqual(
      registrationDecision({ ...lead, web3authVerifier: 'external-wallet' }, { ver: 2 }, trustingWallets),
      { allowed: false, reason: 'connection_not_trusted' },
    );
  });
});

describe('registration closed (the default)', () => {
  beforeEach(async () => {
    prisma.reset();
    clearRateLimitStore();
    initDeveloperRegistration({ env: {} });
    await prisma.user.create({ data: { ...MEMBER } });
  });

  it('off + anonymous: 403 registration_closed, no database call, nothing written', async () => {
    const { res, dbCalls, written } = await observe(() => register(registration()));
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, CLOSED);
    assert.equal(dbCalls, 0, 'no database call at all');
    assert.equal(written, false, 'nothing written');
  });

  // A signed-in caller is looked up (`protect`, then its roles): the developer and ddc_admin roles
  // may register while registration is closed (test/unit/developerConsoleAdmin.test.js). An account
  // with neither gets the same 403 and nothing is written.
  it('off + signed-in without a role: 403 registration_closed as well, nothing written', async () => {
    const { res, written } = await observe(() => register(registration(), signedIn()));
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, CLOSED);
    assert.equal(written, false, 'nothing written');
  });

  it('answers every request the same way, before validation and the rate limiter', async () => {
    const bodies = [registration(), {}, registration({ redirect_uris: ['http://example.com/cb'] }), registration({ contact_email: 'x' })];
    const auths = [undefined, signedIn()];
    // Seven in a row: the per-IP limit is 5 an hour, so a 429 here would mean the limiter ran first.
    for (let i = 0; i < 7; i += 1) {
      const res = await register(bodies[i % bodies.length], auths[i % auths.length]);
      assert.equal(res.status, 403, `request ${i + 1}`);
      assert.deepEqual(res.body, CLOSED);
    }
    // A token that does not verify is the login check's 401, as on every other signed-in route.
    const bad = await register(registration(), 'Bearer not-a-jwt');
    assert.equal(bad.status, 401);
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

describe('registration open (SSO_DEVELOPER_REGISTRATION=on): a signed-in account is required', () => {
  beforeEach(async () => {
    prisma.reset();
    clearRateLimitStore();
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'on' } });
    await prisma.user.create({ data: { ...MEMBER } });
  });
  after(() => initDeveloperRegistration({ env: {} }));

  it('on + anonymous: 401 in the usual auth shape, no database call, nothing written', async () => {
    const { res, dbCalls, written } = await observe(() => register(registration()));
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, LOGIN_REQUIRED);
    assert.equal(dbCalls, 0);
    assert.equal(written, false, 'nothing written');
  });

  it('on + a token that does not verify: 401, nothing written', async () => {
    const forged = `Bearer ${jwt.sign({ id: MEMBER.id, ver: 2 }, 'not-the-server-key', { expiresIn: '5m' })}`;
    for (const authorization of [forged, 'Bearer not-a-jwt']) {
      const { res, written } = await observe(() => register(registration(), authorization));
      assert.equal(res.status, 401, authorization.slice(0, 20));
      assert.equal(res.body.status, 'fail');
      assert.equal(written, false, 'nothing written');
    }
  });

  it('on + a disabled account: 403 ACCOUNT_DISABLED, nothing written', async () => {
    await prisma.user.update({ where: { id: MEMBER.id }, data: { disabledAt: new Date('2026-10-01T00:00:00Z') } });
    const { res, written } = await observe(() => register(registration(), signedIn()));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ACCOUNT_DISABLED');
    assert.equal(written, false, 'nothing written');
  });

  it('on + signed-in: 201 as before, the secret once, only its hash stored', async () => {
    const res = await register(registration({ contact_email: 'Dev@Example.com', redirect_uris: [PARTNER_REDIRECT, PARTNER_REDIRECT] }), signedIn());
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
    // The client belongs to the account that registered it.
    assert.equal(row.ownerUserId, MEMBER.id);
    assert.equal(row.kind, 'developer');
  });

  it('the service records an owner only when the caller passes one', async () => {
    const { createDeveloperClient } = require('../../src/services/ssoDeveloperClient');
    const anonymous = await createDeveloperClient(registration());
    const owned = await createDeveloperClient(registration(), { ownerUserId: MEMBER.id });
    const rows = prisma.store.ssoDeveloperClient;
    assert.equal(rows.find((r) => r.clientId === anonymous.clientId).ownerUserId, null);
    assert.equal(rows.find((r) => r.clientId === owned.clientId).ownerUserId, MEMBER.id);
  });

  it('on + signed-in: validates and rate-limits as before', async () => {
    const bad = await register(registration({ redirect_uris: ['http://example.com/cb'] }), signedIn());
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_redirect_uri');
    for (let i = 0; i < 4; i += 1) assert.equal((await register(registration(), signedIn())).status, 201, `request ${i + 2}`);
    const limited = await register(registration(), signedIn());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'slow_down');
    assert.equal(prisma.store.ssoDeveloperClient.length, 4);
  });
});

describe('registration by allowlist (SSO_DEVELOPER_REGISTRATION=allowlist): listed accounts with a verified login e-mail', () => {
  const LEAD = {
    id: 'user-lead-1',
    email: 'Lead@DDC-Team.example',
    isOrganization: false,
    userType: 'regular',
    authType: 'web3auth',
    disabledAt: null,
    web3authVerifier: GOOGLE,
    web3authVerifierId: 'lead@ddc-team.example',
  };
  const PARTNER_DEV = { ...LEAD, id: 'user-tge-dev-1', email: 'dev@tge.example.com', web3authVerifier: EMAIL_OTP, web3authVerifierId: 'dev@tge.example.com' };
  // Signed in through a trusted connection, but not on the list.
  const OUTSIDER = { ...LEAD, id: 'user-outsider-1', email: 'outsider@example.com', web3authVerifierId: 'outsider@example.com' };
  // On the list, but the e-mail is not a verified login e-mail.
  const LISTED_X = { ...LEAD, id: 'user-listed-x', email: 'x-login@ddc-team.example', web3authVerifier: X_LOGIN, web3authVerifierId: 'twitter|123' };
  const LISTED_LEGACY = { ...LEAD, id: 'user-listed-legacy', email: 'legacy@ddc-team.example', web3authVerifierId: 'someone.else@example.net' };
  const LISTED_PASSWORD = {
    ...LEAD, id: 'user-listed-pw', email: 'pw@ddc-team.example', authType: 'traditional', web3authVerifier: null, web3authVerifierId: null,
  };
  const LISTED_WALLET = {
    ...LEAD, id: 'user-listed-wallet', email: '0x1111111111111111111111111111111111111111', web3authVerifier: 'external-wallet',
    web3authVerifierId: '0x1111111111111111111111111111111111111111',
  };
  const ALLOWED = ' lead@ddc-team.example , DEV@TGE.EXAMPLE.COM, x-login@ddc-team.example, legacy@ddc-team.example, pw@ddc-team.example';
  const allowlistEnv = (emails = ALLOWED) => ({
    SSO_DEVELOPER_REGISTRATION: 'allowlist',
    SSO_DEVELOPER_ALLOWED_EMAILS: emails,
    WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: `${TRUSTED},external-wallet`,
  });
  let refusals;
  let originalInfo;

  beforeEach(async () => {
    prisma.reset();
    clearRateLimitStore();
    initDeveloperRegistration({ env: allowlistEnv() });
    for (const user of [MEMBER, LEAD, PARTNER_DEV, OUTSIDER, LISTED_X, LISTED_LEGACY, LISTED_PASSWORD, LISTED_WALLET]) {
      await prisma.user.create({ data: { ...user } });
    }
    refusals = [];
    originalInfo = developerSsoRoutes.registrationLog.info;
    developerSsoRoutes.registrationLog.info = (event, entry) => refusals.push({ event, entry });
  });
  afterEach(() => {
    developerSsoRoutes.registrationLog.info = originalInfo;
  });
  after(() => initDeveloperRegistration({ env: {} }));

  it('the route checks the account after the login check and before the rate limiter', () => {
    const layer = developerSsoRoutes.stack.find((l) => l.route && l.route.path === '/clients' && l.route.methods.post);
    const names = layer.route.stack.map((l) => l.handle.name);
    assert.deepEqual(names.slice(0, 3), ['registrationOpen', 'protect', 'registrationAllowed']);
    assert.equal(layer.route.stack[3].handle, require('../../src/middlewares/rateLimitMiddleware').rateLimiters.developerClientCreate);
  });

  it('allowlist + anonymous: 401 in the usual auth shape, as with on; no database call, nothing written', async () => {
    const { res, dbCalls, written } = await observe(() => register(registration()));
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, LOGIN_REQUIRED);
    assert.equal(dbCalls, 0);
    assert.equal(written, false);
  });

  it('a listed account with a verified login e-mail registers a developer client (login scopes only), owned by it', async () => {
    for (const user of [LEAD, PARTNER_DEV]) {
      const res = await register(registration({ client_name: `Client of ${user.id}` }), signedIn(user.id));
      assert.equal(res.status, 201, `${user.id}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.client_secret, /^ddc_sso_secret_/);
      assert.deepEqual(res.body.scopes, ['sso:identity', 'sso:status', 'sso:email', 'sso:wallet']);
      const row = prisma.store.ssoDeveloperClient.find((r) => r.clientId === res.body.client_id);
      assert.equal(row.ownerUserId, user.id);
      assert.equal(row.kind, 'developer', 'never a partner row');
      assert.equal(row.secretHash, sha256Hex(res.body.client_secret));
    }
    assert.equal(prisma.store.ssoDeveloperClient.length, 2);
    assert.deepEqual(refusals, []);
  });

  it('an unlisted account gets exactly the off answer, nothing written; the body cannot name a listed address', async () => {
    for (const body of [registration(), registration({ contact_email: 'lead@ddc-team.example' }), { ...registration(), email: 'lead@ddc-team.example' }]) {
      const { res, written } = await observe(() => register(body, signedIn(OUTSIDER.id)));
      assert.equal(res.status, 403);
      assert.deepEqual(res.body, CLOSED, 'the same body as off');
      assert.equal(written, false, 'nothing written');
    }
    const member = await register(registration(), signedIn(MEMBER.id));
    assert.deepEqual([member.status, member.body], [403, CLOSED]);
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('a listed e-mail that is not a verified login e-mail gets the same answer, nothing written', async () => {
    const cases = [
      [LEAD.id, {}, 'session_not_verified'],
      [LISTED_X.id, { ver: 2 }, 'connection_not_trusted'],
      [LISTED_PASSWORD.id, { ver: 2 }, 'connection_not_trusted'],
      // An external-wallet account's e-mail column holds its address, which no list entry can match.
      [LISTED_WALLET.id, { ver: 2 }, 'not_listed'],
      [LISTED_LEGACY.id, { ver: 2 }, 'email_not_login_identity'],
    ];
    for (const [userId, claims, reason] of cases) {
      refusals = [];
      const { res, written } = await observe(() => register(registration(), signedIn(userId, claims)));
      assert.equal(res.status, 403, userId);
      assert.deepEqual(res.body, CLOSED, userId);
      assert.equal(written, false, `${userId}: nothing written`);
      assert.equal(refusals.length, 1, userId);
      assert.equal(refusals[0].event, 'developer_registration.refused');
      assert.equal(refusals[0].entry.userId, userId);
      assert.equal(refusals[0].entry.reason, reason, userId);
      assert.equal(JSON.stringify(refusals[0]).includes('@'), false, 'the log line carries no e-mail');
    }
    assert.equal(prisma.store.ssoDeveloperClient.length, 0);
  });

  it('a disabled listed account: 403 ACCOUNT_DISABLED from the login check, nothing written', async () => {
    await prisma.user.update({ where: { id: LEAD.id }, data: { disabledAt: new Date('2026-10-01T00:00:00Z') } });
    const { res, written } = await observe(() => register(registration(), signedIn(LEAD.id)));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ACCOUNT_DISABLED');
    assert.equal(written, false);
  });

  it('refused accounts do not use up the per-IP limit; a listed account is validated and limited as with on', async () => {
    for (let i = 0; i < 7; i += 1) {
      const res = await register(registration(), signedIn(OUTSIDER.id));
      assert.equal(res.status, 403, `refusal ${i + 1}`);
      assert.deepEqual(res.body, CLOSED);
    }
    const bad = await register(registration({ redirect_uris: ['http://example.com/cb'] }), signedIn(LEAD.id));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_redirect_uri');
    for (let i = 0; i < 4; i += 1) assert.equal((await register(registration(), signedIn(LEAD.id))).status, 201, `request ${i + 2}`);
    const limited = await register(registration(), signedIn(LEAD.id));
    assert.equal(limited.status, 429);
    // Past the limit, a refused account still gets the off answer, not a 429.
    const outsider = await register(registration(), signedIn(OUTSIDER.id));
    assert.deepEqual([outsider.status, outsider.body], [403, CLOSED]);
    assert.equal(prisma.store.ssoDeveloperClient.length, 4);
  });

  it('an empty list admits nobody: the listed-looking account gets the off answer', async () => {
    initDeveloperRegistration({ env: allowlistEnv(''), log: { warn: () => {} } });
    const { res, written } = await observe(() => register(registration(), signedIn(LEAD.id)));
    assert.deepEqual([res.status, res.body], [403, CLOSED]);
    assert.equal(written, false);
  });

  it('on is unchanged: an account the allowlist would refuse registers', async () => {
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'on' } });
    const res = await register(registration(), signedIn(LISTED_PASSWORD.id, {}));
    assert.equal(res.status, 201);
    assert.deepEqual(refusals, []);
  });

  // A signed-in caller is looked up while off (`protect`, then its roles): the developer and
  // ddc_admin roles may register (test/unit/developerConsoleAdmin.test.js). The list itself admits
  // nobody while off.
  it('off is unchanged for the list: a listed account with a verified login e-mail and no role gets 403, nothing written', async () => {
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'off', SSO_DEVELOPER_ALLOWED_EMAILS: ALLOWED }, log: { warn: () => {} } });
    const { res, written } = await observe(() => register(registration(), signedIn(LEAD.id)));
    assert.deepEqual([res.status, res.body], [403, CLOSED]);
    assert.equal(written, false);
    assert.deepEqual(refusals.map((r) => [r.entry.userId, r.entry.reason]), [[LEAD.id, 'closed']]);
  });

  it('off + no token: 403 before any database call, as before', async () => {
    initDeveloperRegistration({ env: { SSO_DEVELOPER_REGISTRATION: 'off', SSO_DEVELOPER_ALLOWED_EMAILS: ALLOWED }, log: { warn: () => {} } });
    const { res, dbCalls, written } = await observe(() => register(registration()));
    assert.deepEqual([res.status, res.body], [403, CLOSED]);
    assert.equal(dbCalls, 0);
    assert.equal(written, false);
    assert.deepEqual(refusals, []);
  });
});
