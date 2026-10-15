/**
 * Partner clients in one registry.
 * A public registration is a developer client: login scopes only.
 * A row with kind "partner" is a first-party partner (Data Planet): the same
 * confidential flow, plus points, referral, referral network, and referral bind
 * when this environment serves that write, and the App hand-off once its
 * initiateLoginUri is set (scripts/setPartnerInitiateLoginUri.js). The plaintext
 * secret is returned once and is not written to the database or to logs.
 */
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const {
  sha256Hex,
  initiateLoginUriProblem,
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

const logger = createLogger('ssoDeveloperClient');

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

/**
 * Served to a first-party row only while THIS environment lists them in SSO_TGE_STATUS_FIELDS —
 * the same switch that serves them to the env-configured partner — so deploying an endpoint never
 * turns it on by itself. `points_history` waits on the consent wording for `points` (see the
 * catalog entry in src/constants/partnerClient.js).
 */
const ENV_SWITCHED_PARTNER_FIELDS = Object.freeze(['points_history']);

function firstPartyStatusFields(cfg) {
  const listed = new Set(cfg.statusFields);
  return [...PARTNER_STATUS_FIELDS, ...ENV_SWITCHED_PARTNER_FIELDS.filter((field) => listed.has(field))];
}

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

/**
 * `ownerUserId` is the signed-in DataDance account that registers the client (the route runs
 * `protect`). Callers that pass none store null, as before.
 */
async function createDeveloperClient(body = {}, { ownerUserId = null } = {}) {
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
      ownerUserId: ownerUserId || null,
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

// Client id + stored value pairs already reported, so a bad value is logged once, not per request.
const reportedInitiateLoginUris = new Set();
const REPORTED_INITIATE_LOGIN_URI_LIMIT = 1000;

/**
 * The App hand-off target (`initiate_login_uri`) of one registry row, or '' for none — the shape
 * the environment's partner client has when SSO_TGE_INITIATE_LOGIN_URI is empty. ssoRoutes refuses
 * the hand-off (CLIENT_DISABLED) for a client without one. shapeDeveloperClient reads it only while
 * SSO_TGE_ENABLED is on, so the kill switch stops every App hand-off, a database row's included.
 *   - kind "developer": always '' whatever the column holds; the hand-off is first-party only.
 *   - kind "partner": the stored value when it passes initiateLoginUriProblem (the production rule
 *     for SSO_TGE_INITIATE_LOGIN_URI). A value that fails reads as '' and is logged once, by client
 *     id and column name; the value itself is not logged.
 */
function rowInitiateLoginUri(row) {
  if (row.kind !== 'partner') return '';
  const uri = typeof row.initiateLoginUri === 'string' ? row.initiateLoginUri.trim() : '';
  if (!uri) return '';
  if (!initiateLoginUriProblem(uri)) return uri;
  const key = `${row.clientId}\n${uri}`;
  if (!reportedInitiateLoginUris.has(key)) {
    if (reportedInitiateLoginUris.size >= REPORTED_INITIATE_LOGIN_URI_LIMIT) reportedInitiateLoginUris.clear();
    reportedInitiateLoginUris.add(key);
    logger.warn('sso.partner_initiate_login_uri_invalid', {
      clientId: row.clientId,
      field: 'SsoDeveloperClient.initiateLoginUri',
      treatedAs: 'absent',
    });
  }
  return '';
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
    // SSO_TGE_ENABLED=false stops the App hand-off for every partner client, as it does for the
    // environment's. The row's web sign-in still follows its own `enabled` flag.
    initiateLoginUri: cfg.enabled ? rowInitiateLoginUri(row) : '',
    tokenEndpointAuthMethod: 'client_secret_post',
    tokenEndpointAuthMethods: [...PARTNER_TOKEN_ENDPOINT_AUTH_METHODS],
    resource: partnerResourceUrl(req),
    scopes: firstParty ? [...availablePartnerScopes()] : [...DEVELOPER_SCOPES],
    defaultScope: PARTNER_DEFAULT_SCOPE,
    requestTtlMs: PARTNER_REQUEST_TTL_MS,
    codeTtlMs: PARTNER_CODE_TTL_MS,
    accessTtlSec: PARTNER_ACCESS_TTL_SEC,
    statusFields: firstParty ? firstPartyStatusFields(cfg) : [...DEVELOPER_STATUS_FIELDS],
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

// ---------------------------------------------------------------------------------------------
// The account console: a signed-in account reads and changes only the rows whose ownerUserId is
// its own id. A self-serve client belongs to the account that registered it; the first-party Data
// Planet row belongs to the account an operator assigned as its manager (POST /api/ops/sso/planet-manager).
// ---------------------------------------------------------------------------------------------

const CONSOLE_CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The client_id a console request names, or null when it is not a plausible id (never a filter object). */
function consoleClientId(value) {
  return typeof value === 'string' && CONSOLE_CLIENT_ID.test(value) ? value : null;
}

function requireOwner(ownerUserId) {
  // Prisma drops a filter whose value is undefined: without this, a missing owner would match every row.
  if (typeof ownerUserId !== 'string' || !ownerUserId) {
    throw new DeveloperClientError(401, 'login_required', 'Sign in with DataDance first.');
  }
  return ownerUserId;
}

function requireClientId(value) {
  const clientId = consoleClientId(value);
  if (!clientId) throw new DeveloperClientError(400, 'invalid_request', 'client_id is required.');
  return clientId;
}

/** One answer for "no such client" and "someone else's client", so an id reveals nothing. */
function notOnThisAccount() {
  return new DeveloperClientError(404, 'not_found', 'This client is not on this account.');
}

/**
 * The environment's partner (SSO_TGE_CLIENT_ID) wins over a registry row with the same id
 * (loadPartnerClient), so its redirect URIs and secret are not the row's to change: a secret
 * rotated on the row would never be accepted.
 */
function environmentClient(clientId) {
  return clientId ? getPartnerClient(clientId) : null;
}

/** What the console shows for one client: the settings in effect. Never the secret or its hash. */
function presentOwnedClient(row) {
  const configured = environmentClient(row.clientId);
  const kind = configured || row.kind === 'partner' ? 'partner' : 'developer';
  return {
    client_id: row.clientId,
    client_name: configured ? configured.clientName : row.clientName,
    kind,
    redirect_uris: configured
      ? [...configured.redirectUris]
      : (Array.isArray(row.redirectUris) ? [...row.redirectUris] : []),
    enabled: configured ? Boolean(configured.enabled) : Boolean(row.enabled),
    scopes: kind === 'partner' ? [...availablePartnerScopes()] : [...DEVELOPER_SCOPES],
    managed: Boolean(configured),
    created_at: row.createdAt || null,
  };
}

async function findOwnedClient(ownerUserId, clientId) {
  const row = await prisma.ssoDeveloperClient.findFirst({ where: { clientId, ownerUserId } });
  if (!row) throw notOnThisAccount();
  return row;
}

function refuseManaged(row) {
  if (environmentClient(row.clientId)) {
    throw new DeveloperClientError(409, 'managed_client', 'DataDance manages this client. Contact DataDance to change it.');
  }
}

async function listOwnedClients(ownerUserId) {
  const owner = requireOwner(ownerUserId);
  const rows = await prisma.ssoDeveloperClient.findMany({
    where: { ownerUserId: owner },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(presentOwnedClient);
}

/** Redirect URIs (the registration rules) and, when sent, enabled. Nothing else on the row changes. */
async function updateOwnedClient(ownerUserId, body = {}) {
  const owner = requireOwner(ownerUserId);
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const clientId = requireClientId(input.client_id);
  const redirectUris = cleanRedirects(input.redirect_uris);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new DeveloperClientError(400, 'invalid_request', 'enabled must be true or false.');
  }
  const row = await findOwnedClient(owner, clientId);
  refuseManaged(row);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : Boolean(row.enabled);
  // The owner is part of the write as well as the read.
  const { count } = await prisma.ssoDeveloperClient.updateMany({
    where: { clientId, ownerUserId: owner },
    data: { redirectUris, enabled },
  });
  if (count !== 1) throw notOnThisAccount();
  return presentOwnedClient({ ...row, redirectUris, enabled });
}

/**
 * A new secret for one owned client. The old one stops working at once. The plaintext is returned
 * to the caller once; only its sha256 is stored.
 */
async function rotateOwnedSecret(ownerUserId, clientIdValue) {
  const owner = requireOwner(ownerUserId);
  const clientId = requireClientId(clientIdValue);
  const row = await findOwnedClient(owner, clientId);
  refuseManaged(row);
  // Built before the write: once the old secret is dead, nothing may fail before the caller has the new one.
  const client = presentOwnedClient(row);
  // Same format as createDeveloperClient.
  const clientSecret = `ddc_sso_secret_${crypto.randomBytes(32).toString('base64url')}`;
  const secretHash = sha256Hex(clientSecret);
  const { count } = await prisma.ssoDeveloperClient.updateMany({
    where: { clientId, ownerUserId: owner },
    data: { secretHash },
  });
  if (count !== 1) throw notOnThisAccount();
  return { client, clientSecret };
}

module.exports = {
  DeveloperClientError,
  DEVELOPER_SCOPES,
  DEVELOPER_STATUS_FIELDS,
  PARTNER_STATUS_FIELDS,
  createDeveloperClient,
  loadDeveloperPartnerClient,
  loadPartnerClient,
  consoleClientId,
  listOwnedClients,
  updateOwnedClient,
  rotateOwnedSecret,
};
