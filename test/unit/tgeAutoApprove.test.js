/**
 * SSO_TGE_AUTO_APPROVE: the Wallet may post the TGE consent's Allow without a tap.
 *
 * Contract under test:
 *   - the switch reads off (default, unset, unknown) | app | app,web, per call;
 *   - GET /api/oauth/requests/:id carries autoApprove { app, web }, true only for the configured
 *     TGE client and only for an entry type the switch allows — never decided inside GET;
 *   - POST /api/oauth/consent { auto: true } requires allow=true, takes its entry type from the
 *     credential (App hand-off SSO session → app, DataDance JWT → web), is 403
 *     AUTO_APPROVE_NOT_ALLOWED unless the switch allows it, and otherwise runs the manual-Allow
 *     path unchanged (initiator cookie, single use, verified session, PKCE at /oauth/token);
 *   - one info line `oauth.consent_auto_approved` per auto-approval, without any token;
 *   - manual allow / deny answer exactly as before.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

// Capture every logger the routes/services create, whatever LOG_LEVEL says, so the audit line
// can be asserted on. Installed before any module under test is required.
const loggerModule = require('../../src/utils/logger');
const captured = [];
const realCreateLogger = loggerModule.createLogger;
loggerModule.createLogger = (moduleName) => {
  const instance = realCreateLogger(moduleName);
  for (const level of ['info', 'warn', 'error']) {
    const original = instance[level].bind(instance);
    instance[level] = (message, meta) => {
      captured.push({ module: moduleName, level, message, meta });
      return original(message, meta);
    };
  }
  return instance;
};

const SECRET = 'tge-secret-dev';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const REDIRECT = 'https://tge.example.com/oauth/callback';
const MCP_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ISSUER = 'https://api.test.local';
const JWT_SECRET = 'ddc-user-session-secret';

Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_NAME: 'DDC TGE',
  SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  SSO_TGE_INITIATE_LOGIN_URI: 'https://tge.example.com/login/ddc',
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET,
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
delete process.env.SSO_TGE_AUTO_APPROVE;

const ssoRoutes = require('../../src/routes/ssoRoutes');
const oauthRoutes = require('../../src/routes/oauthRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { parseAutoApprove, autoApproveFor, assertPartnerConfig } = require('../../src/constants/partnerClient');
const { decideConsent } = require('../../src/services/oauthService');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/sso', ssoRoutes);
app.use('/', oauthRoutes);

let server;
before(async () => {
  server = await listenLoopback(app);
});
after(() => new Promise((resolve) => server.close(resolve)));

const cUser = {
  id: 'user-auto-1',
  email: 'auto@example.com',
  isOrganization: false,
  userType: 'regular',
  web3authVerifier: 'web3auth',
  disabledAt: null,
};

function userJwt(extra = { ver: 2 }) {
  return jwt.sign({ id: cUser.id, ...extra }, JWT_SECRET, { expiresIn: '1h' });
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** Browser step: start an authorization; returns the request id, its cookie and PKCE verifier. */
async function authorize({ clientId = 'tge-test', redirectUri = REDIRECT, scope } = {}) {
  const { verifier, challenge } = pkce();
  const query = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'state-with-enough-entropy-1234',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  if (scope) query.scope = scope;
  const res = await request(server).get('/oauth/authorize').query(query);
  assert.equal(res.status, 302, res.text);
  const cookie = ((res.headers['set-cookie'] || [])[0] || '').split(';')[0];
  return { requestId: new URL(res.headers.location).searchParams.get('request'), cookie, verifier };
}

/** App hand-off: a consent-only SSO session (`ddc_sso_…`) for the TGE client. */
async function appSession() {
  const minted = await request(server).post('/api/sso/app-ticket').set('Authorization', `Bearer ${userJwt()}`).send({ client_id: 'tge-test' });
  assert.equal(minted.status, 200, minted.text);
  const redeemed = await request(server).post('/api/sso/ticket/exchange').send({ ticket: minted.body.data.ticket });
  assert.equal(redeemed.status, 200, redeemed.text);
  return redeemed.body.data.session_token;
}

async function credential(entry) {
  return entry === 'app' ? appSession() : userJwt();
}

function consent(token, cookie, body) {
  const call = request(server).post('/api/oauth/consent');
  if (token) call.set('Authorization', `Bearer ${token}`);
  if (cookie) call.set('Cookie', cookie);
  return call.send(body);
}

function requestSummary(id) {
  return request(server).get(`/api/oauth/requests/${id}`);
}

function authzRow(id) {
  return prisma.store.oAuthAuthorization.find((row) => row.id === id);
}

function setSwitch(value) {
  if (value === undefined) delete process.env.SSO_TGE_AUTO_APPROVE;
  else process.env.SSO_TGE_AUTO_APPROVE = value;
}

const TOGGLES = ['SSO_TGE_AUTO_APPROVE', 'SSO_REQUIRE_VERIFIED_SESSION'];
const saved = {};

beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  captured.length = 0;
  TOGGLES.forEach((key) => {
    saved[key] = process.env[key];
  });
  await prisma.user.create({ data: cUser });
  await prisma.oAuthClient.create({
    data: { clientId: 'ddc_oauth_mcp1', clientName: 'Claude', redirectUris: [MCP_REDIRECT], tokenEndpointAuthMethod: 'none', clientUri: '' },
  });
});

afterEach(() => {
  TOGGLES.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  });
});

describe('SSO_TGE_AUTO_APPROVE parsing', () => {
  const OFF = { app: false, web: false };
  for (const [value, expected] of [
    [undefined, OFF],
    ['', OFF],
    ['off', OFF],
    ['OFF', OFF],
    ['app', { app: true, web: false }],
    [' App ', { app: true, web: false }],
    ['app,web', { app: true, web: true }],
    ['web,app', { app: true, web: true }],
    ['app, web', { app: true, web: true }],
    ['web', OFF],
    ['true', OFF],
    ['on', OFF],
    ['app,web,other', OFF],
    ['yes', OFF],
  ]) {
    it(`${JSON.stringify(value)} → ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(parseAutoApprove(value), expected);
    });
  }

  it('is read per call and applies only to the configured TGE client', () => {
    setSwitch('app,web');
    assert.deepEqual(autoApproveFor('tge-test'), { app: true, web: true });
    assert.deepEqual(autoApproveFor('ddc_oauth_mcp1'), { app: false, web: false });
    assert.deepEqual(autoApproveFor(null), { app: false, web: false });
    setSwitch('app');
    assert.deepEqual(autoApproveFor('tge-test'), { app: true, web: false });
    setSwitch(undefined);
    assert.deepEqual(autoApproveFor('tge-test'), { app: false, web: false });
  });

  it('shows up in the secret-free boot summary as the canonical value', () => {
    setSwitch('web,app');
    assert.equal(assertPartnerConfig().autoApprove, 'app,web');
    setSwitch('nonsense');
    assert.equal(assertPartnerConfig().autoApprove, 'off');
  });
});

describe('GET /api/oauth/requests/:id autoApprove flags', () => {
  for (const [value, expected] of [
    [undefined, { app: false, web: false }],
    ['off', { app: false, web: false }],
    ['bogus', { app: false, web: false }],
    ['app', { app: true, web: false }],
    ['app,web', { app: true, web: true }],
  ]) {
    it(`TGE client, switch ${JSON.stringify(value)} → ${JSON.stringify(expected)}`, async () => {
      setSwitch(value);
      const { requestId } = await authorize();
      const res = await requestSummary(requestId);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.body.data.autoApprove, expected);
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  }

  it('is never true for another client, whatever the switch says', async () => {
    setSwitch('app,web');
    const { requestId } = await authorize({ clientId: 'ddc_oauth_mcp1', redirectUri: MCP_REDIRECT });
    const res = await requestSummary(requestId);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.kind, 'assistant');
    assert.deepEqual(res.body.data.autoApprove, { app: false, web: false });
  });

  it('decides nothing: the request stays undecided and no code exists after the GET', async () => {
    setSwitch('app,web');
    const { requestId } = await authorize();
    await requestSummary(requestId);
    const row = authzRow(requestId);
    assert.equal(row.codeHash ?? null, null);
    assert.equal(row.consumedAt ?? null, null);
    assert.equal(row.userId ?? null, null);
  });
});

describe('POST /api/oauth/consent { auto: true } — switch × entry type', () => {
  const allowed = { off: [], app: ['app'], 'app,web': ['app', 'web'] };
  for (const value of [undefined, 'off', 'bogus', 'app', 'app,web']) {
    for (const entry of ['app', 'web']) {
      const expectAllowed = (allowed[value] || []).includes(entry);
      it(`switch ${JSON.stringify(value)}, ${entry} entry → ${expectAllowed ? 'code minted' : '403 AUTO_APPROVE_NOT_ALLOWED'}`, async () => {
        setSwitch(value);
        const { requestId, cookie } = await authorize();
        const token = await credential(entry);
        const res = await consent(token, cookie, { requestId, allow: true, auto: true });
        const row = authzRow(requestId);
        if (expectAllowed) {
          assert.equal(res.status, 200, res.text);
          const redirect = new URL(res.body.data.redirectTo);
          assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
          assert.match(redirect.searchParams.get('code'), /^ddc_code_/);
          assert.ok(row.codeHash, 'a code was minted');
        } else {
          assert.equal(res.status, 403, res.text);
          assert.equal(res.body.code, 'AUTO_APPROVE_NOT_ALLOWED');
          assert.equal(res.body.data.entry, entry);
          assert.equal(res.headers['cache-control'], 'no-store');
          assert.equal(row.codeHash ?? null, null, 'no code');
          assert.equal(row.consumedAt ?? null, null, 'the request is still decidable by hand');
        }
      });
    }
  }

  it('a refused auto leaves the request for a manual Allow, which then succeeds', async () => {
    setSwitch('app');
    const { requestId, cookie } = await authorize();
    const refused = await consent(userJwt(), cookie, { requestId, allow: true, auto: true });
    assert.equal(refused.status, 403);
    const manual = await consent(userJwt(), cookie, { requestId, allow: true });
    assert.equal(manual.status, 200, manual.text);
    assert.match(new URL(manual.body.data.redirectTo).searchParams.get('code'), /^ddc_code_/);
  });

  it('another client is 403 even with app,web and a valid JWT', async () => {
    setSwitch('app,web');
    const { requestId, cookie } = await authorize({ clientId: 'ddc_oauth_mcp1', redirectUri: MCP_REDIRECT });
    const res = await consent(userJwt(), cookie, { requestId, allow: true, auto: true });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.code, 'AUTO_APPROVE_NOT_ALLOWED');
    assert.equal(authzRow(requestId).codeHash ?? null, null);
  });

  it('accepts the form-encoded "true" like allow does', async () => {
    setSwitch('app,web');
    const { requestId, cookie } = await authorize();
    const res = await request(server)
      .post('/api/oauth/consent')
      .set('Authorization', `Bearer ${userJwt()}`)
      .set('Cookie', cookie)
      .type('form')
      .send({ requestId, allow: 'true', auto: 'true' });
    assert.equal(res.status, 200, res.text);
  });
});

describe('POST /api/oauth/consent { auto: true } — malformed', () => {
  for (const allow of [false, 'false', 'no']) {
    it(`auto with allow=${JSON.stringify(allow)} → 400, nothing consumed`, async () => {
      setSwitch('app,web');
      const { requestId, cookie } = await authorize();
      const res = await consent(userJwt(), cookie, { requestId, allow, auto: true });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.body.error, 'invalid_request');
      assert.match(res.body.error_description, /auto requires allow=true/);
      const row = authzRow(requestId);
      assert.equal(row.consumedAt ?? null, null);
      assert.equal(row.codeHash ?? null, null);
    });
  }

  it('auto without allow is the ordinary missing-allow 400', async () => {
    setSwitch('app,web');
    const { requestId, cookie } = await authorize();
    const res = await consent(userJwt(), cookie, { requestId, auto: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error_description, /allow must be true or false/);
  });

  for (const auto of ['yes', 1, 'TRUE', {}]) {
    it(`auto=${JSON.stringify(auto)} is not guessed at → 400`, async () => {
      setSwitch('app,web');
      const { requestId, cookie } = await authorize();
      const res = await consent(userJwt(), cookie, { requestId, allow: true, auto });
      assert.equal(res.status, 400, res.text);
      assert.match(res.body.error_description, /auto must be true or false/);
      assert.equal(authzRow(requestId).codeHash ?? null, null);
    });
  }

  it('the service refuses auto with a denial too (defence in depth)', async () => {
    await assert.rejects(decideConsent(cUser, 'any-request', false, { kind: 'user_jwt', auto: true }), {
      statusCode: 400,
      error: 'invalid_request',
    });
  });
});

describe('auto-approval runs the manual Allow path unchanged', () => {
  for (const entry of ['app', 'web']) {
    it(`${entry} entry: a missing initiator cookie is still 409 AUTHZ_INITIATOR_MISMATCH`, async () => {
      setSwitch('app,web');
      const { requestId } = await authorize();
      const res = await consent(await credential(entry), null, { requestId, allow: true, auto: true });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body.code, 'AUTHZ_INITIATOR_MISMATCH');
      assert.equal(res.body.data.reason, 'missing');
      assert.equal(authzRow(requestId).codeHash ?? null, null);
    });

    it(`${entry} entry: another browser's cookie is still 409 (mismatch)`, async () => {
      setSwitch('app,web');
      const { requestId } = await authorize();
      const other = `__Host-ddc_authz=${crypto.randomBytes(32).toString('base64url')}`;
      const res = await consent(await credential(entry), other, { requestId, allow: true, auto: true });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body.data.reason, 'mismatch');
      assert.equal(authzRow(requestId).codeHash ?? null, null);
    });
  }

  it('is single use: a second auto (or manual) Allow on the same request mints nothing', async () => {
    setSwitch('app,web');
    const { requestId, cookie } = await authorize();
    const first = await consent(userJwt(), cookie, { requestId, allow: true, auto: true });
    assert.equal(first.status, 200, first.text);
    const again = await consent(userJwt(), cookie, { requestId, allow: true, auto: true });
    const manual = await consent(userJwt(), cookie, { requestId, allow: true });
    for (const res of [again, manual]) {
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_request');
    }
  });

  it('still requires a verified login when SSO_REQUIRE_VERIFIED_SESSION=true', async () => {
    setSwitch('app,web');
    process.env.SSO_REQUIRE_VERIFIED_SESSION = 'true';
    const { requestId, cookie } = await authorize();
    const res = await consent(userJwt({}), cookie, { requestId, allow: true, auto: true });
    assert.equal(res.status, 200, res.text);
    const redirect = new URL(res.body.data.redirectTo);
    assert.equal(redirect.searchParams.get('error'), 'login_required');
    assert.equal(redirect.searchParams.get('code'), null);
  });

  it('an SSO session still answers only for its own client (403 access_denied before the auto gate)', async () => {
    setSwitch('app,web');
    const { requestId, cookie } = await authorize({ clientId: 'ddc_oauth_mcp1', redirectUri: MCP_REDIRECT });
    const res = await consent(await appSession(), cookie, { requestId, allow: true, auto: true });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.error, 'access_denied');
  });

  it('the auto-approved code still needs the PKCE verifier and the client secret at /oauth/token', async () => {
    setSwitch('app,web');
    const { requestId, cookie } = await authorize();
    const res = await consent(await appSession(), cookie, { requestId, allow: true, auto: true });
    assert.equal(res.status, 200, res.text);
    const code = new URL(res.body.data.redirectTo).searchParams.get('code');
    const exchange = (codeVerifier) =>
      request(server)
        .post('/oauth/token')
        .auth('tge-test', SECRET)
        .type('form')
        .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: codeVerifier });
    const wrong = await exchange(pkce().verifier);
    assert.equal(wrong.status, 400, wrong.text);
    assert.equal(wrong.body.error, 'invalid_grant');
  });

  it('with the right verifier the auto-approved code redeems like any other', async () => {
    setSwitch('app,web');
    const { requestId, cookie, verifier } = await authorize();
    const res = await consent(await appSession(), cookie, { requestId, allow: true, auto: true });
    const code = new URL(res.body.data.redirectTo).searchParams.get('code');
    const token = await request(server)
      .post('/oauth/token')
      .auth('tge-test', SECRET)
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(token.status, 200, token.text);
    assert.match(token.body.access_token, /^ddc_sso_/);
  });
});

describe('audit line oauth.consent_auto_approved', () => {
  for (const entry of ['app', 'web']) {
    it(`${entry} entry: one info line with client, entry, scopes, request and user — no token`, async () => {
      setSwitch('app,web');
      const { requestId, cookie } = await authorize({ scope: 'tge:identity tge:email' });
      const token = await credential(entry);
      captured.length = 0;
      const res = await consent(token, cookie, { requestId, allow: true, auto: true });
      assert.equal(res.status, 200, res.text);
      const lines = captured.filter((line) => line.message === 'oauth.consent_auto_approved');
      assert.equal(lines.length, 1);
      assert.equal(lines[0].level, 'info');
      assert.deepEqual(lines[0].meta, {
        clientId: 'tge-test',
        entry,
        scopes: 'sso:identity sso:email',
        requestId,
        userId: cUser.id,
      });
      const code = new URL(res.body.data.redirectTo).searchParams.get('code');
      const everything = JSON.stringify(captured);
      for (const secret of [code, token, token.replace(/^ddc_sso_/, ''), cookie.split('=')[1]]) {
        assert.equal(everything.includes(secret), false, 'no credential in any log line');
      }
    });
  }

  it('is not written for a manual Allow, a refused auto, or an auto that ends in an error redirect', async () => {
    setSwitch('app');
    const manual = await authorize();
    assert.equal((await consent(userJwt(), manual.cookie, { requestId: manual.requestId, allow: true })).status, 200);
    const refused = await authorize();
    assert.equal((await consent(userJwt(), refused.cookie, { requestId: refused.requestId, allow: true, auto: true })).status, 403);
    setSwitch('app,web');
    process.env.SSO_REQUIRE_VERIFIED_SESSION = 'true';
    const unverified = await authorize();
    assert.equal((await consent(userJwt({}), unverified.cookie, { requestId: unverified.requestId, allow: true, auto: true })).status, 200);
    assert.equal(captured.filter((line) => line.message === 'oauth.consent_auto_approved').length, 0);
  });
});

describe('manual allow / deny are unchanged', () => {
  for (const value of [undefined, 'app,web']) {
    it(`switch ${JSON.stringify(value)}: manual Allow → 200 { status, data: { redirectTo } } with code, state, iss`, async () => {
      setSwitch(value);
      const { requestId, cookie } = await authorize();
      const res = await consent(userJwt(), cookie, { requestId, allow: true });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(Object.keys(res.body), ['status', 'data']);
      assert.deepEqual(Object.keys(res.body.data), ['redirectTo']);
      const redirect = new URL(res.body.data.redirectTo);
      assert.deepEqual([...redirect.searchParams.keys()], ['code', 'state', 'iss']);
      assert.equal(redirect.searchParams.get('iss'), ISSUER);
    });

    it(`switch ${JSON.stringify(value)}: manual Deny → access_denied redirect from any browser`, async () => {
      setSwitch(value);
      const { requestId } = await authorize();
      const res = await consent(userJwt(), null, { requestId, allow: false });
      assert.equal(res.status, 200, res.text);
      const redirect = new URL(res.body.data.redirectTo);
      assert.deepEqual([...redirect.searchParams.keys()], ['error', 'state', 'iss']);
      assert.equal(redirect.searchParams.get('error'), 'access_denied');
      assert.ok(authzRow(requestId).consumedAt);
    });
  }

  it('an explicit auto:false is a manual decision (no gate, no audit line)', async () => {
    setSwitch(undefined);
    const { requestId, cookie } = await authorize({ clientId: 'ddc_oauth_mcp1', redirectUri: MCP_REDIRECT });
    const res = await consent(userJwt(), cookie, { requestId, allow: true, auto: false });
    assert.equal(res.status, 200, res.text);
    assert.match(new URL(res.body.data.redirectTo).searchParams.get('code'), /^ddc_code_/);
    assert.equal(captured.filter((line) => line.message === 'oauth.consent_auto_approved').length, 0);
  });

  it('a manual Allow without the initiator cookie is still 409', async () => {
    const { requestId } = await authorize();
    const res = await consent(userJwt(), null, { requestId, allow: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'AUTHZ_INITIATOR_MISMATCH');
  });
});
