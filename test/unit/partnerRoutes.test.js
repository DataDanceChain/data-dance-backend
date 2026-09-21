const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

// authMiddleware builds its own PrismaClient when it loads; point it at the same in-memory store
// so `protect` — and therefore POST /api/oauth/consent — can be exercised through the router.
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: class PrismaClient {
    constructor() {
      return prisma;
    }
  },
};

const SECRET = 'tge-secret-dev';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const REDIRECT = 'https://tge.example.com/oauth/callback';
const ISSUER = 'https://api.test.local';
const PARTNER_RESOURCE = `${ISSUER}/partner/tge`;

Object.assign(process.env, {
  LOG_LEVEL: 'error',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_NAME: 'DDC TGE',
  SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  SSO_TGE_STATUS_FIELDS: 'registered_at,wallet_bound,data_licence_granted',
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'test-jwt-secret-partner-routes',
  JWT_EXPIRES_IN: '1h',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;

const oauthRoutes = require('../../src/routes/oauthRoutes');
const { generateToken } = require('../../src/utils/jwtUtils');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const partnerTgeRoutes = require('../../src/routes/partnerTgeRoutes');
const { decideConsent, issuedTokensByCode } = require('../../src/services/oauthService');
const { issueMcpToken } = require('../../src/services/mcpTokenService');
const { DATA_LICENCE_POLICY_VERSION } = require('../../src/constants/dataLicence');
const { PARTNER_SCOPES, STATUS_FIELD_CATALOG } = require('../../src/constants/partnerClient');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/partner/tge', partnerTgeRoutes);
app.use('/', oauthRoutes);

const user = { id: 'user-1', email: 'sloan@example.com', isOrganization: false, userType: 'regular', createdAt: new Date('2025-05-03T09:12:44Z'), walletAddress: '0xabc', referralCode: 'AB23CD', totalPoints: 1234.5 };
const basic = (id = 'tge-test', secret = SECRET) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeQuery(overrides = {}) {
  return {
    response_type: 'code',
    client_id: 'tge-test',
    redirect_uri: REDIRECT,
    state: 'state-with-enough-entropy-1234',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
    ...overrides,
  };
}

/** Browser + Wallet steps done directly against the service; returns { code, verifier }. */
async function mintCode(scope) {
  const { verifier, challenge } = pkce();
  const res = await request(app).get('/oauth/authorize').query(authorizeQuery({ code_challenge: challenge, scope }));
  assert.equal(res.status, 302, res.text);
  const requestId = new URL(res.headers.location).searchParams.get('request');
  const redirectTo = await decideConsent(user, requestId, true, { kind: 'user_jwt' });
  return { code: new URL(redirectTo).searchParams.get('code'), verifier };
}

async function mintToken(scope = 'tge:identity tge:status') {
  const { code, verifier } = await mintCode(scope);
  const res = await request(app).post('/oauth/token').set('Authorization', basic()).type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
  });
  assert.equal(res.status, 200, res.text);
  return res.body.access_token;
}

beforeEach(() => {
  prisma.reset();
  issuedTokensByCode.clear();
  process.env.SSO_TGE_ENABLED = 'true';
  prisma.user.rows.push({ ...user });
});

describe('discovery', () => {
  it('serves AS metadata and the partner protected-resource document', async () => {
    const as = await request(app).get('/.well-known/oauth-authorization-server');
    assert.equal(as.status, 200);
    assert.equal(as.body.issuer, ISSUER);
    assert.equal(as.body.authorization_response_iss_parameter_supported, true);
    assert.ok(as.body.token_endpoint_auth_methods_supported.includes('client_secret_basic'));
    assert.ok(as.body.token_endpoint_auth_methods_supported.includes('client_secret_post'));
    const pr = await request(app).get('/.well-known/oauth-protected-resource/partner/tge');
    assert.equal(pr.status, 200);
    assert.equal(pr.body.resource, PARTNER_RESOURCE);
    assert.deepEqual(pr.body.scopes_supported, [...PARTNER_SCOPES]);
  });
});

describe('GET /oauth/authorize', () => {
  it('unknown client → 400 HTML page, no redirect (T08)', async () => {
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery({ client_id: 'nobody' }));
    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers.location, undefined);
    assert.match(res.text, /invalid_client/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('valid client + non-exact redirect_uri → 400 HTML page (T08); disabled client → 400 page', async () => {
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery({ redirect_uri: `${REDIRECT}?x=1` }));
    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /not registered/);
    process.env.SSO_TGE_ENABLED = 'false';
    const off = await request(app).get('/oauth/authorize').query(authorizeQuery());
    assert.equal(off.status, 400);
    assert.match(off.text, /unauthorized_client/);
  });

  it('escapes attacker-controlled text on the error page', async () => {
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery({ client_id: '<script>alert(1)</script>' }));
    assert.equal(res.status, 400);
    assert.equal(res.text.includes('<script>alert(1)</script>'), false);
  });

  it('missing state → 302 back to redirect_uri with error + iss, no state (T09)', async () => {
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery({ state: undefined }));
    assert.equal(res.status, 302);
    const to = new URL(res.headers.location);
    assert.equal(to.origin + to.pathname, REDIRECT);
    assert.equal(to.searchParams.get('error'), 'invalid_request');
    assert.equal(to.searchParams.get('iss'), ISSUER);
    assert.equal(to.searchParams.has('state'), false);
  });

  it('bad PKCE method / openid scope → 302 with error, state and iss', async () => {
    const r1 = await request(app).get('/oauth/authorize').query(authorizeQuery({ code_challenge_method: 'plain' }));
    assert.equal(r1.status, 302);
    const u1 = new URL(r1.headers.location);
    assert.equal(u1.searchParams.get('error'), 'invalid_request');
    assert.equal(u1.searchParams.get('state'), 'state-with-enough-entropy-1234');
    assert.equal(u1.searchParams.get('iss'), ISSUER);
    const r2 = await request(app).get('/oauth/authorize').query(authorizeQuery({ scope: 'openid' }));
    assert.equal(new URL(r2.headers.location).searchParams.get('error'), 'invalid_scope');
  });

  it('valid request → 302 to the Wallet consent page', async () => {
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery());
    assert.equal(res.status, 302);
    const to = new URL(res.headers.location);
    assert.equal(to.origin + to.pathname, 'https://app.test.local/oauth/consent');
    assert.ok(to.searchParams.get('request'));
    const info = await request(app).get(`/api/oauth/requests/${to.searchParams.get('request')}`);
    assert.equal(info.status, 200);
    assert.equal(info.body.data.kind, 'partner');
    assert.equal(info.body.data.clientName, 'DDC TGE');
  });
});

describe('POST /oauth/token', () => {
  it('no client auth → 401 invalid_client with WWW-Authenticate Basic realm and no-store', async () => {
    const { code, verifier } = await mintCode();
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_client');
    assert.equal(res.headers['www-authenticate'], 'Basic realm="ddc-sso"');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('Basic auth with percent-encoded halves → 200 token, no refresh token, no-store', async () => {
    const { code, verifier } = await mintCode('tge:identity tge:status');
    const res = await request(app).post('/oauth/token').set('Authorization', basic()).type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
    });
    assert.equal(res.status, 200, res.text);
    assert.match(res.body.access_token, /^ddc_tge_/);
    assert.equal(res.body.token_type, 'Bearer');
    assert.equal(res.body.expires_in, 300);
    assert.equal(res.body.scope, 'tge:identity tge:status');
    assert.equal('refresh_token' in res.body, false);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers.pragma, 'no-cache');
  });

  it('client_secret_post works; replay → 400 invalid_grant and the first token dies', async () => {
    const { code, verifier } = await mintCode();
    const body = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'tge-test', client_secret: SECRET };
    const first = await request(app).post('/oauth/token').type('form').send(body);
    assert.equal(first.status, 200, first.text);
    const me = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${first.body.access_token}`);
    assert.equal(me.status, 200);
    const replay = await request(app).post('/oauth/token').type('form').send(body);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, 'invalid_grant');
    const after = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${first.body.access_token}`);
    assert.equal(after.status, 401);
  });

  it('unsupported grant → 400', async () => {
    const res = await request(app).post('/oauth/token').type('form').send({ grant_type: 'password' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'unsupported_grant_type');
  });

  it('an internal failure is 500 server_error without leaking the cause (JSON and HTML surfaces)', async () => {
    const original = prisma.oAuthAuthorization.findUnique;
    const originalCreate = prisma.oAuthAuthorization.create;
    prisma.oAuthAuthorization.findUnique = async () => { throw new Error("Can't reach database server at `db.internal`:`5432` /srv/app/src/x.js"); };
    try {
      const token = await request(app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', code: 'ddc_code_x', code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT,
      });
      assert.equal(token.status, 500);
      assert.deepEqual(token.body, { error: 'server_error', error_description: 'Unexpected error.' });
      prisma.oAuthAuthorization.create = async () => { throw new Error('db.internal exploded'); };
      const page = await request(app).get('/oauth/authorize').query(authorizeQuery());
      assert.equal(page.status, 500);
      assert.match(page.headers['content-type'], /text\/html/);
      assert.equal(page.text.includes('db.internal'), false);
      assert.equal(page.headers.location, undefined);
    } finally {
      prisma.oAuthAuthorization.findUnique = original;
      prisma.oAuthAuthorization.create = originalCreate;
      prisma.reset();
    }
  });
});

describe('POST /oauth/revoke', () => {
  it('partner token needs client auth (401), then revokes (200) and unknown tokens are 200', async () => {
    const token = await mintToken();
    const noAuth = await request(app).post('/oauth/revoke').type('form').send({ token });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.error, 'invalid_client');
    assert.equal(noAuth.headers['www-authenticate'], 'Basic realm="ddc-sso"');
    const ok = await request(app).post('/oauth/revoke').set('Authorization', basic()).type('form').send({ token, token_type_hint: 'access_token' });
    assert.equal(ok.status, 200);
    const gone = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${token}`);
    assert.equal(gone.status, 401);
    const again = await request(app).post('/oauth/revoke').set('Authorization', basic()).type('form').send({ token });
    assert.equal(again.status, 200);
  });
});

describe('/partner/tge', () => {
  it('no token → 401 invalid_token with Bearer challenge pointing at the resource metadata', async () => {
    const res = await request(app).get('/partner/tge/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_token');
    assert.match(res.headers['www-authenticate'], /^Bearer realm="ddc-sso", error="invalid_token"/);
    assert.match(res.headers['www-authenticate'], new RegExp(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/partner/tge"`));
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('an MCP token, a bogus token, or a query-string token never passes', async () => {
    const mcp = await issueMcpToken(user.id, 'Claude', { source: 'manual' });
    const r1 = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${mcp.token}`);
    assert.equal(r1.status, 401);
    const r2 = await request(app).get('/partner/tge/me').set('Authorization', 'Bearer ddc_tge_bogus');
    assert.equal(r2.status, 401);
    const token = await mintToken();
    const r3 = await request(app).get('/partner/tge/me').query({ access_token: token });
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error, 'invalid_request');
  });

  it('/me returns the contract fields from the token only; sub/user_id parameters are refused (T12)', async () => {
    const token = await mintToken();
    const res = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['client_id', 'email_masked', 'expires_at', 'issued_at', 'sub']);
    assert.equal(res.body.sub, user.id);
    assert.equal(res.body.client_id, 'tge-test');
    assert.equal(res.body.email_masked, null, 'email_masked is not frozen in this env');
    assert.ok(Date.parse(res.body.issued_at) <= Date.parse(res.body.expires_at));
    assert.equal(res.headers['cache-control'], 'no-store');
    const spoof = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${token}`).query({ sub: 'someone-else' });
    assert.equal(spoof.status, 400);
    assert.equal(spoof.body.error, 'invalid_request');
  });

  it('/me exposes email_masked once frozen via SSO_TGE_STATUS_FIELDS', async () => {
    const saved = process.env.SSO_TGE_STATUS_FIELDS;
    process.env.SSO_TGE_STATUS_FIELDS = `${saved},email_masked`;
    try {
      const token = await mintToken();
      const res = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${token}`);
      assert.equal(res.body.email_masked, 's***@example.com');
    } finally {
      process.env.SSO_TGE_STATUS_FIELDS = saved;
    }
  });

  it('/status requires tge:status (403 insufficient_scope) and returns the flat contract fields', async () => {
    const identityOnly = await mintToken('tge:identity');
    const denied = await request(app).get('/partner/tge/status').set('Authorization', `Bearer ${identityOnly}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'insufficient_scope');
    assert.match(denied.headers['www-authenticate'], /error="insufficient_scope"/);
    assert.match(denied.headers['www-authenticate'], /scope="tge:status"/);

    await prisma.dataLicenceConsent.create({ data: { userId: user.id, policyVersion: DATA_LICENCE_POLICY_VERSION, grantedAt: new Date(), withdrawnAt: null } });
    const token = await mintToken('tge:identity tge:status');
    const res = await request(app).get('/partner/tge/status').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), ['account_status', 'as_of', 'cache_max_age', 'data_licence_granted', 'registered_at', 'sub', 'wallet_bound']);
    assert.equal(res.body.sub, user.id);
    assert.equal(res.body.account_status, 'unknown', 'disabledAt column not merged yet → unknown, never fabricated');
    assert.equal(res.body.registered_at, '2025-05-03T09:12:44.000Z');
    assert.equal(res.body.wallet_bound, true);
    assert.equal(res.body.data_licence_granted, true);
    assert.equal(res.body.cache_max_age, 60);
    assert.ok(Date.parse(res.body.as_of) > 0);
    assert.equal(res.headers['cache-control'], 'private, max-age=60');
  });

  it('/status reports null for fields that are not frozen and active/disabled once disabledAt exists', async () => {
    const saved = process.env.SSO_TGE_STATUS_FIELDS;
    process.env.SSO_TGE_STATUS_FIELDS = '';
    try {
      const token = await mintToken('tge:status');
      prisma.user.rows[0].disabledAt = null;
      const res = await request(app).get('/partner/tge/status').set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.account_status, 'active');
      assert.equal(res.body.registered_at, null);
      assert.equal(res.body.wallet_bound, null);
      assert.equal(res.body.data_licence_granted, null);
    } finally {
      process.env.SSO_TGE_STATUS_FIELDS = saved;
    }
  });

  it('a disabled account → 403 account_disabled on both endpoints', async () => {
    const token = await mintToken();
    prisma.user.rows[0].disabledAt = new Date();
    const me = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${token}`);
    assert.equal(me.status, 403);
    assert.equal(me.body.error, 'account_disabled');
    const status = await request(app).get('/partner/tge/status').set('Authorization', `Bearer ${token}`);
    assert.equal(status.status, 403);
  });

  it('kill switch: SSO_TGE_ENABLED=false → existing tokens are 401 from the next request (T13/T17)', async () => {
    const token = await mintToken();
    process.env.SSO_TGE_ENABLED = 'false';
    const res = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_token');
  });

  it('unknown partner paths answer in RFC 6750 vocabulary', async () => {
    const res = await request(app).get('/partner/tge/points');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'invalid_request');
  });
});

/**
 * Per-field scopes: `tge:email`, `tge:wallet`, `tge:points`, `tge:referral`. Each one is gated
 * twice — the token must carry the scope AND the environment must have frozen the field — and a
 * closed gate omits the key instead of answering 403 (only the endpoint scopes 403).
 */
describe('/partner/tge — per-field scopes', () => {
  const ALL_FIELDS = 'registered_at,wallet_bound,data_licence_granted,email,wallet_address,points,referral';
  const FULL_SCOPE = 'tge:identity tge:status tge:email tge:wallet tge:points tge:referral';

  /** SSO_TGE_STATUS_FIELDS is read per request, so a test can freeze/unfreeze around one call. */
  async function withFields(fields, fn) {
    const saved = process.env.SSO_TGE_STATUS_FIELDS;
    process.env.SSO_TGE_STATUS_FIELDS = fields;
    try {
      return await fn();
    } finally {
      process.env.SSO_TGE_STATUS_FIELDS = saved;
    }
  }

  const me = (token) => request(app).get('/partner/tge/me').set('Authorization', `Bearer ${token}`);
  const status = (token) => request(app).get('/partner/tge/status').set('Authorization', `Bearer ${token}`);

  // Each case runs several authorization round-trips; /oauth/authorize is 30/min per IP.
  beforeEach(() => clearRateLimitStore());

  it('every catalogued field declares its scope, source, meaning, null meaning and cache TTL', () => {
    for (const [name, entry] of Object.entries(STATUS_FIELD_CATALOG)) {
      assert.ok(PARTNER_SCOPES.includes(entry.scope), `${name} must be gated by a real scope`);
      assert.ok(entry.source && entry.meaning && entry.nullMeaning, `${name} must document itself`);
      assert.equal(typeof entry.cacheTtlSec, 'number', `${name} must state a cache TTL`);
      assert.ok(['me', 'status'].includes(entry.endpoint));
    }
    assert.equal(STATUS_FIELD_CATALOG.points.cacheTtlSec, 0, 'a balance is never cacheable');
    // The new fields are off until an operator lists them: nothing new leaks on a deploy.
    const { readPartnerConfig } = require('../../src/constants/partnerClient');
    const saved = process.env.SSO_TGE_STATUS_FIELDS;
    delete process.env.SSO_TGE_STATUS_FIELDS;
    try {
      assert.deepEqual(readPartnerConfig().statusFields, []);
    } finally {
      process.env.SSO_TGE_STATUS_FIELDS = saved;
    }
  });

  it('/me adds the real e-mail and a checksummed wallet once both gates are open', async () => {
    await withFields(ALL_FIELDS, async () => {
      prisma.user.rows[0].walletAddress = '0x8ba1f109551bd432803012645ac136ddd64dba72';
      const token = await mintToken(FULL_SCOPE);
      const res = await me(token);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(Object.keys(res.body).sort(), ['client_id', 'email', 'email_masked', 'expires_at', 'issued_at', 'sub', 'wallet_address']);
      assert.equal(res.body.email, 'sloan@example.com', 'the real address, not the masked hint');
      assert.equal(res.body.wallet_address, '0x8ba1f109551bD432803012645Ac136ddd64DBA72', 'EIP-55 checksummed');
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  });

  it('/me reports no e-mail for an external-wallet account and for a legacy twitter|<id> value', async () => {
    await withFields(ALL_FIELDS, async () => {
      // The e-mail column is NOT NULL, so a wallet-only login parks the lower-cased address there.
      prisma.user.rows[0].email = '0x8ba1f109551bd432803012645ac136ddd64dba72';
      prisma.user.rows[0].web3authVerifier = 'external-wallet';
      const wallet = await me(await mintToken(FULL_SCOPE));
      assert.equal(wallet.body.email, null, 'a wallet address is not an e-mail');
      assert.equal(wallet.body.email_masked, null);

      prisma.user.rows[0].email = 'twitter|1234567890';
      delete prisma.user.rows[0].web3authVerifier;
      const legacy = await me(await mintToken(FULL_SCOPE));
      assert.equal(legacy.body.email, null, 'an IdP subject is not an e-mail');
      assert.equal(legacy.body.email_masked, null);

      prisma.user.rows[0].email = 'sloan@example.com';
      const real = await me(await mintToken(FULL_SCOPE));
      assert.equal(real.body.email, 'sloan@example.com');
    });
  });

  it('/me reports a null wallet_address when nothing is bound', async () => {
    await withFields(ALL_FIELDS, async () => {
      prisma.user.rows[0].walletAddress = null;
      const res = await me(await mintToken(FULL_SCOPE));
      assert.equal(res.status, 200);
      assert.ok('wallet_address' in res.body, 'the field is served, it just has no value');
      assert.equal(res.body.wallet_address, null);
      const st = await status(await mintToken(FULL_SCOPE));
      assert.equal(st.body.wallet_bound, false, 'the old boolean keeps working next to it');
    });
  });

  it('/status adds a points balance that must never be cached', async () => {
    await withFields(ALL_FIELDS, async () => {
      const res = await status(await mintToken(FULL_SCOPE));
      assert.equal(res.status, 200, res.text);
      assert.equal(typeof res.body.points.balance, 'number');
      assert.equal(res.body.points.balance, 1234.5, 'the denormalised User.totalPoints');
      assert.equal(res.body.points.cache_max_age, 0);
      assert.ok(Date.parse(res.body.points.as_of) > 0);
      assert.equal(res.body.cache_max_age, 0, 'a body carrying a balance is not cacheable as a whole');
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  });

  it('/status adds the referral summary, with and without an inviter', async () => {
    await withFields(ALL_FIELDS, async () => {
      const alone = await status(await mintToken(FULL_SCOPE));
      assert.deepEqual(alone.body.referral, { code: 'AB23CD', inviter_sub: null, direct_invitees: 0 });

      await prisma.referral.create({ data: { inviterId: 'upline-1', inviteeId: user.id, code: 'ZZ99ZZ', campaignSlug: null } });
      await prisma.referral.create({ data: { inviterId: user.id, inviteeId: 'downline-1', code: 'AB23CD', campaignSlug: null } });
      await prisma.referral.create({ data: { inviterId: user.id, inviteeId: 'downline-2', code: 'AB23CD', campaignSlug: null } });
      // A campaign invite counts: the partner asks how many people this user invited, and someone
      // who joined through a campaign link was still invited by them. (The Wallet referral page
      // lists standard referrals only, so its figure can be lower — that difference is intended.)
      await prisma.referral.create({ data: { inviterId: user.id, inviteeId: 'downline-3', code: 'AB23CD', campaignSlug: 'summer-travel-2026' } });
      // Someone else's downline must never be counted into this user's number.
      await prisma.referral.create({ data: { inviterId: 'stranger', inviteeId: 'downline-4', code: 'QQ33QQ', campaignSlug: null } });

      const res = await status(await mintToken(FULL_SCOPE));
      assert.deepEqual(res.body.referral, { code: 'AB23CD', inviter_sub: 'upline-1', direct_invitees: 3 });
    });
  });

  it('never returns a downline identifier or a network total, anywhere in the body', async () => {
    await withFields(ALL_FIELDS, async () => {
      await prisma.referral.create({ data: { inviterId: user.id, inviteeId: 'downline-1', code: 'AB23CD', campaignSlug: null } });
      await prisma.referral.create({ data: { inviterId: 'downline-1', inviteeId: 'downline-1-1', code: 'AB23CD', campaignSlug: null } });
      const token = await mintToken(FULL_SCOPE);
      for (const res of [await status(token), await me(token)]) {
        const body = JSON.stringify(res.body);
        assert.equal(body.includes('downline-1'), false, 'the people this user invited did not consent to this partner');
        assert.equal(body.includes('downline-1-1'), false, 'and neither did their invitees');
        assert.equal(body.includes('network_size'), false, 'the multi-level total was dropped from the contract');
        assert.equal(/invitees\s*"?\s*:\s*\[/.test(body), false, 'direct_invitees is a count, never a list');
      }
      assert.equal(typeof (await status(token)).body.referral.direct_invitees, 'number');
    });
  });

  it('a token with only tge:identity gets none of the new fields, and no 403', async () => {
    await withFields(ALL_FIELDS, async () => {
      const token = await mintToken('tge:identity');
      const res = await me(token);
      assert.equal(res.status, 200, 'a missing OPTIONAL scope is not an error');
      assert.deepEqual(Object.keys(res.body).sort(), ['client_id', 'email_masked', 'expires_at', 'issued_at', 'sub']);
      assert.equal('email' in res.body, false);
      assert.equal('wallet_address' in res.body, false);

      const statusToken = await mintToken('tge:identity tge:status');
      const st = await status(statusToken);
      assert.equal(st.status, 200);
      assert.equal('points' in st.body, false);
      assert.equal('referral' in st.body, false);
      assert.equal(st.body.cache_max_age, 60, 'without a balance the old cache window stands');
      assert.equal(st.headers['cache-control'], 'private, max-age=60');
    });
  });

  it('a field that the environment has not frozen stays absent even with its scope granted', async () => {
    await withFields('registered_at,wallet_bound,data_licence_granted', async () => {
      const token = await mintToken(FULL_SCOPE);
      const identity = await me(token);
      assert.equal('email' in identity.body, false, 'granted but not switched on for this deployment');
      assert.equal('wallet_address' in identity.body, false);
      const st = await status(token);
      assert.equal('points' in st.body, false);
      assert.equal('referral' in st.body, false);
      assert.equal(st.body.cache_max_age, 60);
    });
  });

  it('the consent page can render the granted scopes as a list', async () => {
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery({ scope: 'tge:referral tge:identity tge:email' }));
    assert.equal(res.status, 302, res.text);
    const id = new URL(res.headers.location).searchParams.get('request');
    const info = await request(app).get(`/api/oauth/requests/${id}`);
    assert.equal(info.status, 200);
    assert.equal(info.body.data.scope, 'tge:identity tge:email tge:referral');
    assert.deepEqual(info.body.data.scopeItems, ['identity', 'email', 'referral'], 'stable order, no tge: prefix for the Wallet copy');
  });
});

describe('POST /api/oauth/consent', () => {
  const bearer = () => `Bearer ${generateToken(user.id)}`;

  /** A fresh pending authorization; returns its request id. */
  async function pendingRequest() {
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery());
    assert.equal(res.status, 302, res.text);
    return new URL(res.headers.location).searchParams.get('request');
  }

  async function decide(body, { form = false } = {}) {
    const req = request(app).post('/api/oauth/consent').set('Authorization', bearer());
    const res = await (form ? req.type('form') : req).send(body);
    return res;
  }

  function outcome(res) {
    assert.equal(res.status, 200, res.text);
    const to = new URL(res.body.data.redirectTo);
    return { code: to.searchParams.get('code'), error: to.searchParams.get('error') };
  }

  beforeEach(() => clearRateLimitStore());

  it('treats a form-encoded allow=false as a denial (it arrives as the STRING "false")', async () => {
    // express.urlencoded is mounted before these routes, so `allow !== false` was always true.
    const res = await decide({ requestId: await pendingRequest(), allow: 'false' }, { form: true });
    const { code, error } = outcome(res);
    assert.equal(error, 'access_denied');
    assert.equal(code, null, 'a denial must never produce an authorization code');
  });

  it('refuses a request with no allow field at all (400 invalid_request)', async () => {
    const requestId = await pendingRequest();
    const res = await decide({ requestId });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
    const row = prisma.oAuthAuthorization.rows.find((r) => r.id === requestId);
    assert.equal(row.consumedAt, undefined, 'the pending request is left alone');
    assert.equal(row.codeHash, undefined);
  });

  it('accepts only a real boolean true or the string "true"', async () => {
    const json = outcome(await decide({ requestId: await pendingRequest(), allow: true }));
    assert.ok(json.code, 'boolean true consents');
    const form = outcome(await decide({ requestId: await pendingRequest(), allow: 'true' }, { form: true }));
    assert.ok(form.code, 'the string "true" is how a form says yes');
  });

  it('denies on anything else that is present', async () => {
    for (const allow of ['0', '1', 'yes', 'TRUE', '', 'null']) {
      const { code, error } = outcome(await decide({ requestId: await pendingRequest(), allow }, { form: true }));
      assert.equal(error, 'access_denied', `allow=${JSON.stringify(allow)} must deny`);
      assert.equal(code, null);
    }
    const bool = outcome(await decide({ requestId: await pendingRequest(), allow: false }));
    assert.equal(bool.error, 'access_denied');
  });

  it('still requires a signed-in user', async () => {
    const res = await request(app).post('/api/oauth/consent').send({ requestId: await pendingRequest(), allow: true });
    assert.equal(res.status, 401);
  });
});
