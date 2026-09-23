/**
 * Mount order of the REAL application (src/app.js), not a hand-assembled express() app.
 *
 * Every other SSO test mounts the routers it needs on a fresh express(); that is exactly how a
 * router-wide `router.use(protect)` in an earlier `/api` router (crawlerRoutes) stayed invisible
 * while it answered 401 for the public ticket exchange and for every SSO-session request. This
 * file loads src/app itself so the composition is what is under test.
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

const SECRET_HASH = crypto.createHash('sha256').update('tge-secret-dev').digest('hex');
const JWT_SECRET = 'ddc-user-session-secret';
const SSO_SESSION_SECRET = 'ddc-sso-session-secret-different';

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
  SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
  SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/oauth/callback',
  SSO_TGE_INITIATE_LOGIN_URI: 'https://tge.example.com/login/ddc',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET,
  SSO_SESSION_SECRET,
});

const app = require('../../src/app');

// A loopback-bound server for supertest (see test/helpers/loopbackServer.js).
let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));
const { signSsoSession } = require('../../src/routes/ssoRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

const user = {
  id: 'user-mount-1',
  email: 'mount@example.com',
  isOrganization: false,
  userType: 'regular',
  disabledAt: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

function pendingRequest(id) {
  return {
    id,
    clientId: 'tge-test',
    redirectUri: 'https://tge.example.com/oauth/callback',
    state: 's'.repeat(24),
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    resource: 'https://api.test.local/partner/tge',
    scope: 'tge:identity',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    consumedAt: null,
    codeHash: null,
    initiatorHash: null,
    initiatorMismatchCount: 0,
  };
}

describe('src/app mount order', () => {
  before(() => {
    assert.equal(typeof app, 'function', 'src/app must export the express application');
  });

  beforeEach(() => {
    clearRateLimitStore();
    prisma._reset?.();
    prisma.user.rows.splice(0, prisma.user.rows.length, { ...user });
    prisma.oAuthAuthorization.rows.splice(0, prisma.oAuthAuthorization.rows.length, pendingRequest('req-mount-1'));
  });

  it('an unauthenticated POST /api/sso/ticket/exchange reaches its handler (400 TICKET_INVALID, not 401)', async () => {
    const res = await request(server).post('/api/sso/ticket/exchange').send({});
    assert.equal(res.status, 400, `got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'TICKET_INVALID');
  });

  it('an SSO-session bearer on GET /api/oauth/requests/:id reaches its handler', async () => {
    const { token } = signSsoSession({ userId: user.id, clientId: 'tge-test', jti: 'j-1' });
    const res = await request(server).get('/api/oauth/requests/req-mount-1').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200, `got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.id, 'req-mount-1');
    assert.equal(res.body.data.clientId, 'tge-test');
  });

  it('an SSO-session bearer on POST /api/oauth/consent reaches its handler', async () => {
    const { token } = signSsoSession({ userId: user.id, clientId: 'tge-test', jti: 'j-2' });
    const res = await request(server)
      .post('/api/oauth/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ requestId: 'req-mount-1', allow: false });
    assert.equal(res.status, 200, `got ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body.data.redirectTo, /^https:\/\/tge\.example\.com\/oauth\/callback\?error=access_denied/);
  });

  it('an expired SSO session is answered by the consent principal (SSO_SESSION_EXPIRED), not by a generic 401', async () => {
    const { token } = signSsoSession({ userId: user.id, clientId: 'tge-test', jti: 'j-3' }, { ttlSec: 1, now: Date.now() - 60_000 });
    const res = await request(server).get('/api/oauth/requests/req-mount-1').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'SSO_SESSION_EXPIRED');
  });

  it('the consent request summary stays readable without a credential', async () => {
    const res = await request(server).get('/api/oauth/requests/req-mount-1');
    assert.equal(res.status, 200, `got ${res.status} ${JSON.stringify(res.body)}`);
  });

  it('crawler endpoints still demand a user JWT', async () => {
    for (const [method, path] of [['get', '/api/crawler-tasks'], ['post', '/api/crawler-tasks']]) {
      const res = await request(server)[method](path).send({});
      assert.equal(res.status, 401, `${method.toUpperCase()} ${path} → ${res.status}`);
    }
    const { token } = signSsoSession({ userId: user.id, clientId: 'tge-test', jti: 'j-4' });
    const withSession = await request(server).get('/api/crawler-tasks').set('Authorization', `Bearer ${token}`);
    assert.equal(withSession.status, 401, 'an SSO session must not open a first-party endpoint');
    const userJwt = jwt.sign({ id: user.id, ver: 2 }, JWT_SECRET, { expiresIn: '5m' });
    const ok = await request(server).get('/api/crawler-tasks').set('Authorization', `Bearer ${userJwt}`);
    assert.notEqual(ok.status, 401, 'a user JWT must still be accepted by the crawler routes');
  });

  it('the consent limiter stays per user: one user exhausting it does not throttle another from the same IP', async () => {
    const other = { ...user, id: 'user-mount-2', email: 'mount2@example.com' };
    prisma.user.rows.push(other);
    const a = jwt.sign({ id: user.id, ver: 2 }, JWT_SECRET, { expiresIn: '5m' });
    const b = jwt.sign({ id: other.id, ver: 2 }, JWT_SECRET, { expiresIn: '5m' });
    for (let i = 0; i < 10; i++) {
      await request(server).post('/api/oauth/consent').set('Authorization', `Bearer ${a}`).send({ requestId: `nope-${i}`, allow: false });
    }
    const aOver = await request(server).post('/api/oauth/consent').set('Authorization', `Bearer ${a}`).send({ requestId: 'nope-x', allow: false });
    assert.equal(aOver.status, 429, 'the 11th decision of one user within a minute is limited');
    const bFirst = await request(server).post('/api/oauth/consent').set('Authorization', `Bearer ${b}`).send({ requestId: 'nope-y', allow: false });
    assert.notEqual(bFirst.status, 429, 'another user on the same IP is not');
  });
});
