/**
 * /oauth/token rate limiting on the REAL src/app (A4).
 *
 * The partner exchanges every user's authorization code from ONE server IP. When its authenticated
 * exchanges spent the 20/min per-IP budget, the 21st login of the minute — campaign-wide — got
 * `429 slow_down`. Required now:
 *   - verified confidential exchanges never spend the per-IP budget (successes or invalid_grant);
 *   - unauthenticated attempts and wrong secrets stay per-IP limited (brute-force protection);
 *   - a per-client_id ceiling (OAUTH_TOKEN_CLIENT_MAX_PER_MIN, default 3000) catches runaway loops,
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
const REDIRECT = 'https://tge.example.com/oauth/callback';
Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update(SECRET).digest('hex'),
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'ddc-user-session-secret',
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
delete process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN;

const app = require('../../src/app');
const { startAuthorization, decideConsent, issuedTokensByCode } = require('../../src/services/oauthService');
const { clearRateLimitStore, tokenClientMaxPerMinute } = require('../../src/middlewares/rateLimitMiddleware');

const user = { id: 'user-tok-1', email: 'tok@example.com', isOrganization: false, userType: 'regular', disabledAt: null, createdAt: new Date() };
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

async function mintCode() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const consent = await startAuthorization({ get: () => '' }, {
    response_type: 'code', client_id: 'tge-test', redirect_uri: REDIRECT, scope: 'tge:identity',
    state: crypto.randomBytes(18).toString('base64url'), code_challenge: challenge, code_challenge_method: 'S256',
  });
  const requestId = new URL(consent).searchParams.get('request');
  const redirectTo = await decideConsent(user, requestId, true, { kind: 'user_jwt', claims: { ver: 2 } });
  return { code: new URL(redirectTo).searchParams.get('code'), verifier };
}

function exchange({ code, verifier, auth = basic('tge-test', SECRET), ip }) {
  const r = request(app).post('/oauth/token').type('form');
  if (auth) r.set('Authorization', auth);
  if (ip) r.set('X-Forwarded-For', ip);
  return r.send({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
}

describe('/oauth/token limiting', () => {
  beforeEach(() => {
    clearRateLimitStore();
    prisma.reset();
    issuedTokensByCode.clear();
    prisma.user.rows.push({ ...user });
    delete process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN;
  });
  afterEach(() => delete process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN);

  it('the ceiling defaults to 3000 per minute and reads OAUTH_TOKEN_CLIENT_MAX_PER_MIN', () => {
    assert.equal(tokenClientMaxPerMinute({}), 3000);
    assert.equal(tokenClientMaxPerMinute({ OAUTH_TOKEN_CLIENT_MAX_PER_MIN: '120' }), 120);
    assert.equal(tokenClientMaxPerMinute({ OAUTH_TOKEN_CLIENT_MAX_PER_MIN: 'nonsense' }), 3000);
  });

  it('30 successful partner exchanges from ONE IP within a minute all succeed', async () => {
    const statuses = [];
    for (let i = 0; i < 30; i++) {
      const { code, verifier } = await mintCode();
      const res = await exchange({ code, verifier });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.filter((s) => s !== 200), [], `statuses: ${statuses.join(' ')}`);
  });

  it("the partner's own invalid_grant answers do not spend the per-IP budget either", async () => {
    const statuses = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await exchange({ code: `ddc_code_nope_${i}`, verifier: 'v'.repeat(43) })).status);
    }
    assert.deepEqual([...new Set(statuses)], [400], `statuses: ${statuses.join(' ')}`);
    const { code, verifier } = await mintCode();
    assert.equal((await exchange({ code, verifier })).status, 200, 'a genuine exchange right after still succeeds');
  });

  it('wrong secrets and unauthenticated attempts stay limited per IP (20 per minute)', async () => {
    const statuses = [];
    for (let i = 0; i < 20; i++) {
      statuses.push((await exchange({ code: 'x', verifier: 'v'.repeat(43), auth: basic('tge-test', `wrong-${i}`), ip: '203.0.113.7' })).status);
    }
    assert.deepEqual([...new Set(statuses)], [401]);
    const over = await exchange({ code: 'x', verifier: 'v'.repeat(43), auth: basic('tge-test', 'wrong-x'), ip: '203.0.113.7' });
    assert.equal(over.status, 429);
    assert.equal(over.body.error, 'slow_down');
    const unauth = await exchange({ code: 'x', verifier: 'v'.repeat(43), auth: null, ip: '203.0.113.7' });
    assert.equal(unauth.status, 429, 'an unauthenticated attempt from the same IP shares that budget');
    const partner = await exchange({ code: 'ddc_code_nope', verifier: 'v'.repeat(43), ip: '203.0.113.7' });
    assert.equal(partner.status, 400, 'the verified partner is not locked out by an attacker on its IP');
  });

  it('a per-client ceiling stops a runaway loop of VERIFIED requests', async () => {
    process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN = '5';
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await exchange({ code: `ddc_code_loop_${i}`, verifier: 'v'.repeat(43), ip: `198.51.100.${i}` })).status);
    assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429], 'spread over IPs: only the client ceiling applies');
  });

  it('only verified credentials can spend the client ceiling', async () => {
    process.env.OAUTH_TOKEN_CLIENT_MAX_PER_MIN = '5';
    for (let i = 0; i < 10; i++) {
      await exchange({ code: 'x', verifier: 'v'.repeat(43), auth: basic('tge-test', 'wrong'), ip: `192.0.2.${i}` });
    }
    const { code, verifier } = await mintCode();
    assert.equal((await exchange({ code, verifier })).status, 200);
  });
});
