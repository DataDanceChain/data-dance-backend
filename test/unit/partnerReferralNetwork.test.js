/**
 * GET /partner/tge/referral-network on the REAL src/app (scope tge:referral_network).
 *
 * Gates in order: 401 without a partner token → 404 {"error":"not_available"} where the environment
 * does not list `referral_network` in SSO_TGE_STATUS_FIELDS → 403 insufficient_scope without the scope
 * → 403 account_disabled. Plus: the scope is advertised, echoed by /oauth/token and listed as the
 * consent item `referral_network`; `Cache-Control: private, max-age=60`; one G6 access record with the
 * node count; `?sub=` is refused; a node never carries more than its four fields.
 * The graph walk itself is stubbed here (the SQL runs on Postgres in test/db/).
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

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
  SSO_TGE_STATUS_FIELDS: 'registered_at,wallet_bound,referral,referral_network',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'ddc-user-session-secret',
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;

const app = require('../../src/app');
const { startAuthorization, decideConsent, getConsentRequest, issuedTokensByCode } = require('../../src/services/oauthService');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { accessLog } = require('../../src/routes/partnerTgeRoutes');
const net = require('../../src/services/referralNetwork');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const user = { id: 'user-net-1', email: 'net@example.com', isOrganization: false, userType: 'regular', disabledAt: null, createdAt: new Date('2025-01-01T00:00:00Z'), referralCode: 'AB23CD' };
const basic = `Basic ${Buffer.from(`tge-test:${SECRET}`).toString('base64')}`;
const EXTRA_KEY_PROBE = { set: false };

// Stub graph: user-net-1 invited d1, d2; d1 invited dd1. u1 invited user-net-1.
net.source.loadUpline = async () => [{ sub: 'u1', invited_at: new Date('2025-01-02T00:00:00Z'), depth: 1, cycle: false, path: ['user-net-1', 'u1'] }];
const DOWN = () => [
  { sub: 'd1', inviter_sub: 'user-net-1', invited_at: '2025-02-01T00:00:00.000Z', depth: 1 },
  { sub: 'd2', inviter_sub: 'user-net-1', invited_at: '2025-02-02T00:00:00.000Z', depth: 1 },
  { sub: 'dd1', inviter_sub: 'd1', invited_at: '2025-03-01T00:00:00.000Z', depth: 2 },
];
net.source.loadDownlineAggregate = async () => [{ depth: 1, count: 2, cycle_paths: [] }, { depth: 2, count: 1, cycle_paths: [] }];
const keyCmp = (a, b) => (a.depth - b.depth) || (a.invited_at < b.invited_at ? -1 : a.invited_at > b.invited_at ? 1 : 0) || (a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0);
net.source.loadDownlinePage = async (userId, asOf, { after, limit }) => {
  const rows = DOWN()
    .filter((r) => !after || keyCmp(r, { depth: after.depth, invited_at: after.invitedAt, sub: after.sub }) > 0)
    .slice(0, limit);
  // What a careless SQL change would do: select more columns. The node must still carry four.
  if (EXTRA_KEY_PROBE.set) for (const r of rows) Object.assign(r, { email: 'leak@example.com', name: 'Leak', totalPoints: 99 });
  return rows;
};

async function mintToken(scope) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const consentUrl = await startAuthorization({ get: () => '' }, {
    response_type: 'code', client_id: 'tge-test', redirect_uri: REDIRECT, scope,
    state: crypto.randomBytes(18).toString('base64url'), code_challenge: challenge, code_challenge_method: 'S256',
  });
  const requestId = new URL(consentUrl).searchParams.get('request');
  const summary = await getConsentRequest(requestId);
  const redirectTo = await decideConsent(user, requestId, true, { kind: 'user_jwt', claims: { ver: 2 } });
  const code = new URL(redirectTo).searchParams.get('code');
  const res = await request(server).post('/oauth/token').type('form').set('Authorization', basic)
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(res.status, 200, res.text);
  return { token: res.body.access_token, tokenScope: res.body.scope, scopeItems: summary.scopeItems };
}

const network = (token, query = '') => request(server).get(`/partner/tge/referral-network${query}`).set('Authorization', `Bearer ${token}`);

describe('GET /partner/tge/referral-network', () => {
  beforeEach(() => {
    net.clearAggregateCache();
    clearRateLimitStore();
    prisma.reset();
    issuedTokensByCode.clear();
    prisma.user.rows.push({ ...user });
    process.env.SSO_TGE_STATUS_FIELDS = 'registered_at,wallet_bound,referral,referral_network';
    EXTRA_KEY_PROBE.set = false;
  });

  it('the scope is advertised, echoed by /oauth/token and shown on consent as `referral_network`', async () => {
    const meta = await request(server).get('/.well-known/oauth-authorization-server');
    assert.ok(meta.body.scopes_supported.includes('tge:referral_network'));
    const { tokenScope, scopeItems } = await mintToken('tge:identity tge:referral_network');
    assert.equal(tokenScope, 'tge:identity tge:referral_network');
    assert.deepEqual(scopeItems, ['identity', 'referral_network']);
  });

  it('200 with the contract shape, Cache-Control private max-age=60, and one G6 record with the node count', async () => {
    const { token } = await mintToken('tge:identity tge:referral_network');
    const entries = [];
    const original = accessLog.write;
    accessLog.write = (e) => entries.push(e);
    let res;
    try {
      res = await network(token);
    } finally {
      accessLog.write = original;
    }
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers['cache-control'], 'private, max-age=60');
    assert.equal(res.body.sub, user.id);
    assert.equal(res.body.cache_max_age, 60);
    assert.deepEqual(res.body.upline, [{ sub: 'u1', depth: 1, invited_at: '2025-01-02T00:00:00.000Z' }]);
    assert.equal(res.body.downline.total, 3);
    assert.deepEqual(res.body.downline.levels, [{ depth: 1, count: 2 }, { depth: 2, count: 1 }]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].endpoint, 'referral-network');
    assert.equal(entries[0].nodeCount, 3);
    assert.equal(entries[0].total, 3);
  });

  it('a node carries exactly four fields even if the query ever selects more', async () => {
    const { token } = await mintToken('tge:referral_network');
    EXTRA_KEY_PROBE.set = true;
    const res = await network(token);
    assert.equal(res.status, 200);
    for (const n of res.body.downline.nodes) assert.deepEqual(Object.keys(n).sort(), ['depth', 'invited_at', 'inviter_sub', 'sub'], JSON.stringify(n));
    assert.ok(!res.text.includes('leak@example.com') && !res.text.includes('"name"') && !res.text.includes('totalPoints'));
  });

  it('401 without a token; 404 not_available where the environment does not serve it; 403 without the scope', async () => {
    assert.equal((await request(server).get('/partner/tge/referral-network')).status, 401);
    const withScope = (await mintToken('tge:identity tge:referral_network')).token;
    const withoutScope = (await mintToken('tge:identity tge:status')).token;
    const noScope = await network(withoutScope);
    assert.equal(noScope.status, 403);
    assert.equal(noScope.body.error, 'insufficient_scope');
    process.env.SSO_TGE_STATUS_FIELDS = 'registered_at,wallet_bound';
    const notServed = await network(withScope);
    assert.equal(notServed.status, 404);
    assert.equal(notServed.body.error, 'not_available');
    assert.equal((await network(withoutScope)).status, 404, '"not served here" is answered before "not granted"');
  });

  it('403 account_disabled; ?sub= refused; bad limit / as_of / cursor are 400 invalid_request', async () => {
    const { token } = await mintToken('tge:referral_network');
    assert.equal((await network(token, '?sub=someone-else')).status, 400);
    for (const q of ['?limit=0', '?limit=2001', '?as_of=2999-01-01T00:00:00Z', '?as_of=nope', '?cursor=garbage']) {
      const r = await network(token, q);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error, 'invalid_request', q);
    }
    prisma.user.rows[0].disabledAt = new Date();
    const disabled = await network(token);
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.error, 'account_disabled');
  });

  it('pages with ?limit and ?cursor: union = total, no duplicates', async () => {
    const { token } = await mintToken('tge:referral_network');
    const seen = [];
    let res = await network(token, '?limit=2');
    seen.push(...res.body.downline.nodes.map((n) => n.sub));
    while (res.body.downline.next_cursor) {
      res = await network(token, `?limit=2&cursor=${encodeURIComponent(res.body.downline.next_cursor)}`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.downline.total, 3);
      seen.push(...res.body.downline.nodes.map((n) => n.sub));
    }
    assert.deepEqual(seen, ['d1', 'd2', 'dd1']);
  });
});
