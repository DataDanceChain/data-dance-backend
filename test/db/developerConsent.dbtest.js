/** Synthetic HTTP + policy concurrency proof, on a newly created loopback-only disposable DB. */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const url = new URL(process.env.TEST_DATABASE_URL || 'http://invalid');
if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test')) throw new Error('Requires a loopback disposable *_test database');
const RUN = `dc${crypto.randomBytes(5).toString('hex')}`;
const CLIENT = `${RUN}-app`;
const MANAGED = `${RUN}-managed`;
const CALLBACK = 'https://client.example.test/callback';
const INITIATE = 'https://client.example.test/login/ddc';
Object.assign(process.env, { DATABASE_URL: url.toString(), LOG_LEVEL: 'error', WEB3AUTH_VERIFY_MODE: 'off',
  APNS_KEY_ID: 'TESTKEY001', APNS_TEAM_ID: 'TESTTEAM01', SSO_ENVIRONMENT: 'test', SSO_TGE_ENABLED: 'true',
  PUBLIC_BASE_URL: 'https://api.example.test', APP_PUBLIC_URL: 'https://app.example.test',
  JWT_SECRET: 'developer-consent-synthetic-jwt', SSO_SESSION_SECRET: 'developer-consent-synthetic-handoff',
  SSO_TGE_CLIENT_ID: MANAGED, SSO_TGE_CLIENT_NAME: 'Synthetic managed', SSO_TGE_REDIRECT_URIS: CALLBACK,
  SSO_TGE_INITIATE_LOGIN_URI: INITIATE, SSO_TGE_CLIENT_SECRET_SHA256: 'a'.repeat(64), SSO_TGE_AUTO_APPROVE: 'app',
  SSO_DEVELOPER_REGISTRATION: 'off' });
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../../src/utils/prisma');
const clientFile = require.resolve('@prisma/client');
require.cache[clientFile].exports = { ...require.cache[clientFile].exports, PrismaClient: function () { return prisma; } };
const { listenLoopback } = require('../helpers/loopbackServer');
const { grantRole, revokeRole } = require('../../src/services/userRoles');
const { disableAccount, enableAccount } = require('../../src/services/opsAccounts');
const { updateOwnedConsent, loadPartnerClient, DEVELOPER_SCOPES } = require('../../src/services/ssoDeveloperClient');
const { lockConsentPolicy } = require('../../src/services/developerConsentPolicy');
const { actorFromUser } = require('../../src/services/opsAudit');
const { decideConsent } = require('../../src/services/oauthService');
const { grantPlanetManager } = require('../../src/services/ssoDeveloperLive');
const { PLANET_MANAGER_CLIENT_ID } = require('../../src/services/ssoDeveloperLive');
let server, owner, other, subject, admin;
const actor = () => actorFromUser(admin, 'ddc_admin');
const verifiedClaims = () => { const iatMs = Date.now(); return { ver: 2, iatMs, iat: Math.floor(iatMs / 1000) }; };
function token(user, extra = {}) {
  const iatMs = Date.now();
  return jwt.sign({ id: user.id, ver: 2, iatMs, iat: Math.floor(iatMs / 1000), ...extra }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
const bearer = (user = owner) => `Bearer ${token(user)}`;
const save = (body = {}, user = owner) => request(server).post('/api/developer/sso/clients/consent').set('Authorization', bearer(user)).send({ client_id: CLIENT, skip_confirmation_enabled: true, reason: 'Synthetic owner choice', ...body });
async function owned(user = owner, clientId = CLIENT) {
  return (await request(server).get('/api/developer/sso/clients').set('Authorization', bearer(user))).body.clients.find((c) => c.client_id === clientId);
}
async function trust(user = owner) {
  return grantRole({ userId: user.id, role: 'trusted_developer', reason: 'Synthetic qualification', actor: actor() });
}
before(async () => {
  for (const name of ['owner', 'other', 'subject', 'admin']) {
    await prisma.user.create({ data: { id: `${RUN}-${name}`, email: `${RUN}-${name}@example.test`, referralCode: `${RUN}-${name}` } });
  }
  [owner, other, subject, admin] = await Promise.all(['owner', 'other', 'subject', 'admin'].map((n) => prisma.user.findUnique({ where: { id: `${RUN}-${n}` } })));
  const app = require('express')();
  app.use(require('express').json());
  app.use('/api/developer/sso', require('../../src/routes/developerSsoRoutes'));
  app.use('/api/sso', require('../../src/routes/ssoRoutes'));
  app.use(require('../../src/routes/oauthRoutes'));
  app.get('/api/ops/auth/me', require('../../src/middlewares/opsAuthMiddleware').protectOps, require('../../src/controllers/opsAccessController').me);
  server = await listenLoopback(app);
});
beforeEach(async () => {
  process.env.SSO_TGE_AUTO_APPROVE = 'app';
  await prisma.ssoDeveloperClient.deleteMany({ where: { clientId: { startsWith: RUN } } });
  await prisma.userRoleGrant.deleteMany({ where: { userId: { startsWith: RUN } } });
  await prisma.user.updateMany({ where: { id: { startsWith: RUN } }, data: { disabledAt: null, sessionsResetAt: null } });
  await prisma.ssoDeveloperClient.create({ data: { clientId: CLIENT, clientName: 'Synthetic ordinary app', contactEmail: owner.email,
    ownerUserId: owner.id, kind: 'developer', enabled: true, secretHash: 'b'.repeat(64), redirectUris: [CALLBACK] } });
});
after(async () => {
  try {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.oAuthAuthorization.deleteMany({ where: { clientId: { startsWith: RUN } } });
  await prisma.ssoTicket.deleteMany({ where: { userId: { startsWith: RUN } } });
  await prisma.ssoDeveloperClient.deleteMany({ where: { clientId: { startsWith: RUN } } });
  await prisma.opsAuditLog.deleteMany({ where: { OR: [{ actorUserId: { startsWith: RUN } }, { targetId: { startsWith: RUN } }] } });
  await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
  } finally { await prisma.$disconnect(); }
});
async function authorize(prompt) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const res = await request(server).get('/oauth/authorize').query({ client_id: CLIENT, redirect_uri: CALLBACK,
    response_type: 'code', state: `${RUN}-state-with-enough-entropy`, code_challenge_method: 'S256',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), ...(prompt ? { prompt } : {}) });
  assert.equal(res.status, 302, res.text);
  const id = new URL(res.headers.location).searchParams.get('request');
  return { id, cookie: res.headers['set-cookie'][0].split(';')[0] };
}
async function handoff() {
  const mint = await request(server).post('/api/sso/app-ticket').set('Authorization', bearer(subject)).send({ client_id: CLIENT });
  assert.equal(mint.status, 200, mint.text);
  const exchange = await request(server).post('/api/sso/ticket/exchange').send({ ticket: mint.body.data.ticket });
  assert.equal(exchange.status, 200, exchange.text);
  return exchange.body.data.session_token;
}
function decision(flow, credential, auto) {
  return request(server).post('/api/oauth/consent').set('Cookie', flow.cookie).set('Authorization', `Bearer ${credential}`).send({ requestId: flow.id, allow: true, auto });
}

test('additive migration keeps a pre-existing client off, accepts trusted role and retains the closed constraint', async () => {
  const schema = `${RUN}_migration`;
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."SsoDeveloperClient" ("id" TEXT PRIMARY KEY)`);
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."SsoDeveloperClient" VALUES ('legacy')`);
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."UserRoleGrant" (role TEXT CONSTRAINT "UserRoleGrant_role_check" CHECK(role IN ('ddc_admin','operator','developer')))`);
    const sql = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261020060000_developer_consent_controls/migration.sql'), 'utf8');
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      for (const part of sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter((s) => s && !['BEGIN', 'COMMIT'].includes(s))) await tx.$executeRawUnsafe(part);
    });
    assert.deepEqual(await prisma.$queryRawUnsafe(`SELECT "skipConfirmationEnabled","skipConfirmationOwnerUserId" FROM "${schema}"."SsoDeveloperClient"`), [{ skipConfirmationEnabled: false, skipConfirmationOwnerUserId: null }]);
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."UserRoleGrant" VALUES ('trusted_developer')`);
    await assert.rejects(prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."UserRoleGrant" VALUES ('all_privileges')`));
  } finally { await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
});

test('ordinary tampering/unowned writes fail; trusted is default-off, no ops role, and may register without self-upgrading', async () => {
  assert.equal((await save({ initiate_login_uri: INITIATE })).status, 403);
  assert.equal((await save({}, other)).status, 404);
  assert.equal((await prisma.ssoDeveloperClient.findUnique({ where: { clientId: CLIENT } })).skipConfirmationEnabled, false);
  await trust();
  const me = await request(server).get('/api/developer/sso/me').set('Authorization', bearer());
  assert.deepEqual(me.body.capabilities, ['sso.skip_confirmation']); assert.equal(me.body.admin, false); assert.equal(me.body.can_register, true);
  assert.equal((await owned()).consent.enabled, false);
  const ops = jwt.sign({ type: 'ops_admin', kind: 'user', sub: owner.id }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const refused = await request(server).get('/api/ops/auth/me').set('Authorization', `Bearer ${ops}`);
  assert.equal(refused.status, 403); assert.equal(refused.body.code, 'NOT_STAFF');
  const registered = await request(server).post('/api/developer/sso/clients').set('Authorization', bearer()).send({ client_name: 'Synthetic new app', contact_email: owner.email, redirect_uris: [CALLBACK] });
  assert.equal(registered.status, 201);
  assert.equal((await prisma.ssoDeveloperClient.findUnique({ where: { clientId: registered.body.client_id } })).skipConfirmationEnabled, false);
  await prisma.ssoDeveloperClient.delete({ where: { clientId: registered.body.client_id } });
});

test('trusted ordinary handoff can skip only after explicit opt-in; login/select_account/standalone/global-off remain manual and scopes stay narrow', async () => {
  await trust();
  const absent = await request(server).post('/api/sso/app-ticket').set('Authorization', bearer(subject)).send({ client_id: CLIENT });
  assert.equal(absent.status, 403);
  assert.equal((await save({ skip_confirmation_enabled: false, initiate_login_uri: INITIATE })).status, 200);
  assert.equal((await owned()).consent.enabled, false);
  const manualHandoff = await handoff();
  assert.equal((await decision(await authorize(), manualHandoff, false)).status, 200, 'qualified handoff remains available in manual mode');
  assert.equal((await save()).status, 200);
  const client = await loadPartnerClient(CLIENT);
  assert.deepEqual(client.scopes, DEVELOPER_SCOPES); assert.equal(client.firstParty, false);
  const scoped = await handoff();
  const flow = await authorize();
  assert.equal((await decision(flow, token(subject), true)).status, 403);
  assert.equal((await decision(flow, scoped, true)).status, 200);
  for (const prompt of ['login', 'select_account']) {
    const forced = await authorize(prompt);
    assert.equal((await decision(forced, scoped, true)).status, 403);
    assert.equal((await prisma.oAuthAuthorization.findUnique({ where: { id: forced.id } })).codeHash, null);
    if (prompt === 'select_account') assert.equal((await decision(forced, scoped, false)).status, 403);
    assert.equal((await decision(forced, token(other), false)).status, 200);
  }
  process.env.SSO_TGE_AUTO_APPROVE = 'off';
  const denied = await authorize();
  assert.equal((await decision(denied, scoped, true)).status, 403);
  assert.equal((await owned()).consent.reason, 'platform_disabled');
  assert.equal((await prisma.oAuthAuthorization.findUnique({ where: { id: denied.id } })).codeHash, null);
});

test('managed consent-only overlay is writable; redirects/secret/URI remain managed', async () => {
  await trust();
  await prisma.ssoDeveloperClient.create({ data: { clientId: MANAGED, clientName: 'Managed overlay', contactEmail: owner.email, ownerUserId: owner.id, secretHash: 'c'.repeat(64), redirectUris: [], kind: 'partner', enabled: false } });
  const saved = await save({ client_id: MANAGED });
  assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.consent.effective, true); assert.equal(saved.body.managed, true);
  assert.equal((await save({ client_id: MANAGED, initiate_login_uri: null })).status, 409);
  const rotated = await request(server).post('/api/developer/sso/clients/secret').set('Authorization', bearer()).send({ client_id: MANAGED });
  assert.equal(rotated.status, 409);
});

test('audit failure rolls preference/URI and role-revoke resets back in the same database transaction', async () => {
  await trust();
  const functionName = `${RUN}_fail_audit`;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${functionName}" BEFORE INSERT ON "OpsAuditLog" FOR EACH ROW WHEN (NEW."requestId" = '${RUN}-fail') EXECUTE FUNCTION "${functionName}"()`);
  try {
    await assert.rejects(updateOwnedConsent(owner.id, { client_id: CLIENT, skip_confirmation_enabled: true, initiate_login_uri: INITIATE, reason: 'Synthetic rollback' }, { actor: actor(), authClaims: verifiedClaims(), requestId: `${RUN}-fail` }), (error) => error.message.includes('synthetic audit failure'));
    let row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: CLIENT } });
    assert.equal(row.skipConfirmationEnabled, false); assert.equal(row.initiateLoginUri, null);
    assert.equal((await save({ initiate_login_uri: INITIATE })).status, 200);
    await assert.rejects(revokeRole({ userId: owner.id, role: 'trusted_developer', reason: 'Synthetic rollback', actor: actor(), requestId: `${RUN}-fail` }), (error) => error.message.includes('synthetic audit failure'));
    row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: CLIENT } });
    assert.equal(row.skipConfirmationEnabled, true);
    assert.ok(await prisma.userRoleGrant.findUnique({ where: { userId_role: { userId: owner.id, role: 'trusted_developer' } } }));
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${functionName}" ON "OpsAuditLog"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
  }
});

test('concurrent revocation wins before final mint even when the auto request read the old committed client first', async () => {
  await trust(); await save({ initiate_login_uri: INITIATE });
  const flow = await authorize();
  let entered, release, finalEntered;
  const held = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  const final = new Promise((r) => { finalEntered = r; });
  const original = prisma.$transaction.bind(prisma);
  const revoking = original(async (tx) => {
    const scopedDb = new Proxy(tx, { get(target, key) { return key === '$transaction' ? (fn) => fn(tx) : target[key]; } });
    await revokeRole({ userId: owner.id, role: 'trusted_developer', reason: 'Synthetic racing revoke', actor: actor() }, scopedDb);
    entered(); await gate;
  }, { timeout: 10000 });
  await held;
  let settled = false;
  prisma.$transaction = (fn, options) => original(async (tx) => { finalEntered(); return fn(tx); }, options);
  const deciding = decideConsent(subject, flow.id, true, { kind: 'sso_ticket', clientId: CLIENT, auto: true,
    initiatorNonce: decodeURIComponent(flow.cookie.split('=')[1]) }).then(() => { settled = true; throw new Error('stale auto approval succeeded'); }, (error) => { settled = true; assert.equal(error.code, 'AUTO_APPROVE_NOT_ALLOWED'); });
  try {
    await final;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(settled, false, 'final mint must actually wait on the revocation transaction');
    release(); await revoking; await deciding;
  } finally { release(); prisma.$transaction = original; await revoking; await deciding; }
  const stored = await prisma.oAuthAuthorization.findUnique({ where: { id: flow.id } });
  assert.equal(stored.codeHash, null); assert.equal(stored.consumedAt, null);
  assert.equal((await owned()).consent.enabled, false);
  await trust(); assert.equal((await owned()).consent.enabled, false);
  assert.equal((await decision(flow, token(subject), false)).status, 200);
});

test('a busy policy lock times out in three seconds and leaves setting/audit unchanged', async () => {
  await trust();
  let enter, release;
  const entered = new Promise((r) => { enter = r; });
  const gate = new Promise((r) => { release = r; });
  const held = prisma.$transaction(async (tx) => { await lockConsentPolicy(tx); enter(); await gate; }, { timeout: 10000 });
  await entered;
  const start = Date.now();
  try {
    await assert.rejects(updateOwnedConsent(owner.id, { client_id: CLIENT, skip_confirmation_enabled: true, initiate_login_uri: INITIATE, reason: 'Synthetic timeout' }, { actor: actor(), authClaims: verifiedClaims() }), (error) => error.code === 'P2010' && error.meta?.code === '55P03');
    assert.ok(Date.now() - start >= 2800 && Date.now() - start < 6000);
    assert.equal((await owned()).consent.enabled, false);
  } finally { release(); await held; }
});

test('a preference request that passed login before disable/re-enable cannot commit with that old JWT after waiting', async () => {
  await trust();
  const oldJwt = token(owner);
  await new Promise((r) => setTimeout(r, 2));
  let enter, release, enteredWrite;
  const entered = new Promise((r) => { enter = r; });
  const gate = new Promise((r) => { release = r; });
  const write = new Promise((r) => { enteredWrite = r; });
  const original = prisma.$transaction.bind(prisma);
  const changing = original(async (tx) => {
    const scoped = new Proxy(tx, { get(target, key) { return key === '$transaction' ? (fn) => fn(tx) : target[key]; } });
    await disableAccount({ userId: owner.id, reason: 'Synthetic racing disable', actor: actor() }, scoped);
    await enableAccount({ userId: owner.id, reason: 'Synthetic racing enable', actor: actor() }, scoped);
    enter(); await gate;
  }, { timeout: 10000 });
  await entered;
  prisma.$transaction = (fn, options) => original(async (tx) => { enteredWrite(); return fn(tx); }, options);
  const saving = request(server).post('/api/developer/sso/clients/consent').set('Authorization', `Bearer ${oldJwt}`)
    .send({ client_id: CLIENT, skip_confirmation_enabled: true, initiate_login_uri: INITIATE, reason: 'Synthetic stale login' }).then((res) => res);
  try {
    await write;
    release(); await changing;
    const refused = await saving;
    assert.equal(refused.status, 401, refused.text); assert.equal(refused.body.error, 'session_revoked');
    assert.equal((await prisma.ssoDeveloperClient.findUnique({ where: { clientId: CLIENT } })).skipConfirmationEnabled, false);
  } finally { release(); prisma.$transaction = original; await changing; await saving; }
});

test('owner disable/re-enable and supported manager reassignment require a new explicit choice; raw owner changes fail closed', async () => {
  await trust(); await save({ initiate_login_uri: INITIATE });
  const pending = await authorize();
  await disableAccount({ userId: owner.id, reason: 'Synthetic owner disable', actor: actor() });
  assert.equal((await loadPartnerClient(CLIENT)).autoApprove.app, false);
  await enableAccount({ userId: owner.id, reason: 'Synthetic owner restore', actor: actor() });
  assert.equal((await prisma.ssoDeveloperClient.findUnique({ where: { clientId: CLIENT } })).skipConfirmationEnabled, false);
  assert.equal((await prisma.oAuthAuthorization.findUnique({ where: { id: pending.id } })).codeHash, null);
  await prisma.ssoDeveloperClient.update({ where: { clientId: CLIENT }, data: { ownerUserId: other.id, skipConfirmationEnabled: true, skipConfirmationOwnerUserId: owner.id } });
  await trust(other);
  assert.equal((await owned(other)).consent.enabled, false);
  const savedHost = process.env.PLANET_MANAGER_API_HOSTS;
  process.env.PLANET_MANAGER_API_HOSTS = 'api.example.test';
  const row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: PLANET_MANAGER_CLIENT_ID } });
  assert.equal(row, null, 'the disposable test database must not contain a real partner row');
  try {
    await grantPlanetManager(owner.email, { actor: actor(), reason: 'Synthetic manager assignment' });
    await prisma.ssoDeveloperClient.update({ where: { clientId: PLANET_MANAGER_CLIENT_ID }, data: { skipConfirmationEnabled: true, skipConfirmationOwnerUserId: owner.id } });
    await grantPlanetManager(other.email, { actor: actor(), reason: 'Synthetic manager change' });
    assert.equal((await prisma.ssoDeveloperClient.findUnique({ where: { clientId: PLANET_MANAGER_CLIENT_ID } })).skipConfirmationEnabled, false);
  } finally {
    if (savedHost === undefined) delete process.env.PLANET_MANAGER_API_HOSTS; else process.env.PLANET_MANAGER_API_HOSTS = savedHost;
    await prisma.ssoDeveloperClient.deleteMany({ where: { clientId: PLANET_MANAGER_CLIENT_ID } });
  }
});
