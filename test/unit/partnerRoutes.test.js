const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

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
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;

const oauthRoutes = require('../../src/routes/oauthRoutes');
const partnerTgeRoutes = require('../../src/routes/partnerTgeRoutes');
const { decideConsent, issuedTokensByCode } = require('../../src/services/oauthService');
const { issueMcpToken } = require('../../src/services/mcpTokenService');
const { DATA_LICENCE_POLICY_VERSION } = require('../../src/constants/dataLicence');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/partner/tge', partnerTgeRoutes);
app.use('/', oauthRoutes);

const user = { id: 'user-1', email: 'sloan@example.com', isOrganization: false, userType: 'regular', createdAt: new Date('2025-05-03T09:12:44Z'), walletAddress: '0xabc' };
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
    assert.deepEqual(pr.body.scopes_supported, ['tge:identity', 'tge:status']);
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
