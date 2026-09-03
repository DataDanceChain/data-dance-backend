const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { MCP_SCOPES, appPublicUrl, mcpEndpointUrl, publicBaseUrl } = require('../constants/lifeContext');
const { hashToken, issueMcpToken, findUserByMcpToken } = require('./mcpTokenService');

const CODE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TTL_MS = 15 * 60 * 1000;
const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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
  }
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

function issuerFrom(req) {
  return publicBaseUrl(req);
}

function metadataDocuments(req) {
  const issuer = issuerFrom(req);
  const resource = mcpEndpointUrl(req);
  const as = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: MCP_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${appPublicUrl()}/updates.html`,
  };
  const resourceDoc = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: MCP_SCOPES,
    resource_documentation: `${appPublicUrl()}/user/life-capsule`,
  };
  return { issuer, resource, as, resourceDoc };
}

function challengeHeader(req) {
  const { resourceDoc } = metadataDocuments(req);
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

function isAllowedRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

async function loadCimdClient(clientId) {
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
    clientId,
    clientName: String(doc.client_name || doc.client_id || 'ChatGPT / Claude'),
    redirectUris,
    tokenEndpointAuthMethod: 'none',
    clientUri: String(doc.client_uri || clientId),
  };
}

async function resolveClient(clientId) {
  const id = String(clientId || '').trim();
  if (!id) throw new OAuthError(400, 'invalid_client', 'client_id is required.');
  const stored = await prisma.oAuthClient.findUnique({ where: { clientId: id } });
  if (stored) {
    return {
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

function assertRedirect(client, redirectUri) {
  if (!redirectUri || !isAllowedRedirect(redirectUri)) {
    throw new OAuthError(400, 'invalid_request', 'redirect_uri is not allowed.');
  }
  if (client.redirectUris.length && !client.redirectUris.includes(redirectUri)) {
    throw new OAuthError(400, 'invalid_request', 'redirect_uri is not registered for this client.');
  }
}

async function registerClient(body) {
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

async function startAuthorization(req, query) {
  if (query.response_type !== 'code') {
    throw new OAuthError(400, 'unsupported_response_type', 'Only response_type=code is supported.');
  }
  if (query.code_challenge_method !== 'S256' || !query.code_challenge) {
    throw new OAuthError(400, 'invalid_request', 'PKCE S256 is required.');
  }
  const client = await resolveClient(query.client_id);
  assertRedirect(client, query.redirect_uri);
  const resource = String(query.resource || mcpEndpointUrl(req));
  const expected = mcpEndpointUrl(req);
  if (resource !== expected && resource.replace(/\/$/, '') !== expected.replace(/\/$/, '')) {
    throw new OAuthError(400, 'invalid_target', 'resource must match the MCP endpoint.');
  }
  const row = await prisma.oAuthAuthorization.create({
    data: {
      clientId: client.clientId,
      redirectUri: query.redirect_uri,
      state: String(query.state || ''),
      codeChallenge: String(query.code_challenge),
      codeChallengeMethod: 'S256',
      resource,
      scope: normalizeScope(query.scope),
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    },
  });
  return `${appPublicUrl()}/oauth/consent?request=${row.id}`;
}

async function getConsentRequest(id) {
  const row = await prisma.oAuthAuthorization.findUnique({ where: { id } });
  if (!row || row.consumedAt || row.expiresAt < new Date()) {
    throw new OAuthError(404, 'invalid_request', 'This authorization request has expired.');
  }
  let clientName = 'ChatGPT / Claude';
  try {
    const client = await resolveClient(row.clientId);
    clientName = client.clientName;
  } catch {
    clientName = row.clientId.startsWith('https://') ? new URL(row.clientId).hostname : clientName;
  }
  return {
    id: row.id,
    clientName,
    clientId: row.clientId,
    scope: row.scope,
    resource: row.resource,
  };
}

async function decideConsent(user, requestId, allow) {
  const row = await prisma.oAuthAuthorization.findUnique({ where: { id: requestId } });
  if (!row || row.consumedAt || row.expiresAt < new Date()) {
    throw new OAuthError(400, 'invalid_request', 'This authorization request has expired.');
  }
  let issuer = '';
  try {
    const resourceUrl = new URL(row.resource);
    issuer = `${resourceUrl.protocol}//${resourceUrl.host}`;
  } catch {
    issuer = row.resource.replace(/\/mcp\/?$/, '');
  }
  if (!allow) {
    await prisma.oAuthAuthorization.update({
      where: { id: row.id },
      data: { consumedAt: new Date(), userId: user.id },
    });
    return appendQuery(row.redirectUri, {
      error: 'access_denied',
      state: row.state,
      iss: issuer,
    });
  }
  const code = randomSecret('ddc_code_');
  await prisma.oAuthAuthorization.update({
    where: { id: row.id },
    data: {
      userId: user.id,
      codeHash: hashSecret(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return appendQuery(row.redirectUri, {
    code,
    state: row.state,
    iss: issuer,
  });
}

async function exchangeAuthorizationCode(req, body) {
  const code = String(body.code || '');
  const verifier = String(body.code_verifier || '');
  if (!code || !verifier) throw new OAuthError(400, 'invalid_request', 'code and code_verifier are required.');
  const row = await prisma.oAuthAuthorization.findUnique({ where: { codeHash: hashSecret(code) } });
  if (!row || row.consumedAt || !row.userId || row.expiresAt < new Date()) {
    throw new OAuthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
  }
  if (body.client_id && String(body.client_id) !== row.clientId) {
    throw new OAuthError(400, 'invalid_client', 'client_id does not match this code.');
  }
  if (body.redirect_uri && String(body.redirect_uri) !== row.redirectUri) {
    throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match this code.');
  }
  if (!verifyS256(verifier, row.codeChallenge)) {
    throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed.');
  }
  if (body.resource && String(body.resource) !== row.resource) {
    throw new OAuthError(400, 'invalid_target', 'resource does not match this code.');
  }
  await prisma.oAuthAuthorization.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });
  return issueOAuthTokens(row.userId, row.clientId, row.resource, row.scope);
}

async function issueOAuthTokens(userId, clientId, resource, scope) {
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
  if (body.client_id && String(body.client_id) !== row.clientId) {
    throw new OAuthError(400, 'invalid_client', 'client_id does not match this refresh token.');
  }
  await prisma.oAuthRefreshToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });
  return issueOAuthTokens(row.userId, row.clientId, row.resource, row.scope);
}

async function revokeToken(token) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return;
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
};
