const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { MCP_SCOPES, appPublicUrl, mcpEndpointUrl, publicBaseUrl } = require('../constants/lifeContext');
const { hashToken, issueMcpToken, issuePartnerToken, findUserByMcpToken } = require('./mcpTokenService');
const {
  PARTNER_SCOPES,
  PARTNER_DEFAULT_SCOPE,
  PARTNER_TOKEN_PREFIX,
  getPartnerClient,
  isPartnerClient,
  verifyClientSecret,
  parseBasicAuth,
  partnerResourceUrl,
  readPartnerConfig,
} = require('../constants/partnerClient');
const { isCEndSubject } = require('./dataLicenceConsent');

const { createLogger } = require('../utils/logger');

const logger = createLogger('oauthService');

const CODE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TTL_MS = 15 * 60 * 1000;
const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ISSUED_FROM_CODE_TTL_MS = 5 * 60 * 1000;
const PKCE_UNRESERVED = /^[A-Za-z0-9._~-]{43,128}$/;
const PARTNER_STATE_MIN_LENGTH = 22;
const TOKEN_ENDPOINT_AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'];
const CIMD_HOSTS = new Set([
  'chatgpt.com',
  'www.chatgpt.com',
  'claude.ai',
  'www.claude.ai',
  'api.anthropic.com',
  'localhost',
  '127.0.0.1',
]);

class OAuthError extends Error {
  constructor(statusCode, error, description) {
    super(description || error);
    this.statusCode = statusCode;
    this.error = error;
    this.description = description || error;
    this.redirectable = false;
    this.redirectTo = null;
  }
}

/**
 * The consent decision arrived from a browser that did not start this authorization (no
 * `__Host-ddc_authz` cookie, or a different one). NOT an OAuth protocol error: the browser is
 * never redirected anywhere — the Wallet renders "this sign-in was started on another device or
 * browser" and the user restarts from the client. No code is ever minted (item 1).
 */
class ConsentInitiatorError extends Error {
  constructor(reason, { clientName, clientId } = {}) {
    super('This sign-in was started in another browser.');
    this.name = 'ConsentInitiatorError';
    this.code = 'AUTHZ_INITIATOR_MISMATCH';
    this.statusCode = 409;
    this.reason = reason; // 'missing' | 'mismatch'
    this.clientName = clientName || null;
    this.clientId = clientId || null;
  }
}

// ---------------------------------------------------------------------------
// Authorization-request ↔ browser binding (item 1)
// ---------------------------------------------------------------------------

/**
 * `__Host-` prefix: the cookie is then accepted by the browser only when it is Secure, has
 * Path=/ and carries NO Domain, i.e. it cannot be planted by a sibling host or a sub-domain —
 * which is exactly the property this binding needs. HttpOnly keeps it out of script, SameSite=Lax
 * keeps it off cross-site requests while still travelling on the Wallet's same-site XHR to the
 * API (app.datadance.ai → api.datadance.ai is cross-ORIGIN but same SITE).
 */
const AUTHZ_COOKIE_NAME = '__Host-ddc_authz';
const AUTHZ_NONCE_BYTES = 32;
const AUTHZ_COOKIE_TTL_MS = 30 * 60 * 1000;
const AUTHZ_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function newInitiatorNonce() {
  return crypto.randomBytes(AUTHZ_NONCE_BYTES).toString('base64url');
}

function hashInitiator(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('hex');
}

function sameHash(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** The initiator nonce this request carries, or null. No cookie parser is mounted app-wide. */
function readInitiatorNonce(req) {
  const header = (req && typeof req.get === 'function' ? req.get('cookie') : req?.headers?.cookie) || '';
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== AUTHZ_COOKIE_NAME) continue;
    const value = part.slice(idx + 1).trim();
    return AUTHZ_NONCE_PATTERN.test(value) ? value : null;
  }
  return null;
}

/**
 * One nonce per BROWSER, not per authorization: an existing, well-formed cookie is reused (and
 * its lifetime refreshed) so two sign-ins started in two tabs can both be completed. The value
 * is opaque, carries nothing about the user, and is only ever compared against stored hashes.
 */
function bindInitiator(req, res) {
  const existing = readInitiatorNonce(req);
  const nonce = existing || newInitiatorNonce();
  if (res && typeof res.cookie === 'function') {
    res.cookie(AUTHZ_COOKIE_NAME, nonce, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: AUTHZ_COOKIE_TTL_MS,
    });
    return nonce;
  }
  // No response object (service-level callers, e.g. tests): the row stays unbound rather than
  // being bound to a nonce no browser will ever present.
  return null;
}

/**
 * Marks an authorize-time error as "safe to redirect": client and redirect_uri were already
 * validated, so the OAuth error may travel back to the client (contract T09). Pre-validation
 * errors stay non-redirectable and render as a 400 page (T08, RFC 9700 §4.11).
 */
function markRedirectable(error, { redirectUri, state, iss }) {
  error.redirectable = true;
  error.redirectTo = appendQuery(redirectUri, {
    error: error.error,
    error_description: error.description,
    state,
    iss,
  });
  return error;
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomSecret(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

function verifyS256(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  const left = Buffer.from(computed);
  const right = Buffer.from(String(challenge));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function appendQuery(uri, params) {
  const url = new URL(uri);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function sameResource(a, b) {
  return String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, '');
}

function issuerFrom(req) {
  return publicBaseUrl(req);
}

/** The issuer a stored request belongs to: resource is always `${issuer}/mcp` or `${issuer}/partner/tge`. */
function issuerFromResource(resource) {
  try {
    const url = new URL(resource);
    return `${url.protocol}//${url.host}`;
  } catch {
    return String(resource || '').replace(/\/(mcp|partner\/tge)\/?$/, '');
  }
}

function metadataDocuments(req) {
  const issuer = issuerFrom(req);
  const resource = mcpEndpointUrl(req);
  const partnerResource = partnerResourceUrl(req);
  const partnerCfg = readPartnerConfig();
  const as = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...MCP_SCOPES, ...PARTNER_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: TOKEN_ENDPOINT_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: TOKEN_ENDPOINT_AUTH_METHODS,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
    service_documentation: `${appPublicUrl()}/updates.html`,
  };
  if (partnerCfg.environment) as.ddc_sso_environment = partnerCfg.environment;
  const resourceDoc = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: MCP_SCOPES,
    resource_documentation: `${appPublicUrl()}/user/life-capsule`,
  };
  const partnerResourceDoc = {
    resource: partnerResource,
    resource_name: 'DataDance partner API (TGE)',
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...PARTNER_SCOPES],
  };
  return { issuer, resource, partnerResource, as, resourceDoc, partnerResourceDoc };
}

function challengeHeader(req) {
  const metadata = `${issuerFrom(req)}/.well-known/oauth-protected-resource`;
  return `Bearer realm="data-dance", resource_metadata="${metadata}", scope="life_capsule"`;
}

function normalizeScope(value) {
  const requested = String(value || '')
    .split(/[\s+]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = requested.filter((item) => MCP_SCOPES.includes(item));
  return (allowed.length ? allowed : ['life_capsule', 'openid', 'email']).join(' ');
}

/**
 * Partner scopes: default `tge:identity`; `tge:status` unlocks /partner/tge/status. Anything
 * else — in particular `openid` — is refused so no vendor library ever expects an id_token.
 */
function parsePartnerScope(value) {
  const requested = String(value || '')
    .split(/[\s+]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!requested.length) return PARTNER_DEFAULT_SCOPE;
  const unknown = requested.filter((item) => !PARTNER_SCOPES.includes(item));
  if (unknown.includes('openid')) {
    throw new OAuthError(400, 'invalid_scope', 'openid is not available for this client; read identity from /partner/tge/me.');
  }
  if (unknown.length) {
    throw new OAuthError(400, 'invalid_scope', `Unknown scope: ${unknown.join(' ')}.`);
  }
  return PARTNER_SCOPES.filter((item) => requested.includes(item)).join(' ');
}

/**
 * The granted scope as a list the consent page can render one line per item — "your e-mail
 * address", "your points balance" — instead of showing the raw `tge:email tge:points` string.
 * The `tge:` prefix is dropped because it is an implementation detail of the client, not
 * something a user should have to read; the order follows PARTNER_SCOPES so the list is stable
 * whatever order the partner asked in. The copy itself lives in the Wallet.
 */
function scopeItems(scope, partner) {
  const granted = new Set(String(scope || '').split(/\s+/).filter(Boolean));
  if (!partner) return [...granted];
  return PARTNER_SCOPES.filter((item) => granted.has(item)).map((item) => item.replace(/^tge:/, ''));
}

function isAllowedRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * Kill switch for dynamic client acquisition (item 11). Default ON, so today's MCP behaviour is
 * unchanged; set OAUTH_PUBLIC_REGISTRATION_ENABLED=false for the campaign window and both
 * `POST /oauth/register` and the CIMD metadata fetch answer 403 — no new client can appear
 * while money is on the line. The static partner client and stored clients are unaffected.
 */
function publicRegistrationEnabled(env = process.env) {
  return String(env.OAUTH_PUBLIC_REGISTRATION_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

async function loadCimdClient(clientId) {
  if (!publicRegistrationEnabled()) {
    throw new OAuthError(403, 'unauthorized_client', 'Client metadata documents are not accepted right now.');
  }
  const url = new URL(clientId);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new OAuthError(400, 'invalid_client', 'CIMD client_id must be HTTPS.');
  }
  if (!CIMD_HOSTS.has(url.hostname) && !url.hostname.endsWith('.chatgpt.com') && !url.hostname.endsWith('.anthropic.com')) {
    throw new OAuthError(400, 'invalid_client', 'Unknown client metadata host.');
  }
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new OAuthError(400, 'invalid_client', 'Client metadata could not be loaded.');
  const doc = await response.json();
  const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map(String) : [];
  return {
    kind: 'mcp',
    clientId,
    clientName: String(doc.client_name || doc.client_id || 'ChatGPT / Claude'),
    redirectUris,
    tokenEndpointAuthMethod: 'none',
    clientUri: String(doc.client_uri || clientId),
  };
}

/**
 * Static partner client first (env), then DCR rows, then CIMD documents. A disabled partner
 * client is `unauthorized_client`, not "unknown", so the failure is diagnosable (T13/T17).
 */
async function resolveClient(clientId, req) {
  const id = String(clientId || '').trim();
  if (!id) throw new OAuthError(400, 'invalid_client', 'client_id is required.');
  const partner = getPartnerClient(id, req);
  if (partner) {
    if (!partner.enabled) throw new OAuthError(400, 'unauthorized_client', 'This client is disabled.');
    return partner;
  }
  const stored = await prisma.oAuthClient.findUnique({ where: { clientId: id } });
  if (stored) {
    return {
      kind: 'mcp',
      clientId: stored.clientId,
      clientName: stored.clientName,
      redirectUris: stored.redirectUris,
      tokenEndpointAuthMethod: stored.tokenEndpointAuthMethod,
      clientUri: stored.clientUri,
    };
  }
  if (id.startsWith('https://') || id.startsWith('http://localhost') || id.startsWith('http://127.0.0.1')) {
    return loadCimdClient(id);
  }
  throw new OAuthError(400, 'invalid_client', 'Unknown client_id.');
}

/** Exact string match against a NON-EMPTY registered list, for every client (RFC 9700 §4.1.3). */
function assertRedirect(client, redirectUri) {
  const uri = String(redirectUri || '');
  if (!uri || !isAllowedRedirect(uri)) {
    throw new OAuthError(400, 'invalid_request', 'redirect_uri is not allowed.');
  }
  const registered = Array.isArray(client.redirectUris) ? client.redirectUris : [];
  if (!registered.length || !registered.includes(uri)) {
    throw new OAuthError(400, 'invalid_request', 'redirect_uri is not registered for this client.');
  }
}

async function registerClient(body) {
  if (!publicRegistrationEnabled()) {
    throw new OAuthError(403, 'access_denied', 'Dynamic client registration is closed.');
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirectUris.length || redirectUris.some((uri) => !isAllowedRedirect(uri))) {
    throw new OAuthError(400, 'invalid_redirect_uri', 'A valid redirect_uris array is required.');
  }
  const clientId = randomSecret('ddc_oauth_');
  const row = await prisma.oAuthClient.create({
    data: {
      clientId,
      clientName: String(body.client_name || 'MCP client').slice(0, 120),
      redirectUris,
      tokenEndpointAuthMethod: 'none',
      clientUri: String(body.client_uri || ''),
    },
  });
  return {
    client_id: row.clientId,
    client_name: row.clientName,
    redirect_uris: row.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
  };
}

function plausibleLoginHint(value) {
  const hint = String(value || '').trim();
  return hint.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hint) ? hint : '';
}

/**
 * Validation order (contract /oauth/authorize):
 *  1. client_id unknown/disabled, redirect_uri not an exact match → throws non-redirectable (400 page).
 *  2. everything else → throws redirectable (302 back with error, state, iss).
 *  3. store the request and send the browser to the Wallet consent page.
 *
 * `res` (when present) also receives the `__Host-ddc_authz` initiator cookie, whose sha256 is
 * stored on the row: the consent decision must come back from this browser (item 1).
 */
async function startAuthorization(req, query, res) {
  const client = await resolveClient(query.client_id, req);
  assertRedirect(client, query.redirect_uri);

  const partner = isPartnerClient(client);
  const redirectUri = String(query.redirect_uri);
  const state = query.state === undefined || query.state === null ? '' : String(query.state);
  const iss = issuerFrom(req);
  let row;
  try {
    if (query.response_type !== 'code') {
      throw new OAuthError(400, 'unsupported_response_type', 'Only response_type=code is supported.');
    }
    if (partner) {
      if (!state) throw new OAuthError(400, 'invalid_request', 'state is required.');
      // Contract v0.2.1: minLength 22 (>= 128 bits as base64url), maxLength 512. Partner only —
      // MCP public clients are not under this contract and keep accepting any state.
      if (state.length < PARTNER_STATE_MIN_LENGTH) {
        throw new OAuthError(400, 'invalid_request', `state must carry at least 128 bits of entropy (${PARTNER_STATE_MIN_LENGTH}+ characters).`);
      }
      if (state.length > 512) throw new OAuthError(400, 'invalid_request', 'state must be at most 512 characters.');
    }
    if (query.code_challenge_method !== 'S256' || !query.code_challenge) {
      throw new OAuthError(400, 'invalid_request', 'PKCE S256 is required.');
    }
    if (partner && !PKCE_UNRESERVED.test(String(query.code_challenge))) {
      throw new OAuthError(400, 'invalid_request', 'code_challenge must be 43-128 unreserved characters.');
    }
    if (partner && query.prompt !== undefined && !['none', 'login'].includes(String(query.prompt))) {
      throw new OAuthError(400, 'invalid_request', 'prompt must be none or login.');
    }
    if (partner && String(query.prompt) === 'none') {
      // The authorization server holds no browser session of its own (the DataDance login
      // lives in the Wallet SPA), so a silent authorization can never be satisfied here.
      throw new OAuthError(400, 'login_required', 'No DataDance session is available for a silent authorization.');
    }
    const expected = partner ? client.resource : mcpEndpointUrl(req);
    const resource = String(query.resource || expected);
    if (!sameResource(resource, expected)) {
      throw new OAuthError(400, 'invalid_target', partner ? 'resource must match the partner API.' : 'resource must match the MCP endpoint.');
    }
    const scope = partner ? parsePartnerScope(query.scope) : normalizeScope(query.scope);
    // Bind BEFORE the row is written, so a row never exists without the hash of the cookie that
    // was actually set on this response.
    const initiatorNonce = bindInitiator(req, res);
    row = await prisma.oAuthAuthorization.create({
      data: {
        clientId: client.clientId,
        redirectUri,
        state,
        codeChallenge: String(query.code_challenge),
        codeChallengeMethod: 'S256',
        resource: expected,
        scope,
        expiresAt: new Date(Date.now() + (client.requestTtlMs || REQUEST_TTL_MS)),
        initiatorHash: initiatorNonce ? hashInitiator(initiatorNonce) : null,
        initiatorBoundAt: initiatorNonce ? new Date() : null,
        initiatorMismatchCount: 0,
      },
    });
  } catch (error) {
    if (error instanceof OAuthError) markRedirectable(error, { redirectUri, state, iss });
    throw error;
  }
  const consent = new URL(`${appPublicUrl()}/oauth/consent`);
  consent.searchParams.set('request', row.id);
  const loginHint = partner ? plausibleLoginHint(query.login_hint) : '';
  if (loginHint) consent.searchParams.set('login_hint', loginHint);
  return consent.toString();
}

async function getConsentRequest(id) {
  const row = await prisma.oAuthAuthorization.findUnique({ where: { id } });
  if (!row || row.consumedAt || row.expiresAt < new Date()) {
    throw new OAuthError(404, 'invalid_request', 'This authorization request has expired.');
  }
  const partner = getPartnerClient(row.clientId);
  if (partner && !partner.enabled) {
    throw new OAuthError(400, 'unauthorized_client', 'This client is disabled.');
  }
  let clientName = partner ? partner.clientName : 'ChatGPT / Claude';
  if (!partner) {
    try {
      const client = await resolveClient(row.clientId);
      clientName = client.clientName;
    } catch {
      clientName = row.clientId.startsWith('https://') ? new URL(row.clientId).hostname : clientName;
    }
  }
  return {
    id: row.id,
    clientName,
    clientId: row.clientId,
    kind: partner ? 'partner' : 'assistant',
    scope: row.scope,
    scopeItems: scopeItems(row.scope, partner),
    resource: row.resource,
    expiresAt: row.expiresAt,
  };
}

/**
 * @param ctx { kind: 'user_jwt' | 'sso_ticket', claims?: object, clientId?: string,
 *              initiatorNonce?: string }
 *   `claims` are the verified DDC JWT claims (`ver` >= 2 marks a Web3Auth-verified login);
 *   `clientId` is the client an SSO ticket session is bound to (Phase 3);
 *   `initiatorNonce` is the `__Host-ddc_authz` cookie of the deciding browser (item 1).
 */
async function decideConsent(user, requestId, allow, ctx = {}) {
  // A missing/malformed id is the caller's error (400), never a Prisma validation error (500).
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) {
    throw new OAuthError(400, 'invalid_request', 'requestId is required.');
  }
  const row = await prisma.oAuthAuthorization.findUnique({ where: { id: requestId } });
  // `codeHash` set = this request was already decided and is now a live code, not a consent slot.
  if (!row || row.consumedAt || row.codeHash || row.expiresAt < new Date()) {
    throw new OAuthError(400, 'invalid_request', 'This authorization request has expired.');
  }
  const issuer = issuerFromResource(row.resource);
  const client = await resolveClient(row.clientId);
  const partner = isPartnerClient(client);
  const principal = ctx && ctx.kind ? ctx.kind : 'user_jwt';
  // An SSO session may only answer for the client it was minted for (T11.6): 403, never a
  // decision on someone else's request.
  if (principal === 'sso_ticket' && ctx.clientId && ctx.clientId !== row.clientId) {
    throw new OAuthError(403, 'access_denied', 'This session is bound to a different client.');
  }

  // Every terminal answer consumes the request atomically: one authorization request is ONE
  // decision, whatever that decision was (item 4 — the approve path used to leave the row
  // decidable, so a second approval minted a second code).
  const finish = async (params) => {
    const consumed = await prisma.oAuthAuthorization.updateMany({
      where: { id: row.id, consumedAt: null, codeHash: null },
      data: { consumedAt: new Date(), userId: user.id },
    });
    if (!consumed || consumed.count !== 1) {
      throw new OAuthError(400, 'invalid_request', 'This authorization request has expired.');
    }
    return appendQuery(row.redirectUri, { ...params, state: row.state, iss: issuer });
  };

  // A denial is accepted from any browser: it only ever destroys the request, and refusing it
  // would leave a fixated request alive for the attacker.
  if (!allow) return finish({ error: 'access_denied' });

  // The approval must come back from the browser that STARTED this authorization, or the code
  // would be minted into an authorization someone else set up (RFC 9700 §4.14 request fixation).
  if (row.initiatorHash) {
    const presented = ctx && ctx.initiatorNonce ? hashInitiator(ctx.initiatorNonce) : '';
    if (!sameHash(presented, row.initiatorHash)) {
      const reason = presented ? 'mismatch' : 'missing';
      try {
        await prisma.oAuthAuthorization.updateMany({
          where: { id: row.id },
          data: { initiatorMismatchCount: Number(row.initiatorMismatchCount || 0) + 1 },
        });
      } catch {
        // telemetry only; the refusal below stands either way
      }
      logger.warn('oauth.authz_initiator_mismatch', {
        requestId: row.id,
        clientId: row.clientId,
        userId: user.id,
        reason,
        mismatchCount: Number(row.initiatorMismatchCount || 0) + 1,
      });
      throw new ConsentInitiatorError(reason, { clientName: client.clientName, clientId: row.clientId });
    }
  }

  if (user.disabledAt) {
    return finish({ error: 'access_denied', error_description: 'This account is disabled.' });
  }
  if (partner) {
    if (!isCEndSubject(user)) {
      return finish({ error: 'access_denied', error_description: 'Organization accounts cannot sign in to this partner.' });
    }
    const verified = Number(ctx?.claims?.ver) >= 2;
    if (client.requireVerifiedSession && principal === 'user_jwt' && !verified) {
      return finish({ error: 'login_required', error_description: 'A verified DataDance login is required.' });
    }
  }

  const code = randomSecret('ddc_code_');
  // Atomic single-decision consume, exactly as the code-exchange path consumes the code: the
  // where clause requires a request that has neither been finished nor already carries a code,
  // so a second "allow" on the same request affects 0 rows and mints nothing (item 4).
  const decided = await prisma.oAuthAuthorization.updateMany({
    where: { id: row.id, consumedAt: null, codeHash: null, expiresAt: { gt: new Date() } },
    data: {
      userId: user.id,
      codeHash: hashSecret(code),
      expiresAt: new Date(Date.now() + (client.codeTtlMs || CODE_TTL_MS)),
    },
  });
  if (!decided || decided.count !== 1) {
    throw new OAuthError(400, 'invalid_request', 'This authorization request has expired.');
  }
  return appendQuery(row.redirectUri, { code, state: row.state, iss: issuer });
}

/**
 * Client credentials as presented on the token / revocation endpoint (RFC 6749 §2.3.1).
 * Basic wins; a body `client_id` next to Basic must agree; a body `client_secret` next to
 * Basic is a second authentication method and is refused.
 */
function presentedClientCredentials(req, body = {}) {
  const header = req && typeof req.get === 'function' ? req.get('authorization') : req?.headers?.authorization;
  const basic = parseBasicAuth(header);
  const bodyId = body.client_id !== undefined && body.client_id !== null ? String(body.client_id) : '';
  const bodySecret = body.client_secret !== undefined && body.client_secret !== null ? String(body.client_secret) : '';
  if (basic) {
    if (bodySecret) throw new OAuthError(400, 'invalid_request', 'Use only one client authentication method.');
    if (bodyId && bodyId !== basic.clientId) {
      throw new OAuthError(400, 'invalid_request', 'client_id does not match the Basic credentials.');
    }
    return { clientId: basic.clientId, clientSecret: basic.clientSecret, method: 'client_secret_basic' };
  }
  if (bodyId) {
    return { clientId: bodyId, clientSecret: bodySecret, method: bodySecret ? 'client_secret_post' : 'none' };
  }
  return null;
}

/** 401 invalid_client unless the secret verifies AND the client is enabled (contract /oauth/token 401). */
function authenticatePartnerClient(client, presented) {
  if (!presented || !presented.clientSecret) {
    throw new OAuthError(401, 'invalid_client', 'Client authentication is required.');
  }
  if (!verifyClientSecret(client, presented.clientSecret)) {
    throw new OAuthError(401, 'invalid_client', 'Invalid client credentials.');
  }
  if (!client.enabled) {
    throw new OAuthError(401, 'invalid_client', 'This client is disabled.');
  }
}

/**
 * Which tokens came out of which authorization code, so a replayed code can revoke them
 * (RFC 6749 §4.1.2, contract T10). In-process only (single instance, see plan D10): after a
 * restart a replay is still refused with invalid_grant, only the best-effort revocation is
 * lost. Entries expire 5 minutes after issue (the partner token itself lives 300 s).
 */
const issuedTokensByCode = new Map();

function rememberIssuedToken(codeRowId, entry) {
  const now = Date.now();
  for (const [key, value] of issuedTokensByCode) {
    if (value.expiresAt <= now) issuedTokensByCode.delete(key);
  }
  issuedTokensByCode.set(codeRowId, { ...entry, expiresAt: now + ISSUED_FROM_CODE_TTL_MS });
}

async function revokeTokensIssuedFromCode(codeRowId) {
  const entry = issuedTokensByCode.get(codeRowId);
  if (!entry) return false;
  issuedTokensByCode.delete(codeRowId);
  try {
    if (entry.refreshHash) {
      await prisma.oAuthRefreshToken.updateMany({
        where: { tokenHash: entry.refreshHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    if (entry.tokenHash) {
      await prisma.mcpToken.deleteMany({ where: { tokenHash: entry.tokenHash } });
    }
  } catch {
    // best effort: the replay is refused regardless
  }
  return true;
}

async function exchangeAuthorizationCode(req, body) {
  const code = String(body.code || '');
  const verifier = String(body.code_verifier || '');
  if (!code || !verifier) throw new OAuthError(400, 'invalid_request', 'code and code_verifier are required.');

  // Partner client authentication happens BEFORE the code lookup (RFC 6749 §4.1.3): the
  // presented client_id decides whether credentials are required at all.
  const presented = presentedClientCredentials(req, body);
  const presentedPartner = presented?.clientId ? getPartnerClient(presented.clientId, req) : null;
  if (presentedPartner) authenticatePartnerClient(presentedPartner, presented);

  const row = await prisma.oAuthAuthorization.findUnique({ where: { codeHash: hashSecret(code) } });
  if (!row || !row.userId) {
    throw new OAuthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
  }
  if (row.consumedAt) {
    await revokeTokensIssuedFromCode(row.id);
    throw new OAuthError(400, 'invalid_grant', 'Authorization code has already been used.');
  }
  if (row.expiresAt < new Date()) {
    throw new OAuthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
  }

  const rowPartner = getPartnerClient(row.clientId, req);
  if (rowPartner) {
    if (!presentedPartner || presentedPartner.clientId !== row.clientId) {
      throw new OAuthError(401, 'invalid_client', 'Client authentication is required for this code.');
    }
    if (!body.redirect_uri || String(body.redirect_uri) !== row.redirectUri) {
      throw new OAuthError(400, 'invalid_grant', 'redirect_uri must equal the one used at /oauth/authorize.');
    }
    if (!PKCE_UNRESERVED.test(verifier)) {
      throw new OAuthError(400, 'invalid_grant', 'code_verifier must be 43-128 unreserved characters.');
    }
  } else {
    if (presentedPartner) {
      throw new OAuthError(400, 'invalid_grant', 'client_id does not match this code.');
    }
    if (body.client_id && String(body.client_id) !== row.clientId) {
      throw new OAuthError(400, 'invalid_client', 'client_id does not match this code.');
    }
    if (body.redirect_uri && String(body.redirect_uri) !== row.redirectUri) {
      throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match this code.');
    }
  }
  if (!verifyS256(verifier, row.codeChallenge)) {
    throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed.');
  }
  if (body.resource && !sameResource(body.resource, row.resource)) {
    throw new OAuthError(400, 'invalid_target', 'resource does not match this code.');
  }

  // The account is re-read HERE, not only at consent and on refresh: between the consent click
  // and this exchange there is a whole code lifetime (60 s for the partner) in which support can
  // disable the account, and a token minted after that decision would outlive it (item 7).
  const account = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!account || account.disabledAt) {
    logger.warn('oauth.code_exchange_refused', { reason: account ? 'account_disabled' : 'account_missing', clientId: row.clientId, userId: row.userId });
    throw new OAuthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
  }

  // Atomic single-use consume: exactly one concurrent exchange can win (contract T10).
  const consumed = await prisma.oAuthAuthorization.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (!consumed || consumed.count !== 1) {
    throw new OAuthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
  }
  return issueOAuthTokens(row.userId, row.clientId, row.resource, row.scope, { codeRowId: row.id, client: rowPartner, req });
}

async function issueOAuthTokens(userId, clientId, resource, scope, { codeRowId, client, req } = {}) {
  const partner = client || getPartnerClient(clientId, req);
  if (isPartnerClient(partner)) {
    const issued = await issuePartnerToken(userId, partner, { resource, scope });
    if (codeRowId) rememberIssuedToken(codeRowId, { tokenHash: hashToken(issued.token) });
    return {
      access_token: issued.token,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      scope,
      resource,
    };
  }
  let clientName = 'ChatGPT / Claude';
  try {
    clientName = (await resolveClient(clientId)).clientName;
  } catch {
    clientName = 'ChatGPT / Claude';
  }
  const issued = await issueMcpToken(userId, clientName, {
    source: 'oauth',
    clientId,
    resource,
    scope,
    expiresAt: new Date(Date.now() + ACCESS_TTL_SEC * 1000),
  });
  const refresh = randomSecret('ddc_rt_');
  await prisma.oAuthRefreshToken.create({
    data: {
      tokenHash: hashToken(refresh),
      userId,
      clientId,
      mcpTokenId: issued.id,
      resource,
      scope,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  if (codeRowId) rememberIssuedToken(codeRowId, { tokenHash: hashToken(issued.token), refreshHash: hashToken(refresh) });
  return {
    access_token: issued.token,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refresh,
    scope,
    resource,
  };
}

async function exchangeRefreshToken(body) {
  const raw = String(body.refresh_token || '');
  if (!raw) throw new OAuthError(400, 'invalid_request', 'refresh_token is required.');
  const row = await prisma.oAuthRefreshToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!row || row.revokedAt || row.expiresAt < new Date()) {
    throw new OAuthError(400, 'invalid_grant', 'Refresh token is invalid or expired.');
  }
  if (getPartnerClient(row.clientId)) {
    // Partner clients never receive refresh tokens; a row like this cannot legitimately exist.
    throw new OAuthError(400, 'invalid_grant', 'Refresh tokens are not available for this client.');
  }
  if (body.client_id && String(body.client_id) !== row.clientId) {
    throw new OAuthError(400, 'invalid_client', 'client_id does not match this refresh token.');
  }
  // A refresh token must not outlive the account: disabling a user has to end every session it
  // can still mint, not only the ones already issued.
  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user || user.disabledAt) {
    throw new OAuthError(400, 'invalid_grant', 'Refresh token is invalid or expired.');
  }
  await prisma.oAuthRefreshToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });
  return issueOAuthTokens(row.userId, row.clientId, row.resource, row.scope);
}

/**
 * RFC 7009. Partner tokens (`ddc_tge_`) require client authentication and can only be revoked
 * by the client they were issued to; MCP paths are unchanged (possession is the credential).
 * Unknown tokens are a silent success.
 */
async function revokeToken(token, { req, body } = {}) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return;
  if (trimmed.startsWith(PARTNER_TOKEN_PREFIX)) {
    const presented = presentedClientCredentials(req, body || {});
    const client = presented?.clientId ? getPartnerClient(presented.clientId, req) : null;
    if (!client || !presented.clientSecret || !verifyClientSecret(client, presented.clientSecret)) {
      throw new OAuthError(401, 'invalid_client', 'Client authentication is required to revoke a partner token.');
    }
    const access = await prisma.mcpToken.findUnique({ where: { tokenHash: hashToken(trimmed) } });
    if (access && access.source === 'partner' && access.clientId === client.clientId) {
      await prisma.mcpToken.delete({ where: { id: access.id } });
    }
    return;
  }
  const refresh = await prisma.oAuthRefreshToken.findUnique({ where: { tokenHash: hashToken(trimmed) } });
  if (refresh) {
    await prisma.oAuthRefreshToken.update({
      where: { id: refresh.id },
      data: { revokedAt: new Date() },
    });
    return;
  }
  const access = await prisma.mcpToken.findUnique({ where: { tokenHash: hashToken(trimmed) } });
  if (access) {
    await prisma.mcpToken.delete({ where: { id: access.id } });
  }
}

async function userInfoFromBearer(token) {
  const user = await findUserByMcpToken(token);
  if (!user) throw new OAuthError(401, 'invalid_token', 'Access token is invalid.');
  return {
    sub: user.id,
    email: user.email || undefined,
    email_verified: Boolean(user.email),
    name: user.email || 'DataDance user',
  };
}

module.exports = {
  OAuthError,
  ConsentInitiatorError,
  AUTHZ_COOKIE_NAME,
  readInitiatorNonce,
  publicRegistrationEnabled,
  metadataDocuments,
  challengeHeader,
  registerClient,
  startAuthorization,
  getConsentRequest,
  decideConsent,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  revokeToken,
  userInfoFromBearer,
  verifyS256,
  // exported for tests and the partner routes
  resolveClient,
  assertRedirect,
  parsePartnerScope,
  presentedClientCredentials,
  markRedirectable,
  issuerFromResource,
  sameResource,
  issuedTokensByCode,
};
