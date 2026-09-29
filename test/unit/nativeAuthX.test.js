/**
 * Native X login (design §2.1 rows 7–9, §2.6, §3.5; F6, F12, D11): backend PKCE as a confidential
 * client, the cookie-bound state, the sealed single-use hand-off, identity = the X user id (never
 * User.xid, never an auto-link), the return-URL rules, and the existing "bind X account" helpers
 * left unchanged by default.
 *
 * X is a fake: xService's two network calls are replaced for the flow tests, and axios is stubbed
 * for the xService tests, so nothing reaches the network. identify.createLoginAttempt is the real
 * one (BE6) against the in-memory Prisma. Every log line is captured before redaction and checked
 * for secrets.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');

const key = makeKeyFile();
const LEGACY_X = 'web3auth-auth0-twitter-sapphire-devnet';
const CLIENT_SECRET = 'x-client-secret-never-logged-0123456789';
const WEB_RETURN = 'https://localhost:20444/login/callback';
const APP_RETURN_LOCAL = 'ai.datadance.app://auth/callback';
const CALLBACK = 'http://localhost:3000/api/auth/native/x/callback';
const BASE_ENV = localEnv(key, {
  DDC_AUTH_METHODS: 'x',
  DDC_AUTH_NEW_ACCOUNTS: 'open',
  DDC_AUTH_LEGACY_X_VERIFIERS: LEGACY_X,
  DDC_AUTH_X_CALLBACK_URL: CALLBACK,
  DDC_AUTH_X_WEB_RETURN_URL: WEB_RETURN,
  DDC_AUTH_X_APP_RETURN_URL: APP_RETURN_LOCAL,
  X_CLIENT_ID: 'x-client-id',
  X_CLIENT_SECRET: CLIENT_SECRET,
  X_API_URL: 'https://api.x.test/2',
  X_OAUTH_CALLBACK_URL: 'https://api.example.test/api/x/oauth2/callback',
  X_BEARER_TOKEN: 'bearer-for-xclient',
});
Object.assign(process.env, BASE_ENV, { NODE_ENV: 'test', LOG_LEVEL: 'error' });

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma({ enforceUnique: true });

// Capture every log line with its meta, before redaction: the services must not even pass secrets.
const logs = [];
const realLogger = require('../../src/utils/logger');
require.cache[require.resolve('../../src/utils/logger')].exports = {
  ...realLogger,
  createLogger: (name) => {
    const push = (level) => (message, meta) => logs.push({ level, name, message, meta });
    return { info: push('info'), warn: push('warn'), error: push('error'), debug: () => {}, http: () => {}, add: () => {}, remove: () => {} };
  },
};

const axios = require('axios');
const config = require('../../src/services/nativeAuth/config');
const xService = require('../../src/services/xService');
const idpX = require('../../src/services/nativeAuth/idpX');
const { loginSecretHash } = require('../../src/services/nativeAuth/identify');
const { NATIVE_ERROR_CODES } = require('../../src/controllers/nativeAuth/respond');
const { createXController, readLoginCookie } = require('../../src/controllers/nativeAuth/xController');
const nativeAuthRoutes = require('../../src/routes/nativeAuthRoutes');
const { listenLoopback } = require('../helpers/loopbackServer');

// ---------------------------------------------------------------------------------------------
// Fake X (token endpoint + users/me)
// ---------------------------------------------------------------------------------------------
const realExchange = xService.exchangeCodeForToken;
const realUserInfo = xService.getOAuth2UserInfo;
const xUsers = new Map(); // code → users/me body
const xCalls = [];
let xTokenFails = false;
let xUserFails = false;
function fakeX() {
  xService.exchangeCodeForToken = async (code, verifier, redirectUri, options) => {
    xCalls.push({ kind: 'token', code, verifier, redirectUri, options });
    if (xTokenFails || !xUsers.has(code)) {
      const err = new Error('Request failed with status code 400');
      err.response = { status: 400, data: { error: 'invalid_request' } };
      throw err;
    }
    return { access_token: `at-${code}`, token_type: 'bearer', expires_in: 7200, scope: 'tweet.read users.read' };
  };
  xService.getOAuth2UserInfo = async (accessToken, options) => {
    xCalls.push({ kind: 'user', accessToken, options });
    if (xUserFails) throw new Error('users/me failed');
    return xUsers.get(accessToken.slice(3));
  };
}
function realX() {
  xService.exchangeCodeForToken = realExchange;
  xService.getOAuth2UserInfo = realUserInfo;
}

// ---------------------------------------------------------------------------------------------
// Apps: the controller with a fake bearer check, and the real router for the flag gates
// ---------------------------------------------------------------------------------------------
let envOverrides = {};
const cfg = () => config.readNativeAuthConfig({ ...BASE_ENV, ...envOverrides });

/** Bearer "user:<id>" → req.user from the in-memory rows; anything else → 401 (like protect). */
function fakeAuthenticate(req, res, next) {
  const match = /^Bearer user:(.+)$/.exec(req.get('authorization') || '');
  const user = match && prisma.user.rows.find((r) => r.id === match[1]);
  if (!user) return res.status(401).json({ status: 'fail', message: 'Not authorized' });
  req.user = user;
  return next();
}

const controller = createXController({ authenticate: fakeAuthenticate });
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.nativeAuthConfig = cfg();
  next();
});
app.get('/x/start', controller.start);
app.get('/x/callback', controller.callback);
app.post('/x/exchange', controller.exchange);

const routerApp = express();
routerApp.use(express.json());
routerApp.use('/api/auth/native', nativeAuthRoutes);

let server;
let routerServer;
before(async () => {
  server = await listenLoopback(app);
  routerServer = await listenLoopback(routerApp);
});
after(() => {
  server.close();
  routerServer.close();
  realX();
});

beforeEach(() => {
  prisma.reset();
  logs.length = 0;
  xCalls.length = 0;
  xUsers.clear();
  xTokenFails = false;
  xUserFails = false;
  envOverrides = {};
  fakeX();
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
let seq = 0;
function addUser(fields = {}) {
  seq += 1;
  const row = {
    id: `user-${seq}`,
    email: `user${seq}@example.com`,
    name: null,
    walletAddress: null,
    authType: 'web3auth',
    userType: 'regular',
    isOrganization: false,
    disabledAt: null,
    xid: null,
    web3authVerifier: null,
    web3authVerifierId: null,
    referralCode: `CODE${seq}`,
    legacyReferralCode: null,
    ...fields,
  };
  prisma.user.rows.push(row);
  return row;
}

const b64urlSha256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');
const newVerifier = () => crypto.randomBytes(32).toString('base64url');

function fragmentOf(location) {
  const index = location.indexOf('#');
  assert.ok(index > 0, `no fragment in ${location}`);
  return { base: location.slice(0, index), params: Object.fromEntries(new URLSearchParams(location.slice(index + 1))) };
}

function setCookieOf(res) {
  const header = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith(`${idpX.COOKIE_NAME}=`));
  return header;
}

/** GET /x/start as the browser does. Returns the state X would get back, the cookie and the verifier. */
async function start({ platform = 'web', intent = 'login', verifier = newVerifier(), extra = {} } = {}) {
  const res = await request(server).get('/x/start').query({ platform, challenge: b64urlSha256(verifier), intent, locale: 'en', ...extra });
  assert.equal(res.status, 302, JSON.stringify(res.body));
  const url = new URL(res.headers.location);
  const setCookie = setCookieOf(res);
  const cookie = setCookie.split(';')[0].slice(idpX.COOKIE_NAME.length + 1);
  return { res, url, state: url.searchParams.get('state'), cookie, setCookie, verifier };
}

async function callback({ state, cookie, code, query } = {}) {
  let req = request(server).get('/x/callback').query(query || { code, state });
  if (cookie !== undefined) req = req.set('Cookie', `other=1; ${idpX.COOKIE_NAME}=${cookie}`);
  const res = await req;
  assert.equal(res.status, 302, JSON.stringify(res.body));
  return { res, ...fragmentOf(res.headers.location) };
}

async function exchange(handoff, verifier, bearer) {
  let req = request(server).post('/x/exchange');
  if (bearer) req = req.set('Authorization', `Bearer ${bearer}`);
  return req.send({ handoff, verifier });
}

/** start → X → callback, for X user `id`. */
async function throughCallback({ id = '4242', username = 'dancer', platform = 'web', intent = 'login', user } = {}) {
  const code = `code-${crypto.randomBytes(6).toString('hex')}`;
  xUsers.set(code, user !== undefined ? user : { id, username, name: 'Dancer', profile_image_url: 'https://pbs.twimg.com/a.jpg' });
  const s = await start({ platform, intent });
  const cb = await callback({ state: s.state, cookie: s.cookie, code });
  return { ...s, ...cb, code };
}

function allLogText() {
  return JSON.stringify(logs);
}

// ---------------------------------------------------------------------------------------------
// xService: the existing binding flow is unchanged by default
// ---------------------------------------------------------------------------------------------
describe('xService (shared with the existing "bind X account" flow)', () => {
  let posted;
  let got;
  const realPost = axios.post;
  const realGet = axios.get;
  beforeEach(() => {
    realX();
    posted = [];
    got = [];
    axios.post = async (url, payload, options) => {
      posted.push({ url, payload, options });
      return { data: { access_token: 'at', refresh_token: 'rt' } };
    };
    axios.get = async (url, options) => {
      got.push({ url, options });
      return { data: { data: { id: '1', username: 'u', name: 'n' } } };
    };
  });
  after(() => {
    axios.post = realPost;
    axios.get = realGet;
  });

  it('exchangeCodeForToken(code, verifier) keeps X_OAUTH_CALLBACK_URL, X_API_URL and no timeout', async () => {
    await xService.exchangeCodeForToken('the-code', 'the-verifier');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, 'https://api.x.test/2/oauth2/token');
    const body = new URLSearchParams(posted[0].payload);
    assert.equal(body.get('redirect_uri'), BASE_ENV.X_OAUTH_CALLBACK_URL);
    assert.equal(body.get('code_verifier'), 'the-verifier');
    assert.equal(posted[0].options.timeout, undefined);
    assert.equal(posted[0].options.headers.Authorization, `Basic ${Buffer.from(`x-client-id:${CLIENT_SECRET}`).toString('base64')}`);
  });

  it('exchangeCodeForToken takes an optional redirect URI, API base and timeout (native login)', async () => {
    await xService.exchangeCodeForToken('c', 'v', CALLBACK, { timeout: 1234, apiBase: 'https://api.x.com/2' });
    assert.equal(posted[0].url, 'https://api.x.com/2/oauth2/token');
    assert.equal(new URLSearchParams(posted[0].payload).get('redirect_uri'), CALLBACK);
    assert.equal(posted[0].options.timeout, 1234);
  });

  it('getOAuth2UserInfo(token) is unchanged; options add user.fields, API base and timeout', async () => {
    assert.deepEqual(await xService.getOAuth2UserInfo('tok'), { id: '1', username: 'u', name: 'n' });
    assert.equal(got[0].url, 'https://api.x.test/2/users/me');
    assert.deepEqual(got[0].options, { headers: { Authorization: 'Bearer tok' } });
    await xService.getOAuth2UserInfo('tok', { timeout: 99, apiBase: 'https://b/2', userFields: 'profile_image_url' });
    assert.equal(got[1].url, 'https://b/2/users/me');
    assert.deepEqual(got[1].options.params, { 'user.fields': 'profile_image_url' });
    assert.equal(got[1].options.timeout, 99);
  });

  it('generateAuthUrl (binding flow) is unchanged; the login URL asks for users.read tweet.read only', () => {
    const bind = new URL(xService.generateAuthUrl('st', 'ch', 'https://cb'));
    assert.equal(`${bind.origin}${bind.pathname}`, 'https://api.x.test/2/oauth2/authorize');
    assert.equal(bind.searchParams.get('scope'), 'tweet.read users.read offline.access');
    const login = new URL(xService.buildLoginAuthorizeUrl({ redirectUri: CALLBACK, state: 'st', codeChallenge: 'ch' }));
    assert.equal(`${login.origin}${login.pathname}`, 'https://x.com/i/oauth2/authorize');
    assert.equal(login.searchParams.get('scope'), 'tweet.read users.read');
    assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(login.searchParams.get('client_id'), 'x-client-id');
  });

  it('loginApiBase falls back to https://api.x.com/2 when X_API_URL is unset', () => {
    const saved = process.env.X_API_URL;
    try {
      delete process.env.X_API_URL;
      assert.equal(xService.loginApiBase(), 'https://api.x.com/2');
      process.env.X_API_URL = 'https://api.x.test/2/';
      assert.equal(xService.loginApiBase(), 'https://api.x.test/2');
    } finally {
      process.env.X_API_URL = saved;
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------
describe('flags (the real router)', () => {
  const saved = {};
  const setEnv = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  after(() => setEnv(saved));

  it('DDC_AUTH_ENABLED off: all three X routes answer 404 NATIVE_AUTH_DISABLED and touch nothing', async () => {
    setEnv({ DDC_AUTH_ENABLED: undefined });
    for (const [method, path] of [['get', '/api/auth/native/x/start?platform=web'], ['get', '/api/auth/native/x/callback?code=a&state=b'], ['post', '/api/auth/native/x/exchange']]) {
      const res = await request(routerServer)[method](path).send({});
      assert.equal(res.status, 404, path);
      assert.equal(res.body.code, 'NATIVE_AUTH_DISABLED');
      assert.equal(res.headers['set-cookie'], undefined);
    }
    assert.equal(prisma.authFlowState.rows.length, 0);
    assert.equal(xCalls.length, 0);
    setEnv({ DDC_AUTH_ENABLED: 'true' });
  });

  it('x not in DDC_AUTH_METHODS: 404 METHOD_DISABLED', async () => {
    setEnv({ DDC_AUTH_METHODS: 'email', DDC_AUTH_ENABLED: 'true' });
    const res = await request(routerServer).get('/api/auth/native/x/start').query({ platform: 'web', challenge: b64urlSha256('v') });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'METHOD_DISABLED');
    setEnv({ DDC_AUTH_METHODS: 'x' });
  });

  it('flag on: the router reaches the real handlers (start redirects to X, no-store)', async () => {
    setEnv({ DDC_AUTH_ENABLED: 'true', DDC_AUTH_METHODS: 'x' });
    const res = await request(routerServer).get('/api/auth/native/x/start').query({ platform: 'web', challenge: b64urlSha256('v'), intent: 'login' });
    assert.equal(res.status, 302, JSON.stringify(res.body));
    assert.ok(res.headers.location.startsWith('https://x.com/i/oauth2/authorize?'));
    assert.equal(res.headers['cache-control'], 'no-store');
    const ex = await request(routerServer).post('/api/auth/native/x/exchange').send({ handoff: 'nope', verifier: 'nope' });
    assert.equal(ex.status, 400);
    assert.equal(ex.body.code, 'X_HANDOFF_INVALID');
  });
});

// ---------------------------------------------------------------------------------------------
// GET /x/start
// ---------------------------------------------------------------------------------------------
describe('GET /x/start', () => {
  it('redirects to X with our callback, S256 of a derived verifier, and sets the __Host- cookie', async () => {
    const s = await start();
    assert.equal(`${s.url.origin}${s.url.pathname}`, 'https://x.com/i/oauth2/authorize');
    const p = s.url.searchParams;
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('client_id'), 'x-client-id');
    assert.equal(p.get('redirect_uri'), CALLBACK);
    assert.equal(p.get('scope'), 'tweet.read users.read');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.match(s.state, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(p.get('code_challenge'), b64urlSha256(idpX.pkceVerifier(s.state, cfg())));
    assert.notEqual(p.get('code_challenge'), b64urlSha256(s.verifier), "X never sees the client's challenge");
    assert.ok(!s.res.headers.location.includes(CLIENT_SECRET));

    const attrs = s.setCookie.split(';').map((a) => a.trim().toLowerCase());
    for (const attr of ['path=/', 'secure', 'httponly', 'samesite=lax', 'max-age=600']) assert.ok(attrs.includes(attr), `${attr} in ${s.setCookie}`);
    assert.ok(!attrs.some((a) => a.startsWith('domain=')), '__Host- cookies carry no Domain');
    assert.match(s.cookie, /^web\.[A-Za-z0-9_-]{43}$/);
    assert.equal(s.res.headers['referrer-policy'], 'no-referrer');
  });

  it('stores one x_oauth state (10 min) with hashes only: no raw state, cookie or verifier', async () => {
    const now = Date.now();
    const s = await start({ intent: 'link' });
    assert.equal(prisma.authFlowState.rows.length, 1);
    const row = prisma.authFlowState.rows[0];
    assert.equal(row.kind, 'x_oauth');
    assert.equal(row.valueHash, config.stateHmac('flow:x_oauth', s.state, cfg()));
    assert.deepEqual(row.data, {
      platform: 'web',
      clientChallenge: b64urlSha256(s.verifier),
      intent: 'link',
      locale: 'en',
      cookieHash: crypto.createHash('sha256').update(s.cookie).digest('hex'),
    });
    assert.ok(Math.abs(row.expiresAt.getTime() - now - 600000) < 5000);
    const stored = JSON.stringify(prisma.store);
    for (const secret of [s.state, s.cookie, idpX.pkceVerifier(s.state, cfg()), s.verifier]) assert.ok(!stored.includes(secret));
  });

  it('a bad challenge, intent or locale bounces to the return URL with #error=x_failed; nothing is stored', async () => {
    for (const query of [
      { platform: 'web', challenge: 'short' },
      { platform: 'web', challenge: b64urlSha256('v'), intent: 'admin' },
      { platform: 'web', challenge: b64urlSha256('v'), locale: '<script>' },
    ]) {
      const res = await request(server).get('/x/start').query(query);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, `${WEB_RETURN}#error=x_failed&provider=x`);
      assert.equal(setCookieOf(res), undefined);
    }
    assert.equal(prisma.authFlowState.rows.length, 0);
  });

  it('an unknown or disabled platform answers 404 METHOD_DISABLED', async () => {
    const unknown = await request(server).get('/x/start').query({ platform: 'desktop', challenge: b64urlSha256('v') });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'METHOD_DISABLED');
    envOverrides = { DDC_AUTH_PLATFORMS: 'web' };
    const disabled = await request(server).get('/x/start').query({ platform: 'ios', challenge: b64urlSha256('v') });
    assert.equal(disabled.status, 404);
    assert.equal(disabled.body.code, 'METHOD_DISABLED');
    assert.equal(prisma.authFlowState.rows.length, 0);
  });

  it('without the client secret in env: 503 IDP_UNAVAILABLE, nothing stored', async () => {
    const saved = process.env.X_CLIENT_SECRET;
    try {
      delete process.env.X_CLIENT_SECRET;
      const res = await request(server).get('/x/start').query({ platform: 'web', challenge: b64urlSha256('v') });
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'IDP_UNAVAILABLE');
    } finally {
      process.env.X_CLIENT_SECRET = saved;
    }
    assert.equal(prisma.authFlowState.rows.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Return URLs (F6)
// ---------------------------------------------------------------------------------------------
describe('return URLs (F6)', () => {
  const withEnv = (overrides) => config.readNativeAuthConfig({ ...BASE_ENV, ...overrides });

  it('web → DDC_AUTH_X_WEB_RETURN_URL; ios/android → DDC_AUTH_X_APP_RETURN_URL; fragments are stripped', () => {
    const c = withEnv({ DDC_AUTH_X_WEB_RETURN_URL: `${WEB_RETURN}#old` });
    assert.equal(idpX.returnUrlFor('web', c), WEB_RETURN);
    assert.equal(idpX.returnUrlFor('ios', c), APP_RETURN_LOCAL);
    assert.equal(idpX.returnUrlFor('android', c), APP_RETURN_LOCAL);
  });

  it('a custom scheme is legal only with DDC_AUTH_ENV=local, and never for web', () => {
    assert.throws(() => idpX.returnUrlFor('ios', withEnv({ DDC_AUTH_ENV: 'test' })), { name: 'XLoginError', kind: 'misconfigured' });
    assert.throws(() => idpX.returnUrlFor('ios', withEnv({ DDC_AUTH_ENV: 'prod' })), { name: 'XLoginError', kind: 'misconfigured' });
    assert.throws(() => idpX.returnUrlFor('web', withEnv({ DDC_AUTH_X_WEB_RETURN_URL: 'ai.datadance.app://auth/callback' })), { kind: 'misconfigured' });
    for (const bad of ['javascript:alert(1)', 'data:text/html,x']) {
      assert.throws(() => idpX.returnUrlFor('ios', withEnv({ DDC_AUTH_X_APP_RETURN_URL: bad })), { kind: 'misconfigured' });
    }
  });

  it('production accepts only https returns (the verified app link); http only on loopback in local/test', () => {
    const prod = withEnv({ DDC_AUTH_ENV: 'prod', DDC_AUTH_X_WEB_RETURN_URL: 'https://app.datadance.ai/login/callback', DDC_AUTH_X_APP_RETURN_URL: 'https://app.datadance.ai/login/app-callback' });
    assert.equal(idpX.returnUrlFor('ios', prod), 'https://app.datadance.ai/login/app-callback');
    assert.equal(idpX.returnUrlFor('web', prod), 'https://app.datadance.ai/login/callback');
    assert.throws(() => idpX.returnUrlFor('web', withEnv({ DDC_AUTH_ENV: 'prod', DDC_AUTH_X_WEB_RETURN_URL: 'http://localhost:20444/login/callback' })), { kind: 'misconfigured' });
    assert.equal(idpX.returnUrlFor('web', withEnv({ DDC_AUTH_X_WEB_RETURN_URL: 'http://localhost:20444/login/callback' })), 'http://localhost:20444/login/callback');
    assert.throws(() => idpX.returnUrlFor('web', withEnv({ DDC_AUTH_X_WEB_RETURN_URL: 'http://evil.example/login/callback' })), { kind: 'misconfigured' });
  });

  it('boot refuses a custom-scheme app return outside local (config rule, re-checked here)', () => {
    const problems = config.nativeAuthProblems(withEnv({ DDC_AUTH_ENV: 'test' }), { ...BASE_ENV, DDC_AUTH_ENV: 'test' });
    assert.ok(problems.some((p) => p.includes('DDC_AUTH_X_APP_RETURN_URL may use a custom scheme only with DDC_AUTH_ENV=local')), problems.join('\n'));
    assert.ok(config.productionProblems(withEnv({ DDC_AUTH_ENV: 'prod' })).some((p) => p.includes('DDC_AUTH_X_APP_RETURN_URL must be https')));
  });

  it('a start with a refused return URL answers 503 before anything is stored', async () => {
    envOverrides = { DDC_AUTH_ENV: 'test' };
    const res = await request(server).get('/x/start').query({ platform: 'ios', challenge: b64urlSha256('v') });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'IDP_UNAVAILABLE');
    assert.equal(prisma.authFlowState.rows.length, 0);
  });

  it('the App (local) gets its hand-off on the custom scheme; X is only ever given our API callback', async () => {
    const flow = await throughCallback({ platform: 'ios' });
    assert.equal(flow.base, APP_RETURN_LOCAL);
    assert.equal(flow.params.provider, 'x');
    assert.match(flow.params.handoff, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(flow.url.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(xCalls.find((c) => c.kind === 'token').redirectUri, CALLBACK);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /x/callback
// ---------------------------------------------------------------------------------------------
describe('GET /x/callback', () => {
  it('success: exchanges the code with the derived verifier, reads users/me, redirects #handoff=…&provider=x', async () => {
    const flow = await throughCallback();
    assert.equal(flow.base, WEB_RETURN);
    assert.deepEqual(Object.keys(flow.params).sort(), ['handoff', 'provider']);
    const token = xCalls.find((c) => c.kind === 'token');
    assert.equal(token.code, flow.code);
    assert.equal(token.verifier, idpX.pkceVerifier(flow.state, cfg()));
    assert.equal(token.options.apiBase, 'https://api.x.test/2');
    assert.ok(token.options.timeout > 0);
    const user = xCalls.find((c) => c.kind === 'user');
    assert.equal(user.options.userFields, 'profile_image_url');
    // The browser cookie is cleared; nothing about X is in the redirect.
    const cleared = setCookieOf(flow.res);
    assert.ok(cleared && /expires=thu, 01 jan 1970/i.test(cleared), cleared);
    for (const secret of [flow.code, `at-${flow.code}`, flow.state, '4242']) assert.ok(!flow.res.headers.location.includes(secret));
    assert.equal(flow.res.headers['referrer-policy'], 'no-referrer');
  });

  it('the hand-off row (60 s) holds no usable secret: the Identified body is sealed', async () => {
    const now = Date.now();
    const flow = await throughCallback();
    const handoffRow = prisma.authFlowState.rows.find((r) => r.kind === 'x_handoff');
    assert.ok(Math.abs(handoffRow.expiresAt.getTime() - now - 60000) < 5000);
    assert.equal(handoffRow.valueHash, config.stateHmac('flow:x_handoff', flow.params.handoff, cfg()));
    assert.deepEqual(Object.keys(handoffRow.data).sort(), ['clientChallenge', 'intent', 'sealed']);
    const identified = (await exchange(flow.params.handoff, flow.verifier)).body.data;
    const stored = JSON.stringify(prisma.store.authFlowState);
    for (const secret of [identified.loginSecret, identified.web3auth.idToken, identified.loginId, flow.params.handoff, `at-${flow.code}`]) {
      assert.ok(!stored.includes(secret), 'secret stored in AuthFlowState');
    }
  });

  it('identity = the X user id; a user holding the same User.xid is never linked (F12)', async () => {
    const holder = addUser({ xid: '4242' });
    const flow = await throughCallback({ id: '4242' });
    const res = await exchange(flow.params.handoff, flow.verifier);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.account, { status: 'new', hasWallet: false, linkedBy: 'new' });
    const attempt = prisma.authLoginAttempt.rows[0];
    assert.equal(attempt.provider, 'x');
    assert.equal(attempt.subject, '4242');
    assert.equal(attempt.method, 'x');
    assert.equal(attempt.emailLinkGrade, 'none');
    assert.equal(attempt.email, null);
    assert.notEqual(attempt.userId, holder.id);
    assert.equal(attempt.profile.xUsername, 'dancer');
  });

  it('a legacy Web3Auth X pair links (the only X link, rule 2)', async () => {
    const legacy = addUser({ email: 'twitter|77', web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|77', walletAddress: '0x0000000000000000000000000000000000000077' });
    const flow = await throughCallback({ id: '77' });
    const res = await exchange(flow.params.handoff, flow.verifier);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.account.linkedBy, 'legacy_x');
    assert.equal(prisma.authLoginAttempt.rows[0].userId, legacy.id);
  });

  it('login CSRF: a missing or different cookie → #error=state_invalid, and the state is spent', async () => {
    const code = 'code-csrf';
    xUsers.set(code, { id: '1', username: 'a' });
    const s = await start();
    const other = await start();
    const missing = await callback({ state: s.state, code });
    assert.deepEqual(missing.params, { error: 'state_invalid', provider: 'x' });
    const s2 = await start();
    const wrong = await callback({ state: s2.state, cookie: other.cookie, code });
    assert.deepEqual(wrong.params, { error: 'state_invalid', provider: 'x' });
    const replay = await callback({ state: s2.state, cookie: s2.cookie, code });
    assert.deepEqual(replay.params, { error: 'state_invalid', provider: 'x' });
    assert.equal(xCalls.length, 0, 'X is never asked for a token');
    assert.equal(prisma.authLoginAttempt.rows.length, 0);
    assert.ok(logs.some((l) => l.message === 'native_auth.x_callback_error' && l.meta.reason === 'cookie_mismatch'));
  });

  it('state single use and expiry: a replayed or 10-minute-old state → state_invalid', async () => {
    const flow = await throughCallback();
    const replay = await callback({ state: flow.state, cookie: flow.cookie, code: flow.code });
    assert.deepEqual(replay.params, { error: 'state_invalid', provider: 'x' });
    const s = await start();
    prisma.authFlowState.rows.find((r) => r.kind === 'x_oauth' && r.consumedAt === null).expiresAt = new Date(Date.now() - 1);
    const old = await callback({ state: s.state, cookie: s.cookie, code: 'c' });
    assert.deepEqual(old.params, { error: 'state_invalid', provider: 'x' });
  });

  it('an unknown state with an App cookie bounces to the App return URL', async () => {
    const s = await start({ platform: 'android' });
    const res = await callback({ state: 'x'.repeat(43), cookie: s.cookie, code: 'c' });
    assert.equal(res.base, APP_RETURN_LOCAL);
    assert.deepEqual(res.params, { error: 'state_invalid', provider: 'x' });
  });

  it('?error=access_denied → x_denied; any other X error → x_failed', async () => {
    const s = await start();
    const denied = await callback({ query: { error: 'access_denied', state: s.state }, cookie: s.cookie });
    assert.deepEqual(denied.params, { error: 'x_denied', provider: 'x' });
    const s2 = await start();
    const failed = await callback({ query: { error: 'server_error', state: s2.state }, cookie: s2.cookie });
    assert.deepEqual(failed.params, { error: 'x_failed', provider: 'x' });
    assert.equal(xCalls.length, 0);
  });

  it('token exchange, users/me or an invalid user id failing → x_failed, no attempt', async () => {
    xTokenFails = true;
    assert.deepEqual((await throughCallback()).params, { error: 'x_failed', provider: 'x' });
    xTokenFails = false;
    xUserFails = true;
    assert.deepEqual((await throughCallback()).params, { error: 'x_failed', provider: 'x' });
    xUserFails = false;
    assert.deepEqual((await throughCallback({ user: { id: 'not-a-number', username: 'u' } })).params, { error: 'x_failed', provider: 'x' });
    assert.deepEqual((await throughCallback({ user: null })).params, { error: 'x_failed', provider: 'x' });
    const s = await start();
    assert.deepEqual((await callback({ query: { state: s.state }, cookie: s.cookie })).params, { error: 'x_failed', provider: 'x' });
    assert.equal(prisma.authLoginAttempt.rows.length, 0);
    assert.equal(prisma.authFlowState.rows.filter((r) => r.kind === 'x_handoff').length, 0);
  });

  it('a database failure after X answered still sends the browser back with x_failed', async () => {
    const realCreate = prisma.authFlowState.create;
    const s = await start();
    xUsers.set('code-db', { id: '5', username: 'e' });
    prisma.authFlowState.create = async () => {
      throw new Error('db down');
    };
    try {
      const res = await callback({ state: s.state, cookie: s.cookie, code: 'code-db' });
      assert.deepEqual(res.params, { error: 'x_failed', provider: 'x' });
      assert.equal(res.base, WEB_RETURN);
    } finally {
      prisma.authFlowState.create = realCreate;
    }
  });
});

// ---------------------------------------------------------------------------------------------
// POST /x/exchange
// ---------------------------------------------------------------------------------------------
describe('POST /x/exchange', () => {
  it('answers the full Identified body; its loginSecret is the one the attempt stores (HMAC)', async () => {
    const flow = await throughCallback();
    const res = await exchange(flow.params.handoff, flow.verifier);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.deepEqual(Object.keys(data).sort(), ['account', 'expiresAt', 'loginId', 'loginSecret', 'walletProof', 'web3auth']);
    assert.match(data.loginSecret, /^[A-Za-z0-9_-]{43}$/);
    const attempt = prisma.authLoginAttempt.rows.find((r) => r.id === data.loginId);
    assert.equal(attempt.loginSecretHash, loginSecretHash(data.loginSecret, cfg()));
    assert.equal(data.web3auth.verifier, 'ddc-jwt-devnet');
    const claims = jwt.decode(data.web3auth.idToken);
    assert.equal(claims.sub, data.web3auth.verifierId);
    assert.equal(claims.sub, attempt.w3aSubject);
    assert.notEqual(claims.sub, '4242', 'the X id is never the Web3Auth subject');
  });

  it('single use: a second redemption → X_HANDOFF_INVALID', async () => {
    const flow = await throughCallback();
    assert.equal((await exchange(flow.params.handoff, flow.verifier)).status, 200);
    const again = await exchange(flow.params.handoff, flow.verifier);
    assert.equal(again.status, 400);
    assert.equal(again.body.code, 'X_HANDOFF_INVALID');
  });

  it('a wrong verifier → X_HANDOFF_INVALID, and the hand-off is burned', async () => {
    const flow = await throughCallback();
    const wrong = await exchange(flow.params.handoff, newVerifier());
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'X_HANDOFF_INVALID');
    const right = await exchange(flow.params.handoff, flow.verifier);
    assert.equal(right.body.code, 'X_HANDOFF_INVALID');
  });

  it('after 60 s → X_HANDOFF_INVALID', async () => {
    const flow = await throughCallback();
    prisma.authFlowState.rows.find((r) => r.kind === 'x_handoff').expiresAt = new Date(Date.now() - 1);
    const res = await exchange(flow.params.handoff, flow.verifier);
    assert.equal(res.body.code, 'X_HANDOFF_INVALID');
  });

  it('malformed or missing fields → X_HANDOFF_INVALID without touching the store', async () => {
    const before = JSON.stringify(prisma.store);
    for (const body of [{}, { handoff: 'a', verifier: 'b' }, { handoff: 'a'.repeat(43) }, { handoff: ['x'], verifier: newVerifier() }]) {
      const res = await request(server).post('/x/exchange').send(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'X_HANDOFF_INVALID');
    }
    assert.equal(JSON.stringify(prisma.store), before);
  });

  it('a hand-off that does not open with its value (tampered box) → X_HANDOFF_INVALID', async () => {
    const flow = await throughCallback();
    const row = prisma.authFlowState.rows.find((r) => r.kind === 'x_handoff');
    row.data = { ...row.data, sealed: { ...row.data.sealed, tag: Buffer.alloc(16).toString('base64url') } };
    assert.equal((await exchange(flow.params.handoff, flow.verifier)).body.code, 'X_HANDOFF_INVALID');
  });

  it('account refusals found at the callback are answered here with their contract code', async () => {
    envOverrides = { DDC_AUTH_NEW_ACCOUNTS: 'closed' };
    const flow = await throughCallback({ id: '9001' });
    assert.ok(flow.params.handoff, 'the callback still hands off');
    const res = await exchange(flow.params.handoff, flow.verifier);
    assert.equal(res.status, NATIVE_ERROR_CODES.NEW_ACCOUNTS_CLOSED);
    assert.equal(res.body.code, 'NEW_ACCOUNTS_CLOSED');
    assert.equal(prisma.authLoginAttempt.rows.length, 0);

    envOverrides = {};
    addUser({ disabledAt: new Date(), web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|55' });
    const disabled = await throughCallback({ id: '55' });
    const refused = await exchange(disabled.params.handoff, disabled.verifier);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'ACCOUNT_DISABLED');
  });

  it('the allowlist gate accepts x:<id>', async () => {
    envOverrides = { DDC_AUTH_NEW_ACCOUNTS: 'allowlist', DDC_AUTH_ALLOWLIST: 'x:31337' };
    const denied = await throughCallback({ id: '31338' });
    assert.equal((await exchange(denied.params.handoff, denied.verifier)).body.code, 'NEW_ACCOUNTS_CLOSED');
    const allowed = await throughCallback({ id: '31337' });
    assert.equal((await exchange(allowed.params.handoff, allowed.verifier)).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------
// intent=link
// ---------------------------------------------------------------------------------------------
describe('intent=link', () => {
  it('the callback creates no attempt and mints nothing; exchange needs the bearer session', async () => {
    const flow = await throughCallback({ intent: 'link', id: '808' });
    assert.ok(flow.params.handoff);
    assert.equal(prisma.authLoginAttempt.rows.length, 0);
    const res = await exchange(flow.params.handoff, flow.verifier);
    assert.equal(res.status, 401);
  });

  it('with a bearer: a link attempt for the signed-in user, without web3auth or walletProof', async () => {
    const me = addUser({ walletAddress: '0x00000000000000000000000000000000000000aa' });
    const flow = await throughCallback({ intent: 'link', id: '809' });
    const res = await exchange(flow.params.handoff, flow.verifier, `user:${me.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.data).sort(), ['account', 'expiresAt', 'loginId', 'loginSecret']);
    const attempt = prisma.authLoginAttempt.rows[0];
    assert.equal(attempt.intent, 'link');
    assert.equal(attempt.userId, me.id);
    assert.equal(attempt.subject, '809');
    assert.equal(attempt.w3aSubject ?? null, null);
  });

  it('a login hand-off ignores a bearer (no session ever turns into a Web3Auth mint for another intent)', async () => {
    const me = addUser();
    const flow = await throughCallback({ id: '810' });
    const res = await exchange(flow.params.handoff, flow.verifier, `user:${me.id}`);
    assert.equal(res.status, 200);
    assert.notEqual(prisma.authLoginAttempt.rows[0].userId, me.id);
  });
});

// ---------------------------------------------------------------------------------------------
// Logs and cookies
// ---------------------------------------------------------------------------------------------
describe('secrets never reach a log line', () => {
  it('no code, state, cookie, verifier, hand-off, X token, X id, loginSecret, JWT or client secret', async () => {
    const flow = await throughCallback({ id: '123456789' });
    const res = await exchange(flow.params.handoff, flow.verifier);
    const secrets = [flow.code, `at-${flow.code}`, flow.state, flow.cookie, flow.verifier, flow.params.handoff, idpX.pkceVerifier(flow.state, cfg()), res.body.data.loginSecret, res.body.data.web3auth.idToken, '123456789', CLIENT_SECRET];
    const text = allLogText();
    for (const secret of secrets) assert.ok(!text.includes(secret), `log contains a secret (${secrets.indexOf(secret)})`);
    assert.ok(logs.some((l) => l.message === 'native_auth.idp_verified' && l.meta.provider === 'x'));
  });

  it('readLoginCookie picks the __Host- cookie among others and ignores oversize values', () => {
    assert.equal(readLoginCookie({ headers: { cookie: `a=1; ${idpX.COOKIE_NAME}=web.abc; b=2` } }), 'web.abc');
    assert.equal(readLoginCookie({ headers: { cookie: `${idpX.COOKIE_NAME}=${'a'.repeat(300)}` } }), undefined);
    assert.equal(readLoginCookie({ headers: {} }), undefined);
  });
});
