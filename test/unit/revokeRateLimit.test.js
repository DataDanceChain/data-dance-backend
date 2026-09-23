/**
 * /oauth/revoke rate limiting on the REAL src/app — same model as /oauth/token (a776284).
 *
 * A partner that revokes on every user logout does so from ONE server IP; a 20/min per-IP budget
 * made the 21st logout of any minute, campaign-wide, a 429. Required:
 *   - verified confidential revocations never spend the per-IP budget;
 *   - unauthenticated and wrong-secret attempts stay limited per IP (20/min);
 *   - a per-client ceiling (OAUTH_TOKEN_CLIENT_MAX_PER_MIN, its own bucket) catches runaway loops,
 *     and only verified credentials can spend it.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const SECRET = 'tge-secret-dev';
Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update(SECRET).digest('hex'),
  SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/oauth/callback',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'ddc-user-session-secret',
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
});
delete process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN;

const app = require('../../src/app');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

function revoke({ token = `ddc_tge_${crypto.randomBytes(16).toString('hex')}`, auth = basic('tge-test', SECRET), ip } = {}) {
  const r = request(app).post('/oauth/revoke').type('form');
  if (auth) r.set('Authorization', auth);
  if (ip) r.set('X-Forwarded-For', ip);
  return r.send({ token, token_type_hint: 'access_token' });
}

describe('/oauth/revoke limiting', () => {
  beforeEach(() => {
    clearRateLimitStore();
    prisma.reset();
    delete process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN;
  });
  afterEach(() => delete process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN);

  it('30 authenticated partner revocations from ONE IP within a minute all succeed', async () => {
    const statuses = [];
    for (let i = 0; i < 30; i++) statuses.push((await revoke()).status);
    assert.deepEqual([...new Set(statuses)], [200], `statuses: ${statuses.join(' ')}`);
  });

  it('wrong secrets and unauthenticated attempts stay limited per IP (20 per minute)', async () => {
    const statuses = [];
    for (let i = 0; i < 20; i++) statuses.push((await revoke({ auth: basic('tge-test', `wrong-${i}`), ip: '203.0.113.9' })).status);
    assert.deepEqual([...new Set(statuses)], [401]);
    const over = await revoke({ auth: basic('tge-test', 'wrong-x'), ip: '203.0.113.9' });
    assert.equal(over.status, 429);
    assert.equal(over.body.error, 'slow_down');
    assert.equal((await revoke({ auth: null, ip: '203.0.113.9' })).status, 429, 'unauthenticated shares that IP budget');
    assert.equal((await revoke({ ip: '203.0.113.9' })).status, 200, 'the verified partner is not locked out by an attacker on its IP');
  });

  it('a per-client ceiling stops a runaway loop of VERIFIED revocations, in its own bucket', async () => {
    process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN = '5';
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await revoke({ ip: `198.51.100.${i}` })).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    const tokenReq = await request(app).post('/oauth/token').type('form').set('Authorization', basic('tge-test', SECRET))
      .send({ grant_type: 'authorization_code', code: 'ddc_code_x', code_verifier: 'v'.repeat(43), redirect_uri: 'https://tge.example.com/oauth/callback' });
    assert.equal(tokenReq.status, 400, 'logouts must not spend the login (token) budget');
  });
});
