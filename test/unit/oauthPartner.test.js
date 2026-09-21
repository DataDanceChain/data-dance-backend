const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

const SECRET = 'tge-secret-dev';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const REDIRECT = 'https://tge.example.com/oauth/callback';
const ISSUER = 'https://api.test.local';
const PARTNER_RESOURCE = `${ISSUER}/partner/tge`;
const MCP_RESOURCE = `${ISSUER}/mcp`;

Object.assign(process.env, {
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_NAME: 'DDC TGE',
  SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
  SSO_TGE_REDIRECT_URIS: `${REDIRECT},https://tge.example.com/alt`,
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
delete process.env.SSO_TGE_STATUS_FIELDS;

const oauth = require('../../src/services/oauthService');
const { findUserByPartnerToken, listMcpTokens, issueMcpToken, hashToken } = require('../../src/services/mcpTokenService');
const { DATA_LICENCE_POLICY_VERSION } = require('../../src/constants/dataLicence');
const { PARTNER_SCOPES } = require('../../src/constants/partnerClient');

const {
  OAuthError,
  resolveClient,
  assertRedirect,
  parsePartnerScope,
  startAuthorization,
  getConsentRequest,
  decideConsent,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  revokeToken,
  metadataDocuments,
  presentedClientCredentials,
  issuedTokensByCode,
} = oauth;

const req = { get: () => '' };
const basicHeader = (id, secret) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
const reqWithBasic = (id = 'tge-test', secret = SECRET) => ({ get: (name) => (name.toLowerCase() === 'authorization' ? basicHeader(id, secret) : '') });

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function partnerQuery(overrides = {}) {
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

async function rejects(promise, { status, error, redirectable } = {}) {
  let caught = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof OAuthError, `expected OAuthError, got ${caught && caught.message}`);
  if (status !== undefined) assert.equal(caught.statusCode, status);
  if (error !== undefined) assert.equal(caught.error, error);
  if (redirectable !== undefined) assert.equal(caught.redirectable, redirectable, `redirectable flag for ${caught.error}`);
  return caught;
}

const user = { id: 'user-1', email: 'sloan@example.com', isOrganization: false, userType: 'regular', createdAt: new Date('2025-05-03T09:12:44Z'), walletAddress: '0xabc' };
const orgUser = { id: 'org-1', email: 'org@example.com', isOrganization: true, userType: 'organization' };

async function seedMcpClient() {
  await prisma.oAuthClient.create({
    data: { clientId: 'ddc_oauth_mcp1', clientName: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], tokenEndpointAuthMethod: 'none', clientUri: '' },
  });
}

/** Full happy path up to a code for the partner: returns { code, verifier, row }. */
async function mintPartnerCode({ scope, claims } = {}) {
  const { verifier, challenge } = pkce();
  const consentUrl = await startAuthorization(req, partnerQuery({ code_challenge: challenge, scope }));
  const requestId = new URL(consentUrl).searchParams.get('request');
  const redirectTo = await decideConsent(user, requestId, true, { kind: 'user_jwt', claims });
  const code = new URL(redirectTo).searchParams.get('code');
  const row = prisma.oAuthAuthorization.rows.find((r) => r.id === requestId);
  return { code, verifier, row, requestId };
}

beforeEach(() => {
  prisma.reset();
  issuedTokensByCode.clear();
  process.env.SSO_TGE_ENABLED = 'true';
  delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
  prisma.user.rows.push({ ...user }, { ...orgUser });
});

describe('resolveClient', () => {
  it('returns the static partner client first, refuses it when disabled, and marks stored clients as mcp', async () => {
    const partner = await resolveClient('tge-test');
    assert.equal(partner.kind, 'partner');
    process.env.SSO_TGE_ENABLED = 'false';
    await rejects(resolveClient('tge-test'), { status: 400, error: 'unauthorized_client' });
    process.env.SSO_TGE_ENABLED = 'true';
    await seedMcpClient();
    assert.equal((await resolveClient('ddc_oauth_mcp1')).kind, 'mcp');
    await rejects(resolveClient('nobody'), { status: 400, error: 'invalid_client' });
    await rejects(resolveClient(''), { status: 400, error: 'invalid_client' });
  });
});

describe('assertRedirect', () => {
  const client = { redirectUris: [REDIRECT] };
  it('accepts only an exact string match', () => {
    assert.doesNotThrow(() => assertRedirect(client, REDIRECT));
  });
  it('rejects near misses: trailing slash, query, case, scheme, port, path prefix', () => {
    for (const near of [
      `${REDIRECT}/`,
      `${REDIRECT}?x=1`,
      'https://TGE.example.com/oauth/callback',
      'http://tge.example.com/oauth/callback',
      'https://tge.example.com:8443/oauth/callback',
      'https://tge.example.com/oauth/callback/extra',
      'https://tge.example.com/oauth',
      'https://tge.example.com.evil.net/oauth/callback',
    ]) {
      assert.throws(() => assertRedirect(client, near), (e) => e.error === 'invalid_request', near);
    }
  });
  it('rejects an empty registered list even for an otherwise acceptable URI (no more bypass)', () => {
    assert.throws(() => assertRedirect({ redirectUris: [] }, REDIRECT), /not registered/);
    assert.throws(() => assertRedirect({}, REDIRECT), /not registered/);
  });
  it('rejects missing or non-http(s)/non-localhost URIs before the list check', () => {
    assert.throws(() => assertRedirect(client, ''), /not allowed/);
    assert.throws(() => assertRedirect({ redirectUris: ['javascript:alert(1)'] }, 'javascript:alert(1)'), /not allowed/);
    assert.throws(() => assertRedirect({ redirectUris: ['http://evil.example/cb'] }, 'http://evil.example/cb'), /not allowed/);
    assert.doesNotThrow(() => assertRedirect({ redirectUris: ['http://localhost:3000/cb'] }, 'http://localhost:3000/cb'));
  });
});

describe('parsePartnerScope', () => {
  it('defaults, canonicalises, dedupes, and refuses openid/unknown', () => {
    assert.equal(parsePartnerScope(''), 'tge:identity');
    assert.equal(parsePartnerScope(undefined), 'tge:identity');
    assert.equal(parsePartnerScope('tge:status tge:identity tge:status'), 'tge:identity tge:status');
    assert.equal(parsePartnerScope('tge:status+tge:identity'), 'tge:identity tge:status');
    assert.equal(parsePartnerScope('tge:status'), 'tge:status');
    assert.throws(() => parsePartnerScope('openid tge:identity'), (e) => e.error === 'invalid_scope' && /openid/.test(e.description));
    assert.throws(() => parsePartnerScope('tge:identity life_capsule'), (e) => e.error === 'invalid_scope');
    assert.throws(() => parsePartnerScope('tge'), (e) => e.error === 'invalid_scope');
  });
});

describe('startAuthorization', () => {
  it('unknown client and unregistered redirect are NOT redirectable (400 page)', async () => {
    await rejects(startAuthorization(req, partnerQuery({ client_id: 'nobody' })), { status: 400, error: 'invalid_client', redirectable: false });
    await rejects(startAuthorization(req, partnerQuery({ redirect_uri: `${REDIRECT}/` })), { status: 400, error: 'invalid_request', redirectable: false });
    process.env.SSO_TGE_ENABLED = 'false';
    await rejects(startAuthorization(req, partnerQuery()), { status: 400, error: 'unauthorized_client', redirectable: false });
    assert.equal(prisma.oAuthAuthorization.rows.length, 0);
  });

  it('post-validation errors ARE redirectable and carry error, state and iss', async () => {
    const e1 = await rejects(startAuthorization(req, partnerQuery({ state: undefined })), { error: 'invalid_request', redirectable: true });
    const u1 = new URL(e1.redirectTo);
    assert.equal(u1.origin + u1.pathname, REDIRECT);
    assert.equal(u1.searchParams.get('error'), 'invalid_request');
    assert.equal(u1.searchParams.get('iss'), ISSUER);
    assert.equal(u1.searchParams.has('state'), false);

    const e2 = await rejects(startAuthorization(req, partnerQuery({ code_challenge_method: 'plain' })), { error: 'invalid_request', redirectable: true });
    assert.equal(new URL(e2.redirectTo).searchParams.get('state'), 'state-with-enough-entropy-1234');

    const e3 = await rejects(startAuthorization(req, partnerQuery({ response_type: 'token' })), { error: 'unsupported_response_type', redirectable: true });
    assert.equal(new URL(e3.redirectTo).searchParams.get('iss'), ISSUER);

    await rejects(startAuthorization(req, partnerQuery({ scope: 'openid tge:identity' })), { error: 'invalid_scope', redirectable: true });
    await rejects(startAuthorization(req, partnerQuery({ scope: 'email' })), { error: 'invalid_scope', redirectable: true });
    await rejects(startAuthorization(req, partnerQuery({ resource: MCP_RESOURCE })), { error: 'invalid_target', redirectable: true });
    await rejects(startAuthorization(req, partnerQuery({ prompt: 'none' })), { error: 'login_required', redirectable: true });
    await rejects(startAuthorization(req, partnerQuery({ prompt: 'consent' })), { error: 'invalid_request', redirectable: true });
    await rejects(startAuthorization(req, partnerQuery({ code_challenge: 'tooshort' })), { error: 'invalid_request', redirectable: true });
    await rejects(startAuthorization(req, partnerQuery({ state: 'x'.repeat(513) })), { error: 'invalid_request', redirectable: true });
    assert.equal(prisma.oAuthAuthorization.rows.length, 0);
  });

  it('stores a partner request with the partner resource, default scope, state and a 10-minute TTL', async () => {
    const before = Date.now();
    const url = await startAuthorization(req, partnerQuery({ login_hint: 'sloan@example.com' }));
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://app.test.local/oauth/consent');
    assert.equal(parsed.searchParams.get('login_hint'), 'sloan@example.com');
    const row = prisma.oAuthAuthorization.rows[0];
    assert.equal(parsed.searchParams.get('request'), row.id);
    assert.equal(row.clientId, 'tge-test');
    assert.equal(row.resource, PARTNER_RESOURCE);
    assert.equal(row.scope, 'tge:identity');
    assert.equal(row.state, 'state-with-enough-entropy-1234');
    assert.equal(row.codeChallengeMethod, 'S256');
    const ttl = row.expiresAt.getTime() - before;
    assert.ok(ttl >= 10 * 60 * 1000 - 50 && ttl <= 10 * 60 * 1000 + 2000, `ttl ${ttl}`);
  });

  it('parses scopes and accepts an explicit matching resource (trailing slash tolerant)', async () => {
    await startAuthorization(req, partnerQuery({ scope: 'tge:status tge:identity', resource: `${PARTNER_RESOURCE}/` }));
    assert.equal(prisma.oAuthAuthorization.rows[0].scope, 'tge:identity tge:status');
    assert.equal(prisma.oAuthAuthorization.rows[0].resource, PARTNER_RESOURCE);
  });

  it('drops a login_hint that is not an e-mail', async () => {
    const url = await startAuthorization(req, partnerQuery({ login_hint: '<script>' }));
    assert.equal(new URL(url).searchParams.has('login_hint'), false);
  });

  it('keeps the MCP path: state optional, MCP resource, MCP scopes, 15-minute TTL', async () => {
    await seedMcpClient();
    const before = Date.now();
    await startAuthorization(req, {
      response_type: 'code',
      client_id: 'ddc_oauth_mcp1',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      scope: 'openid email life_capsule',
    });
    const row = prisma.oAuthAuthorization.rows[0];
    assert.equal(row.resource, MCP_RESOURCE);
    assert.equal(row.scope, 'openid email life_capsule');
    assert.equal(row.state, '');
    const ttl = row.expiresAt.getTime() - before;
    assert.ok(ttl >= 15 * 60 * 1000 - 50 && ttl <= 15 * 60 * 1000 + 2000, `ttl ${ttl}`);
  });
});

describe('getConsentRequest', () => {
  it('adds kind=partner and expiresAt; refuses a disabled partner mid-flow', async () => {
    const url = await startAuthorization(req, partnerQuery());
    const id = new URL(url).searchParams.get('request');
    const data = await getConsentRequest(id);
    assert.equal(data.kind, 'partner');
    assert.equal(data.clientName, 'DDC TGE');
    assert.ok(data.expiresAt instanceof Date);
    process.env.SSO_TGE_ENABLED = 'false';
    await rejects(getConsentRequest(id), { status: 400, error: 'unauthorized_client' });
  });
  it('reports kind=assistant for MCP requests', async () => {
    await seedMcpClient();
    const url = await startAuthorization(req, {
      response_type: 'code', client_id: 'ddc_oauth_mcp1', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: pkce().challenge, code_challenge_method: 'S256',
    });
    const data = await getConsentRequest(new URL(url).searchParams.get('request'));
    assert.equal(data.kind, 'assistant');
    assert.equal(data.clientName, 'Claude');
  });
});

describe('decideConsent', () => {
  async function fresh() {
    const url = await startAuthorization(req, partnerQuery());
    return new URL(url).searchParams.get('request');
  }

  it('deny → access_denied with state and iss, request consumed', async () => {
    const id = await fresh();
    const to = new URL(await decideConsent(user, id, false, { kind: 'user_jwt' }));
    assert.equal(to.searchParams.get('error'), 'access_denied');
    assert.equal(to.searchParams.get('state'), 'state-with-enough-entropy-1234');
    assert.equal(to.searchParams.get('iss'), ISSUER);
    assert.ok(prisma.oAuthAuthorization.rows[0].consumedAt);
    await rejects(decideConsent(user, id, true), { error: 'invalid_request' });
  });

  it('allow → code with state and iss, 60-second code TTL for the partner', async () => {
    const id = await fresh();
    const before = Date.now();
    const to = new URL(await decideConsent(user, id, true, { kind: 'user_jwt' }));
    assert.match(to.searchParams.get('code'), /^ddc_code_/);
    assert.equal(to.searchParams.get('state'), 'state-with-enough-entropy-1234');
    assert.equal(to.searchParams.get('iss'), ISSUER);
    const row = prisma.oAuthAuthorization.rows[0];
    assert.equal(row.userId, user.id);
    const ttl = row.expiresAt.getTime() - before;
    assert.ok(ttl >= 60 * 1000 - 50 && ttl <= 60 * 1000 + 2000, `code ttl ${ttl}`);
  });

  it('refuses organizations and disabled accounts for the partner with access_denied', async () => {
    const id1 = await fresh();
    const to1 = new URL(await decideConsent(orgUser, id1, true, { kind: 'user_jwt' }));
    assert.equal(to1.searchParams.get('error'), 'access_denied');
    assert.equal(to1.searchParams.has('code'), false);
    const id2 = await fresh();
    const to2 = new URL(await decideConsent({ ...user, disabledAt: new Date() }, id2, true, { kind: 'user_jwt' }));
    assert.equal(to2.searchParams.get('error'), 'access_denied');
  });

  it('SSO_REQUIRE_VERIFIED_SESSION: login_required unless the JWT carries ver>=2; tolerates missing claims', async () => {
    process.env.SSO_REQUIRE_VERIFIED_SESSION = 'true';
    const id1 = await fresh();
    const to1 = new URL(await decideConsent(user, id1, true, { kind: 'user_jwt', claims: undefined }));
    assert.equal(to1.searchParams.get('error'), 'login_required');
    assert.equal(to1.searchParams.get('iss'), ISSUER);
    const id2 = await fresh();
    const to2 = new URL(await decideConsent(user, id2, true, { kind: 'user_jwt', claims: { ver: 1 } }));
    assert.equal(to2.searchParams.get('error'), 'login_required');
    const id3 = await fresh();
    const to3 = new URL(await decideConsent(user, id3, true, { kind: 'user_jwt', claims: { ver: 2 } }));
    assert.ok(to3.searchParams.get('code'));
    const id4 = await fresh();
    const to4 = new URL(await decideConsent(user, id4, true));
    assert.equal(to4.searchParams.get('error'), 'login_required', 'no ctx at all counts as an unverified user JWT');
  });

  it('refuses an SSO ticket session bound to another client, and a disabled client mid-flow', async () => {
    const id = await fresh();
    await rejects(decideConsent(user, id, true, { kind: 'sso_ticket', clientId: 'other' }), { status: 403, error: 'access_denied' });
    process.env.SSO_TGE_ENABLED = 'false';
    await rejects(decideConsent(user, id, true, { kind: 'user_jwt' }), { error: 'unauthorized_client' });
  });

  it('keeps the MCP 10-minute code TTL', async () => {
    await seedMcpClient();
    const url = await startAuthorization(req, {
      response_type: 'code', client_id: 'ddc_oauth_mcp1', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: pkce().challenge, code_challenge_method: 'S256',
    });
    const before = Date.now();
    const to = new URL(await decideConsent(user, new URL(url).searchParams.get('request'), true));
    assert.ok(to.searchParams.get('code'));
    assert.equal(to.searchParams.get('iss'), ISSUER);
    const ttl = prisma.oAuthAuthorization.rows[0].expiresAt.getTime() - before;
    assert.ok(ttl >= 10 * 60 * 1000 - 50 && ttl <= 10 * 60 * 1000 + 2000, `code ttl ${ttl}`);
  });
});

describe('presentedClientCredentials', () => {
  it('prefers Basic, refuses two methods, requires body client_id to agree', () => {
    assert.deepEqual(presentedClientCredentials(reqWithBasic(), {}), { clientId: 'tge-test', clientSecret: SECRET, method: 'client_secret_basic' });
    assert.deepEqual(presentedClientCredentials(reqWithBasic(), { client_id: 'tge-test' }).method, 'client_secret_basic');
    assert.throws(() => presentedClientCredentials(reqWithBasic(), { client_id: 'other' }), (e) => e.error === 'invalid_request');
    assert.throws(() => presentedClientCredentials(reqWithBasic(), { client_secret: 'x' }), (e) => e.error === 'invalid_request');
    assert.deepEqual(presentedClientCredentials(req, { client_id: 'tge-test', client_secret: 's' }), { clientId: 'tge-test', clientSecret: 's', method: 'client_secret_post' });
    assert.deepEqual(presentedClientCredentials(req, { client_id: 'tge-test' }), { clientId: 'tge-test', clientSecret: '', method: 'none' });
    assert.equal(presentedClientCredentials(req, {}), null);
    assert.equal(presentedClientCredentials(undefined, {}), null);
  });
});

describe('exchangeAuthorizationCode (partner)', () => {
  it('issues a ddc_tge_ token with client_secret_basic (percent-encoded halves), 300 s, no refresh token', async () => {
    const { code, verifier, row } = await mintPartnerCode({ scope: 'tge:identity tge:status' });
    const token = await exchangeAuthorizationCode(reqWithBasic(), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
    });
    assert.match(token.access_token, /^ddc_tge_/);
    assert.equal(token.token_type, 'Bearer');
    assert.equal(token.expires_in, 300);
    assert.equal(token.scope, 'tge:identity tge:status');
    assert.equal(token.resource, PARTNER_RESOURCE);
    assert.equal('refresh_token' in token, false);
    assert.equal(prisma.oAuthRefreshToken.rows.length, 0);
    const stored = prisma.mcpToken.rows[0];
    assert.equal(stored.source, 'partner');
    assert.equal(stored.clientId, 'tge-test');
    assert.equal(stored.resource, PARTNER_RESOURCE);
    assert.equal(stored.tokenHash, hashToken(token.access_token));
    assert.ok(stored.expiresAt.getTime() - Date.now() <= 300 * 1000);
    assert.ok(row.consumedAt);
    assert.ok(issuedTokensByCode.has(row.id));
  });

  it('accepts client_secret_post and a body client_id that agrees with Basic', async () => {
    const a = await mintPartnerCode();
    const t1 = await exchangeAuthorizationCode(req, {
      grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, redirect_uri: REDIRECT,
      client_id: 'tge-test', client_secret: SECRET,
    });
    assert.match(t1.access_token, /^ddc_tge_/);
    const b = await mintPartnerCode();
    const t2 = await exchangeAuthorizationCode(reqWithBasic(), {
      grant_type: 'authorization_code', code: b.code, code_verifier: b.verifier, redirect_uri: REDIRECT, client_id: 'tge-test',
    });
    assert.match(t2.access_token, /^ddc_tge_/);
  });

  it('401 invalid_client: no credentials, wrong secret, client_id-only, disabled client; code stays unconsumed', async () => {
    const { code, verifier, row } = await mintPartnerCode();
    const body = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT };
    await rejects(exchangeAuthorizationCode(req, body), { status: 401, error: 'invalid_client' });
    await rejects(exchangeAuthorizationCode(req, { ...body, client_id: 'tge-test' }), { status: 401, error: 'invalid_client' });
    await rejects(exchangeAuthorizationCode(reqWithBasic('tge-test', 'wrong'), body), { status: 401, error: 'invalid_client' });
    await rejects(exchangeAuthorizationCode(req, { ...body, client_id: 'tge-test', client_secret: 'wrong' }), { status: 401, error: 'invalid_client' });
    process.env.SSO_TGE_ENABLED = 'false';
    await rejects(exchangeAuthorizationCode(reqWithBasic(), body), { status: 401, error: 'invalid_client' });
    process.env.SSO_TGE_ENABLED = 'true';
    assert.equal(row.consumedAt, undefined);
    assert.equal(prisma.mcpToken.rows.length, 0);
  });

  it('400 invalid_request when two authentication methods are mixed', async () => {
    const { code, verifier } = await mintPartnerCode();
    await rejects(exchangeAuthorizationCode(reqWithBasic(), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_secret: SECRET,
    }), { status: 400, error: 'invalid_request' });
  });

  it('invalid_grant: missing or different redirect_uri, bad verifier, malformed verifier, unknown code, expired code', async () => {
    const { code, verifier } = await mintPartnerCode();
    const base = { grant_type: 'authorization_code', code, code_verifier: verifier };
    await rejects(exchangeAuthorizationCode(reqWithBasic(), base), { status: 400, error: 'invalid_grant' });
    await rejects(exchangeAuthorizationCode(reqWithBasic(), { ...base, redirect_uri: 'https://tge.example.com/alt' }), { status: 400, error: 'invalid_grant' });
    await rejects(exchangeAuthorizationCode(reqWithBasic(), { ...base, redirect_uri: REDIRECT, code_verifier: pkce().verifier }), { status: 400, error: 'invalid_grant' });
    await rejects(exchangeAuthorizationCode(reqWithBasic(), { ...base, redirect_uri: REDIRECT, code_verifier: 'short' }), { status: 400, error: 'invalid_grant' });
    await rejects(exchangeAuthorizationCode(reqWithBasic(), { ...base, redirect_uri: REDIRECT, code: 'ddc_code_nope' }), { status: 400, error: 'invalid_grant' });
    await rejects(exchangeAuthorizationCode(reqWithBasic(), { ...base, redirect_uri: REDIRECT, resource: MCP_RESOURCE }), { status: 400, error: 'invalid_target' });
    prisma.oAuthAuthorization.rows[0].expiresAt = new Date(Date.now() - 1000);
    await rejects(exchangeAuthorizationCode(reqWithBasic(), { ...base, redirect_uri: REDIRECT }), { status: 400, error: 'invalid_grant' });
    assert.equal(prisma.mcpToken.rows.length, 0);
  });

  it('consume race: when the atomic update affects 0 rows nothing is issued', async () => {
    const { code, verifier } = await mintPartnerCode();
    const original = prisma.oAuthAuthorization.updateMany;
    prisma.oAuthAuthorization.updateMany = async () => ({ count: 0 });
    try {
      await rejects(exchangeAuthorizationCode(reqWithBasic(), {
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
      }), { status: 400, error: 'invalid_grant' });
    } finally {
      prisma.oAuthAuthorization.updateMany = original;
    }
    assert.equal(prisma.mcpToken.rows.length, 0);
  });

  it('the atomic consume only matches unconsumed, unexpired rows', async () => {
    const { row } = await mintPartnerCode();
    const first = await prisma.oAuthAuthorization.updateMany({ where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    const second = await prisma.oAuthAuthorization.updateMany({ where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    assert.equal(first.count, 1);
    assert.equal(second.count, 0);
  });

  it('replaying a consumed code is invalid_grant and revokes the token issued from it', async () => {
    const { code, verifier } = await mintPartnerCode();
    const body = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT };
    const token = await exchangeAuthorizationCode(reqWithBasic(), body);
    assert.ok(await findUserByPartnerToken(token.access_token, PARTNER_RESOURCE));
    const err = await rejects(exchangeAuthorizationCode(reqWithBasic(), body), { status: 400, error: 'invalid_grant' });
    assert.match(err.description, /already been used/);
    assert.equal(await findUserByPartnerToken(token.access_token, PARTNER_RESOURCE), null, 'token revoked after replay');
    assert.equal(prisma.mcpToken.rows.length, 0);
    assert.equal(issuedTokensByCode.has(prisma.oAuthAuthorization.rows[0].id), false);
  });

  it('an MCP code cannot be exchanged with partner credentials, and a partner code not without them', async () => {
    await seedMcpClient();
    const { verifier, challenge } = pkce();
    const url = await startAuthorization(req, {
      response_type: 'code', client_id: 'ddc_oauth_mcp1', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const to = new URL(await decideConsent(user, new URL(url).searchParams.get('request'), true));
    const mcpCode = to.searchParams.get('code');
    await rejects(exchangeAuthorizationCode(reqWithBasic(), {
      grant_type: 'authorization_code', code: mcpCode, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    }), { status: 400, error: 'invalid_grant' });
    const mcpToken = await exchangeAuthorizationCode(req, { grant_type: 'authorization_code', code: mcpCode, code_verifier: verifier });
    assert.match(mcpToken.access_token, /^ddc_mcp_/);
    assert.match(mcpToken.refresh_token, /^ddc_rt_/);
    assert.equal(mcpToken.expires_in, 3600);
  });
});

describe('partner token matrix (findUserByPartnerToken)', () => {
  async function partnerToken(scope = 'tge:identity') {
    const { code, verifier } = await mintPartnerCode({ scope });
    return (await exchangeAuthorizationCode(reqWithBasic(), { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT })).access_token;
  }

  it('accepts only ddc_tge_ tokens issued for exactly this resource, unexpired, source partner', async () => {
    const token = await partnerToken('tge:identity tge:status');
    const ok = await findUserByPartnerToken(token, PARTNER_RESOURCE);
    assert.equal(ok.user.id, user.id);
    assert.equal(ok.token.clientId, 'tge-test');
    assert.equal(ok.token.scope, 'tge:identity tge:status');
    assert.ok(await findUserByPartnerToken(token, `${PARTNER_RESOURCE}/`), 'trailing slash tolerant');
    assert.equal(await findUserByPartnerToken(token, MCP_RESOURCE), null, 'wrong audience');
    assert.equal(await findUserByPartnerToken(token, 'https://other.example/partner/tge'), null, 'wrong origin');
    assert.equal(await findUserByPartnerToken(`ddc_mcp_${token.slice(8)}`, PARTNER_RESOURCE), null, 'mcp prefix');
    assert.equal(await findUserByPartnerToken('', PARTNER_RESOURCE), null);
    assert.equal(await findUserByPartnerToken('ddc_tge_unknown', PARTNER_RESOURCE), null);
  });

  it('refuses expired tokens and non-partner rows even with the right prefix', async () => {
    const token = await partnerToken();
    prisma.mcpToken.rows[0].expiresAt = new Date(Date.now() - 1);
    assert.equal(await findUserByPartnerToken(token, PARTNER_RESOURCE), null);
    prisma.mcpToken.rows[0].expiresAt = new Date(Date.now() + 60_000);
    prisma.mcpToken.rows[0].source = 'manual';
    assert.equal(await findUserByPartnerToken(token, PARTNER_RESOURCE), null);
  });

  it('MCP token lookups never see partner tokens and the Portrait list hides them', async () => {
    await partnerToken();
    await issueMcpToken(user.id, 'Claude', { source: 'manual' });
    const list = await listMcpTokens(user.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'Claude');
    assert.equal(prisma.mcpToken.rows.length, 2);
  });
});

describe('revokeToken', () => {
  async function partnerToken() {
    const { code, verifier } = await mintPartnerCode();
    return (await exchangeAuthorizationCode(reqWithBasic(), { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT })).access_token;
  }

  it('requires client authentication for ddc_tge_ tokens and revokes on success (RFC 7009)', async () => {
    const token = await partnerToken();
    await rejects(revokeToken(token, { req, body: {} }), { status: 401, error: 'invalid_client' });
    await rejects(revokeToken(token, { req: reqWithBasic('tge-test', 'wrong'), body: {} }), { status: 401, error: 'invalid_client' });
    assert.ok(await findUserByPartnerToken(token, PARTNER_RESOURCE));
    await revokeToken(token, { req: reqWithBasic(), body: {} });
    assert.equal(await findUserByPartnerToken(token, PARTNER_RESOURCE), null);
    await revokeToken(token, { req: reqWithBasic(), body: {} }); // unknown now → silent success
    await revokeToken('ddc_tge_unknown', { req, body: { client_id: 'tge-test', client_secret: SECRET } });
  });

  it('leaves the MCP revoke path unauthenticated', async () => {
    const issued = await issueMcpToken(user.id, 'Claude', { source: 'manual' });
    await revokeToken(issued.token, { req, body: {} });
    assert.equal(prisma.mcpToken.rows.length, 0);
    await revokeToken('', { req, body: {} });
  });
});

describe('exchangeRefreshToken', () => {
  async function seedRefresh(raw, overrides = {}) {
    await prisma.oAuthRefreshToken.create({
      data: {
        tokenHash: hashToken(raw), userId: user.id, clientId: 'ddc_oauth_mcp1', mcpTokenId: 'm',
        resource: MCP_RESOURCE, scope: 'life_capsule', expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
        ...overrides,
      },
    });
  }

  it('refuses refresh rows that claim the partner client id', async () => {
    const raw = 'ddc_rt_x';
    await prisma.oAuthRefreshToken.create({ data: { tokenHash: hashToken(raw), userId: user.id, clientId: 'tge-test', mcpTokenId: 'm', resource: PARTNER_RESOURCE, scope: 'tge:identity', expiresAt: new Date(Date.now() + 60_000) } });
    await rejects(exchangeRefreshToken({ refresh_token: raw }), { status: 400, error: 'invalid_grant' });
  });

  it('rotates a live refresh token for a healthy account', async () => {
    const raw = 'ddc_rt_live';
    await seedRefresh(raw);
    const issued = await exchangeRefreshToken({ refresh_token: raw });
    assert.match(issued.access_token, /^ddc_mcp_/);
    assert.match(issued.refresh_token, /^ddc_rt_/);
    assert.notEqual(issued.refresh_token, raw, 'the presented token is rotated');
    await rejects(exchangeRefreshToken({ refresh_token: raw }), { status: 400, error: 'invalid_grant' });
  });

  it('refuses a refresh token whose account has been disabled', async () => {
    // Disabling an account has to end the sessions it can still mint, not only the live ones.
    const raw = 'ddc_rt_disabled';
    await seedRefresh(raw);
    prisma.user.rows.find((r) => r.id === user.id).disabledAt = new Date();
    await rejects(exchangeRefreshToken({ refresh_token: raw }), { status: 400, error: 'invalid_grant' });
    assert.equal(prisma.mcpToken.rows.length, 0, 'no access token was issued');
    assert.equal(prisma.oAuthRefreshToken.rows[0].revokedAt, null, 'the row is refused, not consumed');
  });

  it('refuses a refresh token whose user row is gone', async () => {
    const raw = 'ddc_rt_orphan';
    await seedRefresh(raw, { userId: 'deleted-user' });
    await rejects(exchangeRefreshToken({ refresh_token: raw }), { status: 400, error: 'invalid_grant' });
    assert.equal(prisma.mcpToken.rows.length, 0);
  });
});

describe('metadataDocuments', () => {
  it('advertises RFC 9207 iss, all three token auth methods, partner scopes and the partner resource', () => {
    const { as, partnerResourceDoc, resourceDoc } = metadataDocuments(req);
    assert.equal(as.issuer, ISSUER);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none', 'client_secret_basic', 'client_secret_post']);
    assert.ok(as.scopes_supported.includes('tge:identity') && as.scopes_supported.includes('tge:status') && as.scopes_supported.includes('life_capsule'));
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.equal(as.resource_indicators_supported, true);
    assert.equal(as.ddc_sso_environment, 'test');
    assert.equal(partnerResourceDoc.resource, PARTNER_RESOURCE);
    assert.deepEqual(partnerResourceDoc.authorization_servers, [ISSUER]);
    assert.deepEqual(partnerResourceDoc.bearer_methods_supported, ['header']);
    assert.deepEqual(partnerResourceDoc.scopes_supported, [...PARTNER_SCOPES]);
    assert.equal(resourceDoc.resource, MCP_RESOURCE);
  });
});

describe('data licence field source', () => {
  it('hasActiveConsent reflects the current policy version and withdrawal', async () => {
    const { hasActiveConsent } = require('../../src/services/dataLicenceConsent');
    assert.equal(await hasActiveConsent(user.id), false);
    await prisma.dataLicenceConsent.create({ data: { userId: user.id, policyVersion: DATA_LICENCE_POLICY_VERSION, grantedAt: new Date(), withdrawnAt: null } });
    assert.equal(await hasActiveConsent(user.id), true);
    prisma.dataLicenceConsent.rows[0].withdrawnAt = new Date();
    assert.equal(await hasActiveConsent(user.id), false);
  });
});
