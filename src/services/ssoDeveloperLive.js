/**
 * Bridge for the API image that predates the partner SSO module.
 * Stores clients with SQL so it does not need a regenerated Prisma client.
 * The repo's ssoDeveloperClient.js is the version the next image build uses.
 */
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { publicBaseUrl } = require('../constants/lifeContext');

const SCOPES = ['sso:identity', 'sso:status', 'sso:email', 'sso:wallet'];
const PARTNER_SCOPES = [
  ...SCOPES,
  'sso:points',
  'sso:referral',
  'sso:referral_network',
  'sso:referral_bind',
];
const PARTNER_STATUS_FIELDS = [
  'registered_at',
  'wallet_bound',
  'email',
  'wallet_address',
  'email_masked',
  'avatar',
  'data_licence_granted',
  'points',
  'referral',
  'referral_network',
];
const TTL_SEC = 300;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fail(OAuthError, status, code, message) {
  if (typeof OAuthError === 'function') return new OAuthError(status, code, message);
  const error = new Error(message);
  error.statusCode = status;
  error.error = code;
  return error;
}

function issuer() {
  return publicBaseUrl();
}

function partnerResource() {
  return `${issuer()}/partner/sso`;
}

function isAllowedRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function cleanRegistration(body) {
  const name = String(body.client_name || '').replace(/[\u0000-\u001f]/g, '').trim();
  const email = String(body.contact_email || '').trim().toLowerCase();
  const list = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const redirectUris = [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))];
  if (name.length < 1 || name.length > 80) {
    const error = new Error('client_name must be 1 to 80 characters.');
    error.status = 400;
    error.code = 'invalid_request';
    throw error;
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('contact_email must be an email address.');
    error.status = 400;
    error.code = 'invalid_request';
    throw error;
  }
  if (!redirectUris.length || redirectUris.length > 5 || redirectUris.some((uri) => uri.length > 512 || !isAllowedRedirect(uri))) {
    const error = new Error('Provide 1 to 5 https redirect URIs, or http on localhost.');
    error.status = 400;
    error.code = 'invalid_redirect_uri';
    throw error;
  }
  return { name, email, redirectUris };
}

function cleanRedirects(value) {
  const list = Array.isArray(value) ? value : [];
  const redirectUris = [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))];
  if (!redirectUris.length || redirectUris.length > 5 || redirectUris.some((uri) => uri.length > 512 || !isAllowedRedirect(uri))) {
    const error = new Error('Provide 1 to 5 https redirect URIs, or http on localhost.');
    error.status = 400;
    error.code = 'invalid_redirect_uri';
    throw error;
  }
  return redirectUris;
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SsoDeveloperClient" (
      "id" TEXT PRIMARY KEY,
      "clientId" TEXT NOT NULL UNIQUE,
      "clientName" TEXT NOT NULL,
      "contactEmail" TEXT NOT NULL,
      "secretHash" TEXT NOT NULL,
      "redirectUris" TEXT[],
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "kind" TEXT NOT NULL DEFAULT 'developer',
      "ownerUserId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "SsoDeveloperClient" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT \'developer\'',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "SsoDeveloperClient" ADD COLUMN IF NOT EXISTS "ownerUserId" TEXT',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "SsoDeveloperClient_contactEmail_idx" ON "SsoDeveloperClient"("contactEmail")',
  );
}

async function loadDeveloperClient(clientId) {
  const id = String(clientId || '').trim();
  if (!id) return null;
  let rows;
  try {
    rows = await prisma.$queryRaw`
      SELECT "clientId", "clientName", "secretHash", enabled, "redirectUris", kind
      FROM "SsoDeveloperClient"
      WHERE "clientId" = ${id}
      LIMIT 1
    `;
  } catch (error) {
    if (/SsoDeveloperClient/.test(String(error && error.message))) return null;
    throw error;
  }
  const row = rows && rows[0];
  if (!row) return null;
  const firstParty = row.kind === 'partner';
  const scopes = firstParty
    ? PARTNER_SCOPES.filter((item) => item !== 'sso:referral_bind' || String(process.env.SSO_TGE_REFERRAL_BIND || '').trim().toLowerCase() === 'true')
    : SCOPES.slice();
  return {
    developer: true,
    firstParty,
    kind: 'partner',
    clientId: row.clientId,
    clientName: row.clientName,
    enabled: Boolean(row.enabled),
    secretHash: row.secretHash,
    redirectUris: Array.isArray(row.redirectUris) ? row.redirectUris : [],
    scopes,
    statusFields: firstParty ? PARTNER_STATUS_FIELDS.slice() : [
      'registered_at', 'wallet_bound', 'email', 'wallet_address', 'email_masked', 'avatar',
    ],
    resource: partnerResource(),
  };
}

function failOwner() {
  const error = new Error('This client is not on this account.');
  error.status = 404;
  error.code = 'not_found';
  throw error;
}

function scopesFor(kind) {
  if (kind !== 'partner') return SCOPES.slice();
  return PARTNER_SCOPES.filter((item) => item !== 'sso:referral_bind' || String(process.env.SSO_TGE_REFERRAL_BIND || '').trim().toLowerCase() === 'true');
}

function presentClient(row) {
  const kind = row.kind === 'partner' ? 'partner' : 'developer';
  return {
    client_id: row.clientId,
    client_name: row.clientName,
    redirect_uris: Array.isArray(row.redirectUris) ? row.redirectUris : [],
    enabled: Boolean(row.enabled),
    kind,
    scopes: scopesFor(kind),
  };
}

async function ownedRow(ownerId, clientId) {
  const id = String(clientId || '').trim();
  const rows = await prisma.$queryRaw`
    SELECT "clientId", "clientName", "redirectUris", enabled, kind, "ownerUserId"
    FROM "SsoDeveloperClient"
    WHERE "clientId" = ${id} AND "ownerUserId" = ${ownerId}
    LIMIT 1
  `;
  return rows && rows[0];
}

async function listOwnedClients(ownerId) {
  await ensureTable();
  const rows = await prisma.$queryRaw`
    SELECT "clientId", "clientName", "redirectUris", enabled, kind
    FROM "SsoDeveloperClient"
    WHERE "ownerUserId" = ${ownerId}
    ORDER BY "createdAt" ASC
  `;
  return rows.map(presentClient);
}

async function createDeveloperClient(body, owner) {
  if (!owner || !owner.id || !owner.email) {
    const error = new Error('Sign in with DataDance first.');
    error.status = 401;
    error.code = 'login_required';
    throw error;
  }
  const cleaned = cleanRegistration({ ...(body || {}), contact_email: owner.email });
  const { name, redirectUris } = cleaned;
  const email = String(owner.email).trim().toLowerCase();
  await ensureTable();
  const recent = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count FROM "SsoDeveloperClient"
    WHERE "createdAt" > NOW() - INTERVAL '1 hour'
  `;
  if (Number(recent && recent[0] && recent[0].count) >= 30) {
    const error = new Error('Too many clients were created this hour. Please wait.');
    error.status = 429;
    error.code = 'rate_limited';
    throw error;
  }
  const clientSecret = `ddc_sso_secret_${crypto.randomBytes(32).toString('base64url')}`;
  const clientId = `sso_${crypto.randomBytes(18).toString('base64url')}`;
  const id = crypto.randomUUID();
  const arrayLiteral = `{${redirectUris.map((uri) => `"${uri.replace(/"/g, '')}"`).join(',')}}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "SsoDeveloperClient"
      ("id","clientId","clientName","contactEmail","secretHash","redirectUris","enabled","kind","ownerUserId")
     VALUES ($1,$2,$3,$4,$5,$6::text[],true,'developer',$7)`,
    id,
    clientId,
    name,
    email,
    sha256(clientSecret),
    arrayLiteral,
    owner.id,
  );
  return {
    clientId,
    clientSecret,
    clientName: name,
    redirectUris,
    scopes: SCOPES.slice(),
    issuer: issuer(),
    resource: partnerResource(),
  };
}

async function updateOwnedClient(ownerId, body) {
  await ensureTable();
  const row = await ownedRow(ownerId, body && body.client_id);
  if (!row) failOwner();
  const redirectUris = cleanRedirects(body && body.redirect_uris);
  const enabled = Boolean(body && body.enabled);
  const arrayLiteral = `{${redirectUris.map((uri) => `"${uri.replace(/"/g, '')}"`).join(',')}}`;
  await prisma.$executeRawUnsafe(
    `UPDATE "SsoDeveloperClient"
     SET "redirectUris" = $1::text[], enabled = $2
     WHERE "clientId" = $3 AND "ownerUserId" = $4`,
    arrayLiteral,
    enabled,
    row.clientId,
    ownerId,
  );
  return presentClient({ ...row, redirectUris, enabled });
}

async function rotateOwnedSecret(ownerId, clientId) {
  await ensureTable();
  const row = await ownedRow(ownerId, clientId);
  if (!row) failOwner();
  const clientSecret = `ddc_sso_secret_${crypto.randomBytes(32).toString('base64url')}`;
  await prisma.$executeRaw`
    UPDATE "SsoDeveloperClient"
    SET "secretHash" = ${sha256(clientSecret)}
    WHERE "clientId" = ${row.clientId} AND "ownerUserId" = ${ownerId}
  `;
  return { client_id: row.clientId, client_secret: clientSecret };
}

async function grantPlanetManager(email) {
  const base = String(process.env.PUBLIC_BASE_URL || '');
  if (!base.includes('api-rehearsal.datadance.ai')) {
    const error = new Error('Data Planet is assigned on the mainnet API.');
    error.status = 409;
    error.code = 'wrong_network';
    throw error;
  }
  const normalized = String(email || '').trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    const error = new Error('email is required.');
    error.status = 400;
    error.code = 'invalid_request';
    throw error;
  }
  const user = await prisma.user.findFirst({
    where: { email: { equals: normalized, mode: 'insensitive' } },
    select: { id: true, email: true, disabledAt: true },
  });
  if (!user) {
    const error = new Error('No mainnet account uses that email. Ask them to sign in on Mainnet first.');
    error.status = 404;
    error.code = 'not_found';
    throw error;
  }
  if (user.disabledAt) {
    const error = new Error('That account is disabled.');
    error.status = 403;
    error.code = 'account_disabled';
    throw error;
  }
  await ensureTable();
  const clientId = 'sso-rehearsal';
  const existing = await prisma.$queryRaw`
    SELECT "clientId" FROM "SsoDeveloperClient" WHERE "clientId" = ${clientId} LIMIT 1
  `;
  if (!existing.length) {
    const id = crypto.randomUUID();
    const secretHash = sha256(crypto.randomBytes(32));
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SsoDeveloperClient"
        ("id","clientId","clientName","contactEmail","secretHash","redirectUris","enabled","kind","ownerUserId")
       VALUES ($1,$2,'Data Planet',$3,$4,'{}'::text[],false,'partner',$5)`,
      id,
      clientId,
      user.email,
      secretHash,
      user.id,
    );
  } else {
    await prisma.$executeRaw`
      UPDATE "SsoDeveloperClient"
      SET "ownerUserId" = ${user.id}, kind = 'partner', "contactEmail" = ${user.email}
      WHERE "clientId" = ${clientId}
    `;
  }
  return { client_id: clientId, email: user.email, user_id: user.id, network: 'mainnet' };
}

function parseScope(value, allowed, OAuthError) {
  const requested = String(value || '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const scopes = requested.length ? requested : ['sso:identity'];
  const accepted = Array.isArray(allowed) && allowed.length ? allowed : SCOPES;
  if (scopes.some((item) => !accepted.includes(item))) {
    throw fail(OAuthError, 400, 'invalid_scope', 'This client cannot request that scope.');
  }
  return accepted.filter((item) => scopes.includes(item)).join(' ');
}

async function startDeveloperAuthorization(req, query, client, OAuthError) {
  if (query.response_type !== 'code') {
    throw fail(OAuthError, 400, 'unsupported_response_type', 'Only response_type=code is supported.');
  }
  if (query.code_challenge_method !== 'S256' || !query.code_challenge) {
    throw fail(OAuthError, 400, 'invalid_request', 'PKCE S256 is required.');
  }
  const state = String(query.state || '');
  if (state.length < 22 || state.length > 512) {
    throw fail(OAuthError, 400, 'invalid_request', 'state must be 22 to 512 characters.');
  }
  const redirectUri = String(query.redirect_uri || '');
  if (!client.redirectUris.includes(redirectUri)) {
    throw fail(OAuthError, 400, 'invalid_request', 'redirect_uri is not registered for this client.');
  }
  const expected = partnerResource();
  const resource = String(query.resource || expected);
  if (resource.replace(/\/$/, '') !== expected.replace(/\/$/, '')) {
    throw fail(OAuthError, 400, 'invalid_target', 'resource must match the partner API.');
  }
  const scope = parseScope(query.scope, client.scopes, OAuthError);
  const row = await prisma.oAuthAuthorization.create({
    data: {
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: String(query.code_challenge),
      codeChallengeMethod: 'S256',
      resource: expected,
      scope,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  const { appPublicUrl } = require('../constants/lifeContext');
  return `${appPublicUrl()}/oauth/consent?request=${row.id}`;
}

function presentedSecret(req, body) {
  const header = String(req.headers.authorization || '');
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header);
  if (match) {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
  }
  return {
    clientId: String(body.client_id || ''),
    clientSecret: String(body.client_secret || ''),
  };
}

function secretsEqual(presented, expectedHash) {
  if (!presented || presented.length > 1024) return false;
  const left = Buffer.from(sha256(presented), 'hex');
  const right = Buffer.from(String(expectedHash || ''), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

async function exchangeDeveloperCode(req, body, row, OAuthError) {
  const verifier = String(body.code_verifier || '');
  const code = String(body.code || '');
  if (!code || !verifier) throw fail(OAuthError, 400, 'invalid_request', 'code and code_verifier are required.');
  const client = await loadDeveloperClient(row.clientId);
  if (!client || !client.enabled) throw fail(OAuthError, 400, 'invalid_client', 'Unknown client_id.');
  const presented = presentedSecret(req, body);
  if (presented.clientId && presented.clientId !== row.clientId) {
    throw fail(OAuthError, 400, 'invalid_client', 'client_id does not match this code.');
  }
  if (!secretsEqual(presented.clientSecret, client.secretHash)) {
    throw fail(OAuthError, 400, 'invalid_client', 'client_secret is not valid for this client.');
  }
  if (body.redirect_uri && String(body.redirect_uri) !== row.redirectUri) {
    throw fail(OAuthError, 400, 'invalid_grant', 'redirect_uri does not match this code.');
  }
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  const left = Buffer.from(computed);
  const right = Buffer.from(String(row.codeChallenge));
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw fail(OAuthError, 400, 'invalid_grant', 'PKCE verification failed.');
  }
  await prisma.oAuthAuthorization.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });
  const token = `ddc_sso_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + TTL_SEC * 1000);
  await prisma.mcpToken.create({
    data: {
      userId: row.userId,
      tokenHash: sha256(token),
      tokenPrefix: token.slice(0, 12),
      label: client.clientName,
      source: 'partner',
      clientId: client.clientId,
      resource: row.resource,
      scope: row.scope,
      expiresAt,
    },
  });
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: TTL_SEC,
    scope: row.scope,
    resource: row.resource,
  };
}

function avatarUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/assets/avatars/default-avatar.png') return '';
  if (/^https?:\/\//i.test(raw) && !raw.toLowerCase().startsWith('javascript:')) return raw;
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('..')) return raw;
  return '';
}

async function readPartnerMe(token) {
  const trimmed = String(token || '').trim();
  if (!trimmed.startsWith('ddc_sso_')) return null;
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: sha256(trimmed) },
  });
  if (!row || row.source !== 'partner' || (row.expiresAt && row.expiresAt < new Date())) return null;
  const expected = partnerResource();
  if (String(row.resource || '').replace(/\/$/, '') !== expected.replace(/\/$/, '')) return null;
  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { id: true, email: true, avatar: true, walletAddress: true, createdAt: true },
  });
  if (!user) return null;
  const scopes = new Set(String(row.scope || '').split(/\s+/).filter(Boolean));
  const body = {
    sub: user.id,
    client_id: row.clientId,
    issued_at: row.createdAt,
    expires_at: row.expiresAt,
  };
  if (scopes.has('sso:identity')) {
    const picture = avatarUrl(user.avatar);
    if (picture) body.avatar = picture;
  }
  if (scopes.has('sso:status')) {
    body.account_status = 'active';
    body.registered_at = user.createdAt;
    body.wallet_bound = Boolean(user.walletAddress);
  }
  if (scopes.has('sso:email') && user.email) body.email = user.email;
  if (scopes.has('sso:wallet') && user.walletAddress) body.wallet_address = user.walletAddress;
  return body;
}

async function listSsoClients() {
  await ensureTable();
  const rows = await prisma.$queryRaw`
    SELECT c."clientId", c."clientName", c."contactEmail", c."redirectUris",
           c.enabled, c.kind, c."ownerUserId", c."createdAt",
           u.email AS "ownerEmail"
    FROM "SsoDeveloperClient" c
    LEFT JOIN "User" u ON u.id = c."ownerUserId"
    ORDER BY c."createdAt" DESC
  `;
  return {
    issuer: issuer(),
    clients: rows.map((row) => ({
      client_id: row.clientId,
      client_name: row.clientName,
      contact_email: row.contactEmail,
      redirect_uris: Array.isArray(row.redirectUris) ? row.redirectUris : [],
      enabled: Boolean(row.enabled),
      kind: row.kind === 'partner' ? 'partner' : 'developer',
      owner_email: row.ownerEmail || null,
      created_at: row.createdAt,
    })),
  };
}

module.exports = {
  SCOPES,
  ensureTable,
  loadDeveloperClient,
  createDeveloperClient,
  listOwnedClients,
  updateOwnedClient,
  rotateOwnedSecret,
  grantPlanetManager,
  startDeveloperAuthorization,
  exchangeDeveloperCode,
  readPartnerMe,
  partnerResource,
  issuer,
  listSsoClients,
};
