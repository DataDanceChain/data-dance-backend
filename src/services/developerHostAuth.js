/** Database-authoritative developer host login. The stable opaque handle is a BFF credential,
 * never a Wallet/ops token. Only /start may hand out a new handle; callbacks return identity only.
 * A short row lock serializes start/code/exchange/logout. No external work occurs under locks.
 */
const crypto = require('node:crypto');
const prisma = require('../utils/prisma');
const { readDeveloperHostConfig, hostScopes } = require('../constants/developerHost');
const { activeRoles } = require('./userRoles');
const { capabilitiesFor, lockConsentPolicy } = require('./developerConsentPolicy');
const { assertStaffWalletSession, issuedBeforeReset } = require('./staffSession');
const { getPartnerClient } = require('../constants/partnerClient');
const { OpsError, writeAudit, actorFromUser } = require('./opsAudit');
const { withoutUserSecrets } = require('../utils/userSecretFields');
const HANDLE = /^dhs_[A-Za-z0-9_-]{43}$/;
const REQUEST = /^dhr_[A-Za-z0-9_-]{43}$/;
const CODE = /^dhc_[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const HANDLE_MS = 8 * 60 * 60 * 1000, AUTH_MS = 60 * 60 * 1000;
const REQUEST_MS = 10 * 60 * 1000, CODE_MS = 60 * 1000;
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const random = prefix => prefix + crypto.randomBytes(32).toString('base64url');
function equal(left, right) { const a = Buffer.from(String(left)), b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function failure(status = 401, code = 'session_invalid') { return new OpsError(status, code, code === 'invalid_grant' ? 'This sign-in request has ended. Start again.' : 'This developer session has ended.'); }
function config(environment) {
  let cfg;
  try { cfg = readDeveloperHostConfig(); } catch { throw new OpsError(503, 'not_configured', 'Developer host authentication is not configured.'); }
  if (environment !== undefined && environment !== cfg.environment) throw new OpsError(400, 'environment_mismatch', 'Choose the matching Wallet network.');
  return cfg;
}
function sameAuthority(row, cfg) { return row.environment === cfg.environment && row.issuer === cfg.issuer && row.callbackUri === cfg.callbackUri; }
async function lockedSession(token, tx, cfg) {
  if (!HANDLE.test(token || '')) throw failure();
  const rows = await tx.$queryRaw`SELECT "id" FROM "DeveloperHostSession" WHERE "tokenHash" = ${digest(token)} FOR UPDATE`;
  const row = rows[0] && await tx.developerHostSession.findUnique({ where: { id: rows[0].id } });
  if (!row || !sameAuthority(row, cfg) || row.expiresAt.getTime() <= Date.now()) throw failure();
  return row;
}
async function shortLock(tx) { await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; }
function grantedScopes(requested, roles) {
  return requested.filter(scope => scope === 'developer' || (scope === 'docs.internal' && roles.some(r => ['ddc_admin','operator'].includes(r))) || (scope === 'docs.review_projects' && roles.includes('ddc_admin')));
}
async function contextFor(row, tx, cfg) {
  if (!row.userId || row.revokedAt || !row.authenticationExpiresAt || row.authenticationExpiresAt.getTime() <= Date.now()) throw failure();
  const user = await tx.user.findUnique({ where: { id: row.userId } });
  const claims = row.authClaims;
  if (!user || user.disabledAt || !claims || claims.developerNetwork !== cfg.environment || claims.developerIssuer !== cfg.issuer || issuedBeforeReset(claims, user.sessionsResetAt)) throw failure();
  const roles = await activeRoles(user.id, tx);
  const scopes = grantedScopes(row.grantedScopes || [], roles);
  return { user: withoutUserSecrets(user), authClaims: claims, roles, scopes, sessionId: row.id, generation: row.generation };
}
async function identityFor(row, tx, cfg, context) {
  const current = context || await contextFor(row, tx, cfg);
  const rows = await tx.ssoDeveloperClient.findMany({ where: { ownerUserId: current.user.id }, select: { clientId: true, kind: true, enabled: true }, orderBy: { clientId: 'asc' } });
  return { environment: cfg.environment, user: { id: current.user.id, email: current.user.email || null, name: current.user.name || null }, roles: current.roles,
    capabilities: [...capabilitiesFor(current.roles), ...current.scopes.filter(s => s !== 'developer')],
    projects: rows.map(client => ({ id: client.clientId, kind: client.kind, enabled: Boolean(getPartnerClient(client.clientId)?.enabled ?? client.enabled) })),
    session_scopes: current.scopes, expires_in: Math.max(0, Math.floor((row.authenticationExpiresAt.getTime() - Date.now()) / 1000)) };
}
async function start({ token, body = {} }, db = prisma) {
  const cfg = config(body.environment);
  if (!CHALLENGE.test(body.code_challenge || '')) throw new OpsError(400, 'invalid_request', 'A S256 code challenge is required.');
  let scopes;
  try { scopes = hostScopes(body.scopes); } catch { throw new OpsError(400, 'invalid_scope', 'Unsupported developer host scope.'); }
  const bootstrap = token === undefined || token === null;
  if (bootstrap && !CHALLENGE.test(body.browser_key || '')) throw new OpsError(400, 'invalid_request', 'A browser bootstrap key is required.');
  if (bootstrap && !process.env.JWT_SECRET) throw new OpsError(503, 'not_configured', 'Developer host authentication is not configured.');
  const newToken = bootstrap ? 'dhs_' + crypto.createHmac('sha256', process.env.JWT_SECRET).update(JSON.stringify(['developer-host-bootstrap', cfg.issuer, cfg.environment, body.browser_key])).digest('base64url') : null;
  const requestId = random('dhr_'), state = crypto.randomBytes(32).toString('base64url');
  return db.$transaction(async tx => {
    await shortLock(tx);
    let row;
    if (newToken) {
      // Concurrent first POSTs from the same BFF CSRF seed get the same credential. A late
      // bootstrap response therefore cannot overwrite the browser with an unrelated handle.
      const key = 'ddc:developer-bootstrap:' + digest(body.browser_key);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const existing = await tx.developerHostSession.findUnique({ where: { tokenHash: digest(newToken) } });
      row = existing ? await lockedSession(newToken, tx, cfg) : await tx.developerHostSession.create({ data: { tokenHash: digest(newToken), environment: cfg.environment, issuer: cfg.issuer, callbackUri: cfg.callbackUri, expiresAt: new Date(Date.now() + HANDLE_MS) } });
    } else row = await lockedSession(token, tx, cfg);
    await tx.developerHostRequest.updateMany({ where: { sessionId: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    row = await tx.developerHostSession.update({ where: { id: row.id }, data: { generation: { increment: 1 }, activeRequestId: requestId, userId: null, authenticationExpiresAt: null, grantedScopes: [], revokedAt: new Date() } });
    await tx.developerHostRequest.create({ data: { id: requestId, sessionId: row.id, generation: row.generation, challenge: body.code_challenge, state, requestedScopes: scopes, expiresAt: new Date(Date.now() + REQUEST_MS) } });
    return { ...(newToken ? { token: newToken } : {}), request_id: requestId, state, expires_in: REQUEST_MS / 1000, environment: cfg.environment,
      wallet_url: `${cfg.walletOrigin}/developers/#developer-signin&request_id=${requestId}&environment=${cfg.environment}` };
  });
}
async function code({ user, authClaims, body = {} }, db = prisma) {
  const cfg = config(body.environment);
  assertStaffWalletSession(null, authClaims, { recent: true });
  if (authClaims.developerNetwork !== cfg.environment || authClaims.developerIssuer !== cfg.issuer) throw new OpsError(403, 'network_session_required', 'Sign in again with the matching Wallet network.');
  if (!REQUEST.test(body.request_id || '')) throw failure(400, 'invalid_grant');
  const codeValue = random('dhc_');
  return db.$transaction(async tx => {
    await lockConsentPolicy(tx);
    let request = await tx.developerHostRequest.findUnique({ where: { id: body.request_id } });
    if (!request) throw failure(400, 'invalid_grant');
    await tx.$queryRaw`SELECT "id" FROM "DeveloperHostSession" WHERE "id" = ${request.sessionId} FOR UPDATE`;
    const row = await tx.developerHostSession.findUnique({ where: { id: request.sessionId } });
    request = await tx.developerHostRequest.findUnique({ where: { id: request.id } });
    if (!request || !row || !sameAuthority(row, cfg) || row.expiresAt.getTime() <= Date.now() || row.activeRequestId !== request.id || row.generation !== request.generation || request.consumedAt || request.expiresAt.getTime() <= Date.now() || request.codeHash) throw failure(400, 'invalid_grant');
    const current = await tx.user.findUnique({ where: { id: user.id } });
    if (!current || current.disabledAt) throw failure();
    assertStaffWalletSession(current, authClaims, { recent: true });
    const roles = await activeRoles(current.id, tx);
    const scopes = grantedScopes(request.requestedScopes, roles);
    const claims = { ver: 2, iat: authClaims.iat, ...(authClaims.iatMs !== undefined ? { iatMs: authClaims.iatMs } : {}), developerNetwork: cfg.environment, developerIssuer: cfg.issuer };
    await tx.developerHostRequest.update({ where: { id: request.id }, data: { codeHash: digest(codeValue), codeExpiresAt: new Date(Date.now() + CODE_MS), userId: current.id, authClaims: claims } });
    return { redirect_uri: cfg.callbackUri, code: codeValue, state: request.state, request_id: request.id, environment: cfg.environment, expires_in: CODE_MS / 1000 };
  });
}
async function exchange({ token, body = {}, requestId = null }, db = prisma) {
  const cfg = config();
  const result = await db.$transaction(async tx => {
    await lockConsentPolicy(tx);
    const row = await lockedSession(token, tx, cfg);
    const request = REQUEST.test(body.request_id || '') && await tx.developerHostRequest.findUnique({ where: { id: body.request_id } });
    // A stale response may not consume the fresh request or re-authenticate this handle.
    if (!request || request.sessionId !== row.id || row.activeRequestId !== request.id || request.generation !== row.generation || request.consumedAt) return { failed: true };
    await tx.developerHostRequest.update({ where: { id: request.id }, data: { consumedAt: new Date() } });
    await tx.developerHostSession.update({ where: { id: row.id }, data: { activeRequestId: null } });
    const valid = body.environment === cfg.environment && request.expiresAt.getTime() > Date.now() && request.codeExpiresAt && request.codeExpiresAt.getTime() > Date.now() && CODE.test(body.code || '') && equal(digest(body.code), request.codeHash) && VERIFIER.test(body.code_verifier || '') && equal(crypto.createHash('sha256').update(body.code_verifier).digest('base64url'), request.challenge) && typeof body.state === 'string' && equal(body.state, request.state);
    if (!valid) return { failed: true };
    const user = request.userId && await tx.user.findUnique({ where: { id: request.userId } });
    if (!user || user.disabledAt || !request.authClaims || issuedBeforeReset(request.authClaims, user.sessionsResetAt) || request.authClaims.developerNetwork !== cfg.environment || request.authClaims.developerIssuer !== cfg.issuer) return { failed: true };
    const roles = await activeRoles(user.id, tx);
    const scopes = grantedScopes(request.requestedScopes, roles);
    const authenticated = await tx.developerHostSession.update({ where: { id: row.id }, data: { userId: user.id, authClaims: request.authClaims, grantedScopes: scopes, revokedAt: null, authenticationExpiresAt: new Date(Math.min(Date.now() + AUTH_MS, row.expiresAt.getTime())) } });
    await writeAudit(tx, { actor: actorFromUser(user, 'developer'), action: 'auth.developer_sign_in', target: { type: 'user', id: user.id, label: user.email }, surface: 'console', requestId, detail: { environment: cfg.environment, scopes } });
    return identityFor(authenticated, tx, cfg);
  });
  if (result.failed) throw failure(400, 'invalid_grant');
  return result;
}
async function current(token, db = prisma) {
  const cfg = config();
  return db.$transaction(async tx => {
    await shortLock(tx);
    const row = await lockedSession(token, tx, cfg);
    const context = await contextFor(row, tx, cfg);
    return { ...context, identity: await identityFor(row, tx, cfg, context) };
  });
}
/** Recheck under the business transaction's policy lock before any host-owned mutation. */
async function assertCurrent(token, expected, tx) {
  const cfg = config(), row = await lockedSession(token, tx, cfg), context = await contextFor(row, tx, cfg);
  if (!expected || context.user.id !== expected.user.id || row.generation !== expected.generation) throw failure();
  return context;
}
async function logout(token, db = prisma) {
  const cfg = config();
  await db.$transaction(async tx => {
    await shortLock(tx);
    const row = await lockedSession(token, tx, cfg);
    await tx.developerHostRequest.updateMany({ where: { sessionId: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    await tx.developerHostSession.update({ where: { id: row.id }, data: { generation: { increment: 1 }, activeRequestId: null, userId: null, authenticationExpiresAt: null, revokedAt: new Date(), grantedScopes: [] } });
  });
}
module.exports = { start, code, exchange, current, assertCurrent, logout, HANDLE, _internals: { digest, grantedScopes, REQUEST, CODE } };
