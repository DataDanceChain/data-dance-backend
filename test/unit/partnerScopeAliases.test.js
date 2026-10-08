/**
 * An existing TGE integration that still sends the old `tge:*` scope names keeps working after the
 * tge:* -> sso:* rename. Runs on the REAL src/app, without a database (test/helpers/mockPrisma).
 *
 * The server treats `tge:X` as an alias of `sso:X` (canonicalPartnerScope). A request may use either
 * name, the grant is the same permission, and every response names it `sso:X`. RFC 6749 §3.3 allows
 * a token response whose scope differs from the requested one; the client then reads the `scope`
 * parameter. Pinned here:
 * - authorize with tge:identity tge:status, and tge:referral_network / tge:referral_bind when
 *   switched on, is accepted and grants exactly what the sso:* names grant;
 * - the token response names the scopes sso:*;
 * - that token reads /partner/tge/* and /partner/sso/* alike, and opens nothing it was not granted;
 * - an unknown tge:foo is invalid_scope, like any unknown scope;
 * - a token issued before the rename (prefix ddc_tge_, audience /partner/tge, tge:* scope string)
 *   still verifies on both paths.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();
// `protect` constructs its own PrismaClient at load; route it to the same in-memory store.
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const SECRET = 'scope-alias-client-secret';
const REDIRECT = 'https://tge.example.com/oauth/callback';
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
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update(SECRET).digest('hex'),
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  SSO_TGE_STATUS_FIELDS: 'registered_at,wallet_bound,referral_network',
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'scope-alias-jwt-key',
  SSO_SESSION_SECRET: 'scope-alias-session-key',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
delete process.env.SSO_TGE_REFERRAL_BIND;

const app = require('../../src/app');
const { startAuthorization, decideConsent, issuedTokensByCode } = require('../../src/services/oauthService');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const user = {
  id: 'user-alias-1',
  email: 'alias@example.com',
  isOrganization: false,
  userType: 'regular',
  disabledAt: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  referralCode: 'AL23AS',
  walletAddress: null,
};
const basic = `Basic ${Buffer.from(`tge-test:${SECRET}`).toString('base64')}`;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function authorize(scope, challenge = crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url')) {
  return startAuthorization({ get: () => '' }, {
    response_type: 'code', client_id: 'tge-test', redirect_uri: REDIRECT, scope,
    state: crypto.randomBytes(18).toString('base64url'), code_challenge: challenge, code_challenge_method: 'S256',
  });
}

async function mintToken(scope) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const consentUrl = await authorize(scope, crypto.createHash('sha256').update(verifier).digest('base64url'));
  const requestId = new URL(consentUrl).searchParams.get('request');
  const redirectTo = await decideConsent(user, requestId, true, { kind: 'user_jwt', claims: { ver: 2 } });
  const code = new URL(redirectTo).searchParams.get('code');
  const res = await request(server).post('/oauth/token').type('form').set('Authorization', basic)
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(res.status, 200, res.text);
  return { token: res.body.access_token, tokenScope: res.body.scope };
}

const get = (path, token) => request(server).get(path).set('Authorization', `Bearer ${token}`);

beforeEach(() => {
  clearRateLimitStore();
  prisma.reset();
  issuedTokensByCode.clear();
  prisma.user.rows.push({ ...user });
  delete process.env.SSO_TGE_REFERRAL_BIND;
});

describe('an integration that still sends the tge:* scope names', () => {
  it('tge:identity tge:status is accepted, and the token response names the grant sso:*', async () => {
    const { token, tokenScope } = await mintToken('tge:identity tge:status');
    assert.match(token, /^ddc_sso_/);
    assert.equal(tokenScope, 'sso:identity sso:status');
  });

  it('the old names grant exactly what the sso:* names grant', async () => {
    for (const [old, canonical] of [
      ['tge:identity', 'sso:identity'],
      ['tge:status tge:identity', 'sso:identity sso:status'],
      ['tge:identity sso:status', 'sso:identity sso:status'],
      ['tge:identity tge:status tge:email tge:wallet tge:points tge:referral', 'sso:identity sso:status sso:email sso:wallet sso:points sso:referral'],
    ]) {
      const viaOld = await mintToken(old);
      const viaNew = await mintToken(canonical);
      assert.equal(viaOld.tokenScope, canonical, old);
      assert.equal(viaNew.tokenScope, canonical, canonical);
    }
  });

  it('tge:referral_network, and tge:referral_bind once SSO_TGE_REFERRAL_BIND is on, are accepted', async () => {
    assert.equal((await mintToken('tge:identity tge:referral_network')).tokenScope, 'sso:identity sso:referral_network');
    process.env.SSO_TGE_REFERRAL_BIND = 'true';
    const { tokenScope } = await mintToken('tge:identity tge:referral_network tge:referral_bind');
    assert.equal(tokenScope, 'sso:identity sso:referral_network sso:referral_bind');
  });

  it('with the switch off, tge:referral_bind is refused exactly like sso:referral_bind', async () => {
    for (const scope of ['tge:identity tge:referral_bind', 'tge:identity sso:referral_bind']) {
      await assert.rejects(
        authorize(scope),
        (e) => e.error === 'invalid_scope' && /^Scope not available in this environment: sso:referral_bind\.$/.test(e.description),
        scope,
      );
    }
  });

  it('an unknown tge:foo is invalid_scope, like any unknown scope', async () => {
    for (const scope of ['tge:foo', 'tge:identity tge:foo']) {
      await assert.rejects(authorize(scope), (e) => e.error === 'invalid_scope' && /Unknown scope: sso:foo/.test(e.description), scope);
    }
    await assert.rejects(authorize('sso:foo'), (e) => e.error === 'invalid_scope');
  });

  it('the token reads /partner/tge/* and /partner/sso/* alike', async () => {
    const { token } = await mintToken('tge:identity tge:status');
    const meOld = await get('/partner/tge/me', token);
    const meNew = await get('/partner/sso/me', token);
    assert.equal(meOld.status, 200, meOld.text);
    assert.equal(meNew.status, 200, meNew.text);
    assert.equal(meNew.body.sub, user.id);
    assert.deepEqual(meOld.body, meNew.body);
    const statusOld = await get('/partner/tge/status', token);
    const statusNew = await get('/partner/sso/status', token);
    assert.equal(statusOld.status, 200, statusOld.text);
    assert.equal(statusNew.status, 200, statusNew.text);
    // `as_of` is when each answer was produced; everything else must match.
    const withoutAsOf = ({ as_of: asOf, ...rest }) => {
      assert.match(asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      return rest;
    };
    assert.deepEqual(withoutAsOf(statusOld.body), withoutAsOf(statusNew.body));
  });

  it('and opens nothing it was not granted: no status scope is 403 insufficient_scope on both paths', async () => {
    const { token } = await mintToken('tge:identity');
    for (const path of ['/partner/tge/status', '/partner/sso/status']) {
      const res = await get(path, token);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error, 'insufficient_scope');
      assert.match(res.headers['www-authenticate'], /scope="sso:status"/);
    }
  });
});

describe('a token issued before the rename', () => {
  it('prefix ddc_tge_, audience /partner/tge and a tge:* scope string still verify on both paths', async () => {
    const token = `ddc_tge_${crypto.randomBytes(32).toString('base64url')}`;
    await prisma.mcpToken.create({
      data: {
        id: 'legacy-partner-token',
        userId: user.id,
        tokenHash: sha256(token),
        tokenPrefix: token.slice(0, 12),
        label: 'TGE',
        source: 'partner',
        clientId: 'tge-test',
        resource: `${ISSUER}/partner/tge`,
        scope: 'tge:identity tge:status',
        expiresAt: new Date(Date.now() + 300 * 1000),
        createdAt: new Date(),
      },
    });
    for (const path of ['/partner/tge/me', '/partner/sso/me', '/partner/tge/status', '/partner/sso/status']) {
      const res = await get(path, token);
      assert.equal(res.status, 200, `${path}: ${res.text}`);
    }
    // Its old scope string still opens only what it named.
    const network = await get('/partner/sso/referral-network', token);
    assert.equal(network.status, 403);
    assert.equal(network.body.error, 'insufficient_scope');
  });
});
