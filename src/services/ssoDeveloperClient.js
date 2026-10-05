/**
 * Partner clients in one registry.
 * A public registration is a developer client: login scopes only.
 * A row with kind "partner" is a first-party partner (Data Planet): the same
 * confidential flow, plus points, referral, referral network, and referral bind
 * when this environment serves that write. The plaintext secret is returned once
 * and is not written to the database or to logs.
 */
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const {
  sha256Hex,
  PARTNER_KIND,
  PARTNER_DEFAULT_SCOPE,
  PARTNER_REQUEST_TTL_MS,
  PARTNER_CODE_TTL_MS,
  PARTNER_ACCESS_TTL_SEC,
  PARTNER_TOKEN_ENDPOINT_AUTH_METHODS,
  partnerResourceUrl,
  getPartnerClient,
  readPartnerConfig,
  availablePartnerScopes,
} = require('../constants/partnerClient');

const DEVELOPER_SCOPES = Object.freeze([
  'sso:identity',
  'sso:status',
  'sso:email',
  'sso:wallet',
]);

const DEVELOPER_STATUS_FIELDS = Object.freeze([
  'registered_at',
  'wallet_bound',
  'email',
  'wallet_address',
  'email_masked',
  'avatar',
]);

/** Fields the first-party Data Planet partner reads. Self-serve clients do not get these. */
const PARTNER_STATUS_FIELDS = Object.freeze([
  ...DEVELOPER_STATUS_FIELDS,
  'data_licence_granted',
  'points',
  'referral',
  'referral_network',
]);

class DeveloperClientError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DeveloperClientError';
    this.status = status;
    this.code = code;
  }
}

function cleanName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f]/g, '').trim();
  if (name.length < 1 || name.length > 80) {
    throw new DeveloperClientError(400, 'invalid_request', 'client_name must be 1 to 80 characters.');
  }
  return name;
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DeveloperClientError(400, 'invalid_request', 'contact_email must be an email address.');
  }
  return email;
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

function cleanRedirects(value) {
  const list = Array.isArray(value) ? value : [];
  const uris = [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))];
  if (!uris.length || uris.length > 5) {
    throw new DeveloperClientError(400, 'invalid_redirect_uri', 'Provide 1 to 5 redirect URIs.');
  }
  if (uris.some((uri) => uri.length > 512 || !isAllowedRedirect(uri))) {
    throw new DeveloperClientError(400, 'invalid_redirect_uri', 'Each redirect URI must be https, or http on localhost, with no fragment.');
  }
  return uris;
}

function newClientId() {
  return `sso_${crypto.randomBytes(18).toString('base64url')}`;
}

async function createDeveloperClient(body = {}) {
  const clientName = cleanName(body.client_name);
  const contactEmail = cleanEmail(body.contact_email);
  const redirectUris = cleanRedirects(body.redirect_uris);
  const clientSecret = `ddc_sso_secret_${crypto.randomBytes(32).toString('base64url')}`;
  const secretHash = sha256Hex(clientSecret);
  let clientId = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = newClientId();
    if (getPartnerClient(candidate)) continue;
    const existing = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: candidate } });
    if (!existing) {
      clientId = candidate;
      break;
    }
  }
  if (!clientId) {
    throw new DeveloperClientError(500, 'server_error', 'Could not allocate a client id.');
  }
  const row = await prisma.ssoDeveloperClient.create({
    data: {
      clientId,
      clientName,
      contactEmail,
      secretHash,
      redirectUris,
      enabled: true,
      kind: 'developer',
    },
  });
  return {
    clientId: row.clientId,
    clientSecret,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    scopes: [...DEVELOPER_SCOPES],
  };
}

function shapeDeveloperClient(row, req) {
  if (!row) return null;
  const firstParty = row.kind === 'partner';
  const cfg = readPartnerConfig();
  return {
    kind: PARTNER_KIND,
    clientId: row.clientId,
    clientName: row.clientName,
    enabled: Boolean(row.enabled),
    redirectUris: Array.isArray(row.redirectUris) ? row.redirectUris : [],
    tokenEndpointAuthMethod: 'client_secret_post',
    tokenEndpointAuthMethods: [...PARTNER_TOKEN_ENDPOINT_AUTH_METHODS],
    resource: partnerResourceUrl(req),
    scopes: firstParty ? [...availablePartnerScopes()] : [...DEVELOPER_SCOPES],
    defaultScope: PARTNER_DEFAULT_SCOPE,
    requestTtlMs: PARTNER_REQUEST_TTL_MS,
    codeTtlMs: PARTNER_CODE_TTL_MS,
    accessTtlSec: PARTNER_ACCESS_TTL_SEC,
    statusFields: firstParty ? [...PARTNER_STATUS_FIELDS] : [...DEVELOPER_STATUS_FIELDS],
    requireVerifiedSession: firstParty ? cfg.requireVerifiedSession : false,
    autoApprove: firstParty ? { ...cfg.autoApprove } : { app: false, web: false },
    secretHash: row.secretHash,
    developer: !firstParty,
    firstParty,
  };
}

async function loadDeveloperPartnerClient(clientId, req) {
  const id = String(clientId || '').trim();
  if (!id) return null;
  const row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: id } });
  return shapeDeveloperClient(row, req);
}

/** Env-configured partner first, then a registry row (developer or first-party). */
async function loadPartnerClient(clientId, req) {
  const configured = getPartnerClient(clientId, req);
  if (configured) return configured;
  return loadDeveloperPartnerClient(clientId, req);
}

module.exports = {
  DeveloperClientError,
  DEVELOPER_SCOPES,
  DEVELOPER_STATUS_FIELDS,
  PARTNER_STATUS_FIELDS,
  createDeveloperClient,
  loadDeveloperPartnerClient,
  loadPartnerClient,
};
