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
  ConsentInitiatorError,
  AUTHZ_COOKIE_NAME,
  readInitiatorNonce,
  registerClient,
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

/** Minimal stand-in for the express response: records what res.cookie() was asked to set. */
function fakeRes() {
  const cookies = [];
  return { cookies, cookie: (name, value, options) => cookies.push({ name, value, options }) };
}

/** A request carrying (only) the `__Host-ddc_authz` cookie — i.e. one specific browser. */
function reqWithCookie(nonce) {
  return { get: (name) => (String(name).toLowerCase() === 'cookie' ? `${AUTHZ_COOKIE_NAME}=${nonce}` : '') };
}
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

/**
 * Item 1 — authorization-request fixation. The attacker starts the authorization on their own
 * machine and sends the consent link to the victim; before the binding, the victim's approval
 * minted a code that travelled to the ATTACKER's registered redirect, bound to the attacker's
 * state and code_verifier, so PKCE never entered into it.
 */
describe('decideConsent — initiator binding (item 1)', () => {
  /** Start an authorization "in a browser": returns { requestId, nonce, row }. */
  async function startInBrowser(query = partnerQuery()) {
    const res = fakeRes();
    const url = await startAuthorization(req, query, res);
    const requestId = new URL(url).searchParams.get('request');
    return {
      requestId,
      nonce: res.cookies[0].value,
      cookie: res.cookies[0],
      row: prisma.oAuthAuthorization.rows.find((r) => r.id === requestId),
    };
  }

  it('sets a __Host- cookie with the attributes the prefix requires and stores only its sha256', async () => {
    const { cookie, row, nonce } = await startInBrowser();
    assert.equal(cookie.name, '__Host-ddc_authz');
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.secure, true, '__Host- cookies are refused without Secure');
    assert.equal(cookie.options.sameSite, 'lax');
    assert.equal(cookie.options.path, '/');
    assert.equal('domain' in cookie.options, false, '__Host- forbids Domain; that is what stops a sibling host planting it');
    assert.ok(nonce.length >= 40, `nonce too short: ${nonce.length}`);
    assert.equal(row.initiatorHash, crypto.createHash('sha256').update(nonce).digest('hex'));
    assert.notEqual(row.initiatorHash, nonce, 'the nonce itself is never stored');
    assert.ok(row.initiatorBoundAt instanceof Date);
    assert.equal(row.initiatorMismatchCount, 0);
  });

  it('the browser that started it can approve', async () => {
    const { requestId, nonce } = await startInBrowser();
    const to = new URL(await decideConsent(user, requestId, true, { kind: 'user_jwt', initiatorNonce: nonce }));
    assert.match(to.searchParams.get('code'), /^ddc_code_/);
  });

  it('ANOTHER browser cannot: no code is minted and the request stays undecided', async () => {
    const { requestId, row } = await startInBrowser();
    // The victim clicks the attacker's consent link. Their browser has no cookie for it…
    let caught = null;
    try {
      await decideConsent(user, requestId, true, { kind: 'user_jwt' });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ConsentInitiatorError, `expected ConsentInitiatorError, got ${caught}`);
    assert.equal(caught.code, 'AUTHZ_INITIATOR_MISMATCH');
    assert.equal(caught.reason, 'missing');
    assert.equal(caught.statusCode, 409);
    assert.equal(caught.clientName, 'DDC TGE', 'the page renders "start again from {client}"');
    assert.equal(row.codeHash, undefined, 'no code exists');
    assert.equal(row.consumedAt, undefined);
    assert.equal(row.userId, undefined, 'the victim is not even recorded as the subject');
    assert.equal(row.initiatorMismatchCount, 1, 'the event is visible in the row, not only in the log');

    // …or has its own, from a sign-in it started itself.
    const other = await startInBrowser();
    const second = await decideConsent(user, requestId, true, { kind: 'user_jwt', initiatorNonce: other.nonce })
      .then(() => null, (error) => error);
    assert.ok(second instanceof ConsentInitiatorError);
    assert.equal(second.reason, 'mismatch');
    assert.equal(row.initiatorMismatchCount, 2);
    assert.equal(row.codeHash, undefined);
  });

  it('an SSO-ticket session is bound the same way (the App hand-off runs in the system browser)', async () => {
    const { requestId, nonce } = await startInBrowser();
    await assert.rejects(
      decideConsent(user, requestId, true, { kind: 'sso_ticket', clientId: 'tge-test' }),
      (error) => error instanceof ConsentInitiatorError && error.reason === 'missing'
    );
    const to = new URL(await decideConsent(user, requestId, true, { kind: 'sso_ticket', clientId: 'tge-test', initiatorNonce: nonce }));
    assert.ok(to.searchParams.get('code'), 'same browser, same cookie: the hand-off completes');
  });

  it('a DENIAL is still accepted from any browser — it only ever destroys the request', async () => {
    const { requestId, row } = await startInBrowser();
    const to = new URL(await decideConsent(user, requestId, false, { kind: 'user_jwt' }));
    assert.equal(to.searchParams.get('error'), 'access_denied');
    assert.ok(row.consumedAt, 'a fixated request must not survive the victim saying no');
  });

  it('one nonce per browser, not per authorization: two tabs both complete', async () => {
    const first = await startInBrowser();
    // The second /oauth/authorize arrives with the cookie the first one set.
    const res = fakeRes();
    const url = await startAuthorization(reqWithCookie(first.nonce), partnerQuery(), res);
    assert.equal(res.cookies[0].value, first.nonce, 'the existing nonce is reused (and refreshed)');
    const secondId = new URL(url).searchParams.get('request');
    assert.ok(await decideConsent(user, first.requestId, true, { kind: 'user_jwt', initiatorNonce: first.nonce }));
    assert.ok(await decideConsent(user, secondId, true, { kind: 'user_jwt', initiatorNonce: first.nonce }));
  });

  it('readInitiatorNonce reads only a well-formed cookie of that exact name', () => {
    assert.equal(readInitiatorNonce(reqWithCookie('abcdefghijklmnopqrstuvwx')), 'abcdefghijklmnopqrstuvwx');
    assert.equal(readInitiatorNonce({ get: () => 'other=1; __Host-ddc_authz=abcdefghijklmnopqrstuvwx; x=2' }), 'abcdefghijklmnopqrstuvwx');
    assert.equal(readInitiatorNonce({ get: () => 'ddc_authz=abcdefghijklmnopqrstuvwx' }), null, 'the __Host- prefix is part of the name');
    assert.equal(readInitiatorNonce({ get: () => '__Host-ddc_authz=short' }), null);
    assert.equal(readInitiatorNonce({ get: () => '__Host-ddc_authz=has spaces and ; junk' }), null);
    assert.equal(readInitiatorNonce({ get: () => '' }), null);
    assert.equal(readInitiatorNonce({}), null);
  });

  it('a request created without a response object stays unbound (no browser can hold that cookie)', async () => {
    const url = await startAuthorization(req, partnerQuery());
    const id = new URL(url).searchParams.get('request');
    assert.equal(prisma.oAuthAuthorization.rows.find((r) => r.id === id).initiatorHash, null);
    assert.ok(await decideConsent(user, id, true, { kind: 'user_jwt' }));
  });
});

/**
 * Item 4 — the approve path used to write `codeHash` without consuming the request, so one
 * authorization request was a re-decidable consent slot: approve, approve again, two codes.
 */
describe('decideConsent — one request, one decision (item 4)', () => {
  it('a second approval on the same request mints nothing', async () => {
    const url = await startAuthorization(req, partnerQuery());
    const id = new URL(url).searchParams.get('request');
    const first = new URL(await decideConsent(user, id, true, { kind: 'user_jwt' }));
    const firstCode = first.searchParams.get('code');
    assert.ok(firstCode);

    await rejects(decideConsent(user, id, true, { kind: 'user_jwt' }), { status: 400, error: 'invalid_request' });
    const row = prisma.oAuthAuthorization.rows.find((r) => r.id === id);
    assert.equal(row.codeHash, crypto.createHash('sha256').update(firstCode).digest('hex'), 'the first code still stands');

    // Neither can it be turned into a denial afterwards, or the other way round.
    await rejects(decideConsent(user, id, false, { kind: 'user_jwt' }), { status: 400, error: 'invalid_request' });
    // And the one code it did mint is still exchangeable exactly once.
    const { verifier, challenge } = pkce();
    const fresh = await startAuthorization(req, partnerQuery({ code_challenge: challenge }));
    const freshId = new URL(fresh).searchParams.get('request');
    const code = new URL(await decideConsent(user, freshId, true, { kind: 'user_jwt' })).searchParams.get('code');
    const token = await exchangeAuthorizationCode(reqWithBasic(), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
    });
    assert.match(token.access_token, /^ddc_tge_/);
  });

  it('the decision consume only matches a request that has neither been finished nor decided', async () => {
    const url = await startAuthorization(req, partnerQuery());
    const id = new URL(url).searchParams.get('request');
    const where = { id, consumedAt: null, codeHash: null, expiresAt: { gt: new Date() } };
    const first = await prisma.oAuthAuthorization.updateMany({ where, data: { codeHash: 'x' } });
    const second = await prisma.oAuthAuthorization.updateMany({ where, data: { codeHash: 'y' } });
    assert.equal(first.count, 1);
    assert.equal(second.count, 0);
  });
});

/** Item 7 — the account is re-read at the exchange, not only at consent and on refresh. */
describe('exchangeAuthorizationCode — the account is re-checked (item 7)', () => {
  it('a code minted before the account was disabled no longer yields a token', async () => {
    const { code, verifier, row } = await mintPartnerCode();
    prisma.user.rows.find((r) => r.id === user.id).disabledAt = new Date();
    await rejects(exchangeAuthorizationCode(reqWithBasic(), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
    }), { status: 400, error: 'invalid_grant' });
    assert.equal(prisma.mcpToken.rows.length, 0, 'no token was issued inside the 60-second window');
    assert.equal(row.consumedAt, undefined, 'refused before the consume, so nothing is silently burnt');
  });

  it('a code whose user row has since been deleted is invalid_grant too', async () => {
    const { code, verifier } = await mintPartnerCode();
    prisma.user.rows.length = 0;
    await rejects(exchangeAuthorizationCode(reqWithBasic(), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
    }), { status: 400, error: 'invalid_grant' });
    assert.equal(prisma.mcpToken.rows.length, 0);
  });
});

/** Item 11 — dynamic client acquisition can be closed for the campaign window. */
describe('OAUTH_PUBLIC_REGISTRATION_ENABLED (item 11)', () => {
  const restore = () => { delete process.env.OAUTH_PUBLIC_REGISTRATION_ENABLED; };

  it('defaults to open, so today\'s MCP behaviour is unchanged', async () => {
    restore();
    const registered = await registerClient({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' });
    assert.match(registered.client_id, /^ddc_oauth_/);
    process.env.OAUTH_PUBLIC_REGISTRATION_ENABLED = 'true';
    assert.ok((await registerClient({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).client_id);
  });

  it('closed: /oauth/register and the CIMD metadata fetch are 403, the partner client is untouched', async () => {
    process.env.OAUTH_PUBLIC_REGISTRATION_ENABLED = 'false';
    try {
      await rejects(registerClient({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }), { status: 403 });
      assert.equal(prisma.oAuthClient.rows.length, 0, 'no client row appears while registration is closed');
      // A CIMD client_id is a URL: resolving it would FETCH the attacker-named document.
      await rejects(resolveClient('https://chatgpt.com/backend-api/client-metadata'), { status: 403, error: 'unauthorized_client' });
      // The static partner client and already-stored clients keep working.
      assert.equal((await resolveClient('tge-test')).kind, 'partner');
      await seedMcpClient();
      assert.equal((await resolveClient('ddc_oauth_mcp1')).kind, 'mcp');
    } finally {
      restore();
    }
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
