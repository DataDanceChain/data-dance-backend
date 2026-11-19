/** Portal-owned configuration only. Legacy Wallet client/consent paths remain unchanged. */
const crypto = require('node:crypto');
const prisma = require('../utils/prisma');
const hostAuth = require('./developerHostAuth');
const { capabilitiesFor, lockConsentPolicy } = require('./developerConsentPolicy');
const { OpsError, writeAudit, actorFromUser } = require('./opsAudit');
const { cleanReason } = require('../constants/opsRoles');
const { getPartnerClient, initiateLoginUriProblem, sha256Hex } = require('../constants/partnerClient');
const { registrationDecision } = require('../constants/developerRegistration');
const { DeveloperClientError, consoleClientId, cleanName, cleanEmail, cleanRedirects,
  presentOwnedClient, DEVELOPER_SCOPES } = require('./ssoDeveloperClient');

function failure(status, code, message) { throw new DeveloperClientError(status, code, message); }
function reason(value) {
  const result = cleanReason(value);
  if (!result) failure(400, 'invalid_request', 'A reason of 3 to 200 characters is required.');
  return result;
}
function canRegister(context) {
  return context.roles.some(role => ['ddc_admin', 'developer', 'trusted_developer'].includes(role)) ||
    registrationDecision(context.user, context.authClaims).allowed;
}
function consent(row, context) {
  const eligible = capabilitiesFor(context.roles).includes('sso.skip_confirmation');
  const enabled = Boolean(row.skipConfirmationEnabled && row.skipConfirmationOwnerUserId === context.user.id);
  const uri = getPartnerClient(row.clientId)?.initiateLoginUri || row.initiateLoginUri;
  // This slice does not change OAuth/SSO policy. A saved choice cannot enable skipping.
  return { eligible, enabled, effective: false, reason: 'platform_disabled', platform_enabled: false,
    initiate_login_uri: typeof uri === 'string' && uri && !initiateLoginUriProblem(uri) ? uri : null };
}
function present(row, context) { return { ...presentOwnedClient(row), consent: consent(row, context) }; }
function actor(context) { return actorFromUser(context.user, 'developer'); }
async function audit(tx, context, action, row, why, detail, requestId) {
  return writeAudit(tx, { actor: actor(context), action, target: { type: 'sso_client', id: row.clientId, label: row.clientName },
    reason: why, detail, surface: 'console', requestId });
}
async function currentIn(tx, host) {
  await lockConsentPolicy(tx);
  return hostAuth.assertCurrent(host.token, host.context, tx);
}
async function owned(tx, clientId, context) {
  if (!consoleClientId(clientId)) failure(400, 'invalid_request', 'client_id is required.');
  await tx.$queryRaw`SELECT "clientId" FROM "SsoDeveloperClient" WHERE "clientId" = ${clientId} FOR UPDATE`;
  const row = await tx.ssoDeveloperClient.findFirst({ where: { clientId, ownerUserId: context.user.id } });
  if (!row) failure(404, 'not_found', 'This client is not on this account.');
  return row;
}
function unmanaged(row) {
  if (getPartnerClient(row.clientId)) failure(409, 'managed_client', 'DataDance manages this client. Contact DataDance to change it.');
}
async function me(host, db = prisma) {
  const context = await hostAuth.current(host.token, db);
  return { user_id: context.user.id, email: context.user.email || null, roles: context.roles,
    capabilities: capabilitiesFor(context.roles), admin: context.roles.includes('ddc_admin'),
    can_register: canRegister(context), verified_session: true };
}
async function list(host, db = prisma) {
  return db.$transaction(async tx => {
    const context = await currentIn(tx, host);
    const rows = await tx.ssoDeveloperClient.findMany({ where: { ownerUserId: context.user.id }, orderBy: { createdAt: 'asc' } });
    return { email: context.user.email || null, clients: rows.map(row => present(row, context)) };
  });
}
async function create(host, body, requestId, db = prisma) {
  const why = reason(body.reason), clientName = cleanName(body.client_name), contactEmail = cleanEmail(body.contact_email);
  const redirectUris = cleanRedirects(body.redirect_uris);
  return db.$transaction(async tx => {
    const context = await currentIn(tx, host);
    if (!canRegister(context)) failure(403, 'registration_closed', 'Self-serve client registration is closed.');
    const clientId = 'sso_' + crypto.randomBytes(18).toString('base64url');
    if (getPartnerClient(clientId)) throw new OpsError(503, 'temporarily_unavailable', 'Client registration is unavailable.');
    const clientSecret = 'ddc_sso_secret_' + crypto.randomBytes(32).toString('base64url');
    const row = await tx.ssoDeveloperClient.create({ data: { clientId, clientName, contactEmail, redirectUris,
      ownerUserId: context.user.id, secretHash: sha256Hex(clientSecret), kind: 'developer', enabled: true } });
    await audit(tx, context, 'console.client_register', row, why, { kind: 'developer', redirectUris: redirectUris.length }, requestId);
    return { client_id: row.clientId, client_secret: clientSecret, client_name: row.clientName, redirect_uris: row.redirectUris, scopes: [...DEVELOPER_SCOPES] };
  });
}
async function mutate(host, body, action, requestId, db = prisma) {
  const why = reason(body.reason);
  if (!['update', 'secret', 'consent'].includes(action)) failure(400, 'invalid_request', 'Unknown operation.');
  const redirects = action === 'update' ? cleanRedirects(body.redirect_uris) : null;
  if (action === 'update' && body.enabled !== undefined && typeof body.enabled !== 'boolean') failure(400, 'invalid_request', 'enabled must be true or false.');
  if (action === 'consent' && typeof body.skip_confirmation_enabled !== 'boolean') failure(400, 'invalid_request', 'skip_confirmation_enabled must be a boolean.');
  return db.$transaction(async tx => {
    let context = await currentIn(tx, host);
    const row = await owned(tx, body.client_id, context);
    // The client lock may have waited. Re-read current principal/roles before deciding the write.
    context = await hostAuth.assertCurrent(host.token, host.context, tx);
    const data = {}; let secret;
    if (action !== 'consent') unmanaged(row);
    if (action === 'update') {
      data.redirectUris = redirects; data.enabled = body.enabled === undefined ? row.enabled : body.enabled;
      if (!data.enabled) { data.skipConfirmationEnabled = false; data.skipConfirmationOwnerUserId = null; }
    } else if (action === 'secret') {
      secret = 'ddc_sso_secret_' + crypto.randomBytes(32).toString('base64url'); data.secretHash = sha256Hex(secret);
    } else {
      if (body.initiate_login_uri !== undefined) {
        unmanaged(row);
        if (body.initiate_login_uri !== null && (typeof body.initiate_login_uri !== 'string' || initiateLoginUriProblem(body.initiate_login_uri))) failure(400, 'invalid_request', 'initiate_login_uri must be an approved https URL or null.');
      }
      if ((body.skip_confirmation_enabled || body.initiate_login_uri != null) && !capabilitiesFor(context.roles).includes('sso.skip_confirmation')) failure(403, 'qualification_required', 'The application owner needs the sso.skip_confirmation capability.');
      data.skipConfirmationEnabled = body.skip_confirmation_enabled;
      data.skipConfirmationOwnerUserId = body.skip_confirmation_enabled ? context.user.id : null;
      if (body.initiate_login_uri !== undefined) data.initiateLoginUri = body.initiate_login_uri === null ? null : body.initiate_login_uri.trim();
    }
    const changed = await tx.ssoDeveloperClient.updateMany({ where: { clientId: row.clientId, ownerUserId: context.user.id }, data });
    if (changed.count !== 1) failure(404, 'not_found', 'This client is not on this account.');
    const result = present({ ...row, ...data }, context);
    await audit(tx, context, { update: 'console.client_update', secret: 'console.secret_rotate', consent: 'console.consent_settings' }[action], row, why,
      action === 'secret' ? { rotated: true } : action === 'consent' ? { enabled: data.skipConfirmationEnabled } : { enabled: data.enabled, redirectUris: redirects.length }, requestId);
    return secret ? { client_id: result.client_id, client_name: result.client_name, redirect_uris: result.redirect_uris, scopes: result.scopes, client_secret: secret } : result;
  });
}
module.exports = { me, list, create, mutate };
