/**
 * POST /oauth/consent: the consent decision as a top-level form submission.
 *
 * Contract under test:
 *   - GET /api/oauth/requests/:id says `decisionForm: true`;
 *   - the form (application/x-www-form-urlencoded: requestId, allow, auto, access_token) from an
 *     allowed web origin decides exactly like POST /api/oauth/consent and answers 303 to the URL
 *     that endpoint returns as `redirectTo` (code, or the client's error), no-store, no-referrer;
 *   - the `__Host-ddc_authz` initiator check, single use, the auto-approve gate, the SSO session's
 *     client binding and the limiter are the JSON endpoint's;
 *   - a missing or foreign Origin, another body type, a missing / invalid / doubled credential
 *     decide nothing and answer a short HTML page (never JSON, never a redirect);
 *   - the code minted through the form redeems at /oauth/token like any other.
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

const SECRET = 'tge-secret-dev';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const REDIRECT = 'https://tge.example.com/oauth/callback';
const MCP_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ISSUER = 'https://api.test.local';
const WEB = 'https://app.test.local';
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
  APP_PUBLIC_URL: WEB,
  JWT_SECRET,
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
delete process.env.SSO_TGE_AUTO_APPROVE;
delete process.env.FRONTEND_URL;

const ssoRoutes = require('../../src/routes/ssoRoutes');
const oauthRoutes = require('../../src/routes/oauthRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

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
  id: 'user-form-1',
  email: 'form@example.com',
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

async function authorize({ clientId = 'tge-test', redirectUri = REDIRECT } = {}) {
  const { verifier, challenge } = pkce();
  const res = await request(server).get('/oauth/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'state-with-enough-entropy-1234',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  assert.equal(res.status, 302, res.text);
  const cookie = ((res.headers['set-cookie'] || [])[0] || '').split(';')[0];
  return { requestId: new URL(res.headers.location).searchParams.get('request'), cookie, verifier };
}

async function appSession() {
  const minted = await request(server).post('/api/sso/app-ticket').set('Authorization', `Bearer ${userJwt()}`).send({ client_id: 'tge-test' });
  assert.equal(minted.status, 200, minted.text);
  const redeemed = await request(server).post('/api/sso/ticket/exchange').send({ ticket: minted.body.data.ticket });
  assert.equal(redeemed.status, 200, redeemed.text);
  return redeemed.body.data.session_token;
}

/** What the consent page's form sends: a urlencoded body, the page's Origin, the browser's cookie. */
function submitForm(fields, { cookie, origin = WEB, type = 'form', authorization } = {}) {
  const call = request(server).post('/oauth/consent').redirects(0);
  if (origin !== null) call.set('Origin', origin);
  if (cookie) call.set('Cookie', cookie);
  if (authorization) call.set('Authorization', authorization);
  return call.type(type).send(fields);
}

function consentJson(token, cookie, body) {
  const call = request(server).post('/api/oauth/consent');
  if (token) call.set('Authorization', `Bearer ${token}`);
  if (cookie) call.set('Cookie', cookie);
  return call.send(body);
}

function authzRow(id) {
  return prisma.store.oAuthAuthorization.find((row) => row.id === id);
}

function assertUndecided(requestId) {
  const row = authzRow(requestId);
  assert.equal(row.codeHash ?? null, null, 'no code');
  assert.equal(row.consumedAt ?? null, null, 'the request is still decidable');
}

/** A refusal: an HTML page with the router's page headers, never JSON and never a redirect. */
function assertPage(res, status, pattern) {
  assert.equal(res.status, status, res.text);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.equal(res.headers.location, undefined);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(res.text, /<h1>Sign-in was not completed<\/h1>/);
  if (pattern) assert.match(res.text, pattern);
}

const saved = {};
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  for (const key of ['SSO_TGE_AUTO_APPROVE', 'FRONTEND_URL']) saved[key] = process.env[key];
  await prisma.user.create({ data: cUser });
  await prisma.oAuthClient.create({
    data: { clientId: 'ddc_oauth_mcp1', clientName: 'Claude <b>x</b>', redirectUris: [MCP_REDIRECT], tokenEndpointAuthMethod: 'none', clientUri: '' },
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GET /api/oauth/requests/:id', () => {
  it('says the API takes the decision as a form (decisionForm: true)', async () => {
    const { requestId } = await authorize();
    const res = await request(server).get(`/api/oauth/requests/${requestId}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.decisionForm, true);
  });
});

describe('POST /oauth/consent decides like POST /api/oauth/consent', () => {
  it('Allow with the initiator cookie → 303 to the client with code, state, iss; no-store, no-referrer', async () => {
    const { requestId, cookie, verifier } = await authorize();
    const res = await submitForm({ requestId, allow: 'true', access_token: userJwt() }, { cookie });
    assert.equal(res.status, 303, res.text);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    const redirect = new URL(res.headers.location);
    assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
    assert.deepEqual([...redirect.searchParams.keys()], ['code', 'state', 'iss']);
    assert.equal(redirect.searchParams.get('iss'), ISSUER);
    assert.equal(redirect.searchParams.get('state'), 'state-with-enough-entropy-1234');
    const row = authzRow(requestId);
    assert.ok(row.codeHash, 'a code was minted');
    assert.equal(row.userId, cUser.id);

    const token = await request(server)
      .post('/oauth/token')
      .auth('tge-test', SECRET)
      .type('form')
      .send({ grant_type: 'authorization_code', code: redirect.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(token.status, 200, token.text);
    assert.match(token.body.access_token, /^ddc_sso_/);
  });

  it('Deny → 303 with error=access_denied, from any browser (no cookie needed)', async () => {
    const { requestId } = await authorize();
    const res = await submitForm({ requestId, allow: 'false', access_token: userJwt() });
    assert.equal(res.status, 303, res.text);
    const redirect = new URL(res.headers.location);
    assert.deepEqual([...redirect.searchParams.keys()], ['error', 'state', 'iss']);
    assert.equal(redirect.searchParams.get('error'), 'access_denied');
    assert.ok(authzRow(requestId).consumedAt);
  });

  it('the App hand-off SSO session works as access_token (auto Allow with the switch on app)', async () => {
    process.env.SSO_TGE_AUTO_APPROVE = 'app';
    const { requestId, cookie } = await authorize();
    const res = await submitForm({ requestId, allow: 'true', auto: 'true', access_token: await appSession() }, { cookie });
    assert.equal(res.status, 303, res.text);
    assert.match(new URL(res.headers.location).searchParams.get('code'), /^ddc_code_/);
  });

  it('an assistant (MCP) request is decided too', async () => {
    const { requestId, cookie } = await authorize({ clientId: 'ddc_oauth_mcp1', redirectUri: MCP_REDIRECT });
    const res = await submitForm({ requestId, allow: 'true', access_token: userJwt() }, { cookie });
    assert.equal(res.status, 303, res.text);
    const redirect = new URL(res.headers.location);
    assert.equal(`${redirect.origin}${redirect.pathname}`, MCP_REDIRECT);
    assert.match(redirect.searchParams.get('code'), /^ddc_code_/);
  });

  it('an origin named in FRONTEND_URL may submit it', async () => {
    process.env.FRONTEND_URL = 'https://wallet.example.org';
    const { requestId, cookie } = await authorize();
    const res = await submitForm({ requestId, allow: 'true', access_token: userJwt() }, { cookie, origin: 'https://wallet.example.org' });
    assert.equal(res.status, 303, res.text);
  });
});

describe('the initiator binding, single use and the auto gate hold on the form', () => {
  it('Allow without the initiator cookie → 409 page, no code', async () => {
    const { requestId } = await authorize();
    const res = await submitForm({ requestId, allow: 'true', access_token: userJwt() });
    assertPage(res, 409, /started on another device or browser\. Start again from DDC TGE\./);
    assertUndecided(requestId);
    assert.equal(authzRow(requestId).initiatorMismatchCount, 1);
  });

  it("Allow with another browser's cookie → 409 page, no code", async () => {
    const { requestId } = await authorize();
    const other = `__Host-ddc_authz=${crypto.randomBytes(32).toString('base64url')}`;
    const res = await submitForm({ requestId, allow: 'true', access_token: userJwt() }, { cookie: other });
    assertPage(res, 409, /started on another device or browser/);
    assertUndecided(requestId);
  });

  it('the client name on the page is escaped', async () => {
    const { requestId } = await authorize({ clientId: 'ddc_oauth_mcp1', redirectUri: MCP_REDIRECT });
    const res = await submitForm({ requestId, allow: 'true', access_token: userJwt() });
    assertPage(res, 409, /Start again from Claude &lt;b&gt;x&lt;\/b&gt;\./);
    assert.equal(res.text.includes('<b>x</b>'), false);
  });

  it('one decision per request: the form after the JSON Allow, and the JSON after the form', async () => {
    const first = await authorize();
    assert.equal((await consentJson(userJwt(), first.cookie, { requestId: first.requestId, allow: true })).status, 200);
    const again = await submitForm({ requestId: first.requestId, allow: 'true', access_token: userJwt() }, { cookie: first.cookie });
    assertPage(again, 400, /This authorization request has expired\./);

    const second = await authorize();
    const viaForm = await submitForm({ requestId: second.requestId, allow: 'true', access_token: userJwt() }, { cookie: second.cookie });
    assert.equal(viaForm.status, 303, viaForm.text);
    const json = await consentJson(userJwt(), second.cookie, { requestId: second.requestId, allow: true });
    assert.equal(json.status, 400);
    assert.equal(json.body.error, 'invalid_request');
  });

  it('auto with the switch off → 403 page, the request stays decidable by hand', async () => {
    delete process.env.SSO_TGE_AUTO_APPROVE;
    const { requestId, cookie } = await authorize();
    const res = await submitForm({ requestId, allow: 'true', auto: 'true', access_token: userJwt() }, { cookie });
    assertPage(res, 403, /Automatic approval is not enabled for this sign-in\./);
    assertUndecided(requestId);
  });

  for (const [name, fields, message] of [
    ['allow missing', {}, /allow must be true or false/],
    ['auto with a denial', { allow: 'false', auto: 'true' }, /auto requires allow=true/],
    ['auto not a boolean', { allow: 'true', auto: 'yes' }, /auto must be true or false/],
  ]) {
    it(`malformed (${name}) → 400 page`, async () => {
      const { requestId, cookie } = await authorize();
      const res = await submitForm({ requestId, ...fields, access_token: userJwt() }, { cookie });
      assertPage(res, 400, message);
      assertUndecided(requestId);
    });
  }

  it('an SSO session answers only for its own client → 403 page', async () => {
    const { requestId, cookie } = await authorize({ clientId: 'ddc_oauth_mcp1', redirectUri: MCP_REDIRECT });
    const res = await submitForm({ requestId, allow: 'true', access_token: await appSession() }, { cookie });
    assertPage(res, 403, /This session is bound to a different client\./);
    assertUndecided(requestId);
  });

  it('the consent limiter counts form and JSON decisions together', async () => {
    const token = userJwt();
    for (let i = 0; i < 10; i++) {
      await consentJson(token, null, { requestId: `nope-${i}`, allow: false });
    }
    const res = await submitForm({ requestId: 'nope-x', allow: 'false', access_token: token });
    assertPage(res, 429, /Too many consent decisions/);
  });
});

describe('the form endpoint decides nothing for anyone else', () => {
  for (const [name, origin] of [
    ['no Origin header', null],
    ['a foreign origin', 'https://attacker.example'],
    ['an opaque origin', 'null'],
    ['the API itself', ISSUER],
    ['a look-alike of the web origin', 'https://app.test.local.attacker.example'],
    ['the web origin over http', 'http://app.test.local'],
  ]) {
    it(`${name} → 403 page`, async () => {
      const { requestId, cookie } = await authorize();
      const res = await submitForm({ requestId, allow: 'true', access_token: userJwt() }, { cookie, origin });
      assertPage(res, 403, /This sign-in page is not allowed to submit the decision\./);
      assertUndecided(requestId);
    });
  }

  for (const [name, type] of [['JSON', 'json'], ['plain text', 'text/plain']]) {
    it(`a ${name} body → 415 page`, async () => {
      const { requestId, cookie } = await authorize();
      const body = type === 'json' ? { requestId, allow: true, access_token: userJwt() } : `requestId=${requestId}&allow=true`;
      const res = await submitForm(body, { cookie, type });
      assertPage(res, 415, /Submit the consent decision as a form\./);
      assertUndecided(requestId);
    });
  }

  it('no access_token → 401 page', async () => {
    const { requestId, cookie } = await authorize();
    const res = await submitForm({ requestId, allow: 'true' }, { cookie });
    assertPage(res, 401, /Authentication required/);
    assertUndecided(requestId);
  });

  for (const [name, value] of [
    ['a token signed with another secret', jwt.sign({ id: 'user-form-1' }, 'not-the-secret')],
    ['a repeated field', ['a', 'b']],
    ['an expired SSO session', 'ddc_sso_not-a-session'],
  ]) {
    it(`${name} → 401 page`, async () => {
      const { requestId, cookie } = await authorize();
      const res = await submitForm({ requestId, allow: 'true', access_token: value }, { cookie });
      assertPage(res, 401);
      assertUndecided(requestId);
    });
  }

  it('an Authorization header next to access_token → 400 page', async () => {
    const { requestId, cookie } = await authorize();
    const token = userJwt();
    const res = await submitForm({ requestId, allow: 'true', access_token: token }, { cookie, authorization: `Bearer ${token}` });
    assertPage(res, 400, /Present the credential once\./);
    assertUndecided(requestId);
  });

  it('GET /oauth/consent is not an endpoint', async () => {
    const res = await request(server).get('/oauth/consent').set('Origin', WEB);
    assert.equal(res.status, 404);
  });
});
