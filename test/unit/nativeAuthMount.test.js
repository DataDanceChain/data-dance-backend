/**
 * The native-login surface inside the REAL application (src/app.js).
 *
 * Flag off (the default): every /api/auth/native/* path answers 404 NATIVE_AUTH_DISABLED before
 * any limiter or handler, the JWKS path falls through to exactly what the app answered before the
 * route existed, and the neighbouring routes behave as they did. Flag on: the router is reached
 * ahead of every `/api` router that protects all it sees, per-method switches answer 404
 * METHOD_DISABLED, and the not-yet-built handlers answer 501.
 */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');
const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');

const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  JWT_SECRET: 'ddc-user-session-secret',
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
});
for (const name of Object.keys(process.env)) if (name.startsWith('DDC_AUTH_')) delete process.env[name];

const app = require('../../src/app');
const { assertNativeAuthConfig } = require('../../src/services/nativeAuth/config');
const { resetSignerCache } = require('../../src/services/nativeAuth/signer');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const key = makeKeyFile();
const saved = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  resetSignerCache();
  clearRateLimitStore();
});

const NATIVE_REQUESTS = [
  ['get', '/api/auth/native/config'],
  ['post', '/api/auth/native/nonce'],
  ['post', '/api/auth/native/email/start'],
  ['post', '/api/auth/native/email/verify'],
  ['post', '/api/auth/native/google'],
  ['post', '/api/auth/native/apple'],
  ['get', '/api/auth/native/x/start'],
  ['get', '/api/auth/native/x/callback'],
  ['post', '/api/auth/native/x/exchange'],
  ['post', '/api/auth/native/token'],
  ['post', '/api/auth/native/complete'],
  ['post', '/api/auth/native/identities/challenge'],
  ['get', '/api/auth/native/identities'],
  ['post', '/api/auth/native/identities/link'],
  ['delete', '/api/auth/native/identities/some-id'],
  ['get', '/api/auth/native/not-a-route'],
];

describe('native login with DDC_AUTH_ENABLED off (default)', () => {
  it('the boot gate is off and silent', () => {
    assert.deepEqual(assertNativeAuthConfig(process.env), { enabled: false });
  });

  it('every native route answers 404 NATIVE_AUTH_DISABLED, no-store, before any limiter', async () => {
    for (const [method, path] of NATIVE_REQUESTS) {
      const res = await request(server)[method](path).send({});
      assert.equal(res.status, 404, `${method.toUpperCase()} ${path} → ${res.status}`);
      assert.equal(res.body.code, 'NATIVE_AUTH_DISABLED', `${path}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.status, 'fail');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-ratelimit-limit'], undefined, `${path} ran a limiter while disabled`);
    }
  });

  it('GET /config also says enabled:false (the frontend falls back to the legacy page)', async () => {
    const res = await request(server).get('/api/auth/native/config');
    assert.deepEqual(res.body.data, { enabled: false });
    const withBearer = await request(server).get('/api/auth/native/identities').set('Authorization', 'Bearer x');
    assert.equal(withBearer.status, 404, 'no auth check runs while disabled');
  });

  it('the JWKS path falls through exactly like an unknown sibling path when no key is configured', async () => {
    const jwks = await request(server).get('/.well-known/ddc-auth/jwks.json');
    const sibling = await request(server).get('/.well-known/ddc-auth/other.json');
    assert.equal(jwks.status, sibling.status);
    assert.equal(jwks.headers['content-type'], sibling.headers['content-type']);
    assert.equal(jwks.text.replace('jwks.json', 'X'), sibling.text.replace('other.json', 'X'));
    assert.equal(jwks.headers['cache-control'], sibling.headers['cache-control']);
  });

  it('neighbouring routes are unchanged', async () => {
    const exchange = await request(server).post('/api/sso/ticket/exchange').send({});
    assert.equal(exchange.status, 400);
    assert.equal(exchange.body.code, 'TICKET_INVALID');
    const crawler = await request(server).get('/api/crawler-tasks');
    assert.equal(crawler.status, 401);
    const register = await request(server).post('/api/auth/register').send({});
    assert.notEqual(register.status, 404);
    assert.equal(register.headers['x-ratelimit-limit'], '5', 'the legacy auth limiter still runs on register');
  });
});

describe('native login with DDC_AUTH_ENABLED on', () => {
  it('GET /config answers LoginConfig, no-store', async () => {
    setEnv(localEnv(key, { DDC_AUTH_METHODS: 'google', DDC_AUTH_GOOGLE_CLIENT_IDS: 'web-id,ios-id', DDC_AUTH_GOOGLE_AZP_IDS: 'web-id' }));
    const res = await request(server).get('/api/auth/native/config');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'success');
    assert.equal(res.body.data.enabled, true);
    assert.deepEqual(res.body.data.methods.google, { web: true, ios: true, android: true });
    assert.deepEqual(res.body.data.methods.email, { web: false, ios: false, android: false });
    assert.equal(res.body.data.web3auth.verifier, 'ddc-jwt-devnet');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('a method that is off answers 404 METHOD_DISABLED; an on method reaches its (stub) handler', async () => {
    setEnv(localEnv(key, { DDC_AUTH_METHODS: 'google', DDC_AUTH_GOOGLE_CLIENT_IDS: 'w', DDC_AUTH_GOOGLE_AZP_IDS: 'w' }));
    for (const [method, path] of [['post', '/api/auth/native/email/start'], ['post', '/api/auth/native/apple'], ['get', '/api/auth/native/x/start']]) {
      const res = await request(server)[method](path).send({});
      assert.equal(res.status, 404, `${path} → ${res.status}`);
      assert.equal(res.body.code, 'METHOD_DISABLED');
    }
    const google = await request(server).post('/api/auth/native/google').send({});
    assert.equal(google.status, 501);
    assert.equal(google.body.code, 'NOT_IMPLEMENTED');
    const nonce = await request(server).post('/api/auth/native/nonce').send({ purpose: 'google' });
    assert.equal(nonce.status, 501);
    assert.equal(nonce.headers['x-ratelimit-limit'], '30', 'nativeIdp limiter runs');
  });

  it('/token and /complete are reached ahead of every protecting /api router', async () => {
    setEnv(localEnv(key));
    for (const path of ['/api/auth/native/token', '/api/auth/native/complete']) {
      const res = await request(server).post(path).send({});
      assert.equal(res.status, 501, `${path} → ${res.status} ${JSON.stringify(res.body)}`);
    }
  });

  it('identities require a user session', async () => {
    setEnv(localEnv(key));
    const res = await request(server).get('/api/auth/native/identities');
    assert.equal(res.status, 401);
  });

  it('the JWKS route serves the pinned public key', async () => {
    setEnv(localEnv(key));
    const res = await request(server).get('/.well-known/ddc-auth/jwks.json');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
    assert.deepEqual(res.body.keys.map((k) => k.kid), [key.thumbprint]);
  });
});
