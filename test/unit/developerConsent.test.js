const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { installOpsApp, listenLoopback, seedUser, grant, tokens, bearer } = require('../helpers/opsApp');
const { prisma, app } = installOpsApp({ env: { SSO_TGE_ENABLED: 'true', SSO_TGE_CLIENT_ID: 'managed-test', SSO_TGE_CLIENT_NAME: 'Managed', SSO_TGE_CLIENT_SECRET_SHA256: 'a'.repeat(64), SSO_TGE_REDIRECT_URIS: 'https://client.example.test/callback', SSO_TGE_INITIATE_LOGIN_URI: 'https://client.example.test/login/ddc', SSO_TGE_AUTO_APPROVE: 'app' } });
const { revokeRole, grantRole } = require('../../src/services/userRoles');
const { actorFromUser } = require('../../src/services/opsAudit');
const { disableAccount, enableAccount } = require('../../src/services/opsAccounts');
const { loadPartnerClient, DEVELOPER_SCOPES } = require('../../src/services/ssoDeveloperClient');
let server, owner, stranger, admin;
before(async () => { server = await listenLoopback(app); });
after(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(async () => {
  prisma.reset();
  process.env.SSO_TGE_AUTO_APPROVE = 'app';
  owner = await seedUser(prisma); stranger = await seedUser(prisma); admin = await seedUser(prisma);
  await grant(prisma, admin.id, 'ddc_admin');
});
const actor = () => actorFromUser(admin, 'ddc_admin');
const auth = (user = owner) => bearer(tokens.wallet(user));
async function client(over = {}) {
  return prisma.ssoDeveloperClient.create({ data: { clientId: 'owned-test', clientName: 'Synthetic client', ownerUserId: owner.id, kind: 'developer', enabled: true, secretHash: 'b'.repeat(64), redirectUris: ['https://client.example.test/callback'], ...over } });
}
const save = (body = {}, user = owner) => request(server).post('/api/developer/sso/clients/consent').set('Authorization', auth(user)).send({ client_id: 'owned-test', skip_confirmation_enabled: true, reason: 'Synthetic consent setting', ...body });
async function view(user = owner) { return (await request(server).get('/api/developer/sso/clients').set('Authorization', auth(user))).body.clients[0]; }

test('ordinary owner sees qualification and cannot forge an enable or write any setting on refusal', async () => {
  await client();
  assert.equal((await view()).consent.reason, 'qualification_required');
  const res = await save({ initiate_login_uri: 'https://client.example.test/login/ddc' });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.body.error, 'qualification_required');
  const row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: 'owned-test' } });
  assert.ok(!row.skipConfirmationEnabled);
  assert.ok(!row.initiateLoginUri);
});

test('trusted means one named capability and default-off, never staff/admin', async () => {
  await client(); await grant(prisma, owner.id, 'trusted_developer');
  const me = await request(server).get('/api/developer/sso/me').set('Authorization', auth());
  assert.deepEqual(me.body.capabilities, ['sso.skip_confirmation']);
  assert.equal(me.body.admin, false); assert.equal(me.body.can_register, true);
  assert.deepEqual((await view()).consent, { eligible: true, enabled: false, effective: false, reason: 'not_enabled', platform_enabled: true, initiate_login_uri: null });
});

test('trusted on/off and global deny are server-derived without kind or scope promotion', async () => {
  await client(); await grant(prisma, owner.id, 'trusted_developer');
  const res = await save({ initiate_login_uri: 'https://client.example.test/login/ddc' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.kind, 'developer'); assert.deepEqual(res.body.scopes, DEVELOPER_SCOPES);
  assert.equal(res.body.consent.effective, true);
  const shaped = await loadPartnerClient('owned-test');
  assert.equal(shaped.initiateLoginUri, 'https://client.example.test/login/ddc');
  assert.deepEqual(shaped.scopes, DEVELOPER_SCOPES); assert.equal(shaped.firstParty, false);
  assert.deepEqual(shaped.autoApprove, { app: true, web: false });
  process.env.SSO_TGE_AUTO_APPROVE = 'off';
  assert.deepEqual((await view()).consent, { ...res.body.consent, effective: false, platform_enabled: false, reason: 'platform_disabled' });
  const audit = await prisma.opsAuditLog.findFirst({ where: { action: 'console.consent_settings' } });
  assert.equal(audit.reason, 'Synthetic consent setting'); assert.ok(!JSON.stringify(audit.detail).includes('https://'));
  assert.equal((await save({ skip_confirmation_enabled: false })).status, 200);
  assert.equal((await view()).consent.enabled, false);
});

test('unowned clients are 404 and missing reason or non-boolean requests change nothing', async () => {
  await client(); await grant(prisma, owner.id, 'trusted_developer');
  assert.equal((await save({}, stranger)).status, 404);
  for (const body of [{ reason: '' }, { skip_confirmation_enabled: 'true' }]) assert.equal((await save(body)).status, 400);
  assert.ok(!(await prisma.ssoDeveloperClient.findUnique({ where: { clientId: 'owned-test' } })).skipConfirmationEnabled);
});

test('managed overlay can save consent but its other managed editing protections remain', async () => {
  await client({ clientId: 'managed-test', enabled: false }); await grant(prisma, owner.id, 'trusted_developer');
  const res = await save({ client_id: 'managed-test' });
  assert.equal(res.status, 200, res.text); assert.equal(res.body.managed, true); assert.equal(res.body.consent.effective, true);
  assert.equal((await save({ client_id: 'managed-test', initiate_login_uri: null })).status, 409);
  assert.equal((await request(server).post('/api/developer/sso/clients/update').set('Authorization', auth()).send({ client_id: 'managed-test', redirect_uris: ['https://other.example.test/callback'] })).status, 409);
});

test('preference and handoff changes roll back together when durable audit fails', async () => {
  await client(); await grant(prisma, owner.id, 'trusted_developer');
  const create = prisma.opsAuditLog.create;
  prisma.opsAuditLog.create = async () => { throw new Error('Synthetic audit failure'); };
  try { assert.equal((await save({ initiate_login_uri: 'https://client.example.test/login/ddc' })).status, 500); }
  finally { prisma.opsAuditLog.create = create; }
  const row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: 'owned-test' } });
  assert.ok(!row.skipConfirmationEnabled); assert.ok(!row.initiateLoginUri);
});

test('the privileged settings service fails closed when verified claims are omitted', async () => {
  await client(); await grant(prisma, owner.id, 'trusted_developer');
  const { updateOwnedConsent } = require('../../src/services/ssoDeveloperClient');
  await assert.rejects(updateOwnedConsent(owner.id, { client_id: 'owned-test', skip_confirmation_enabled: true, reason: 'Synthetic missing claims' }, { actor: actor() }),
    (error) => error.status === 403 && error.code === 'verified_session_required');
  assert.equal((await view()).consent.enabled, false);
});

test('role revocation resets preference atomically and regrant never revives it', async () => {
  await client(); await grant(prisma, owner.id, 'trusted_developer');
  assert.equal((await save({ initiate_login_uri: 'https://client.example.test/login/ddc' })).status, 200);
  await revokeRole({ userId: owner.id, role: 'trusted_developer', reason: 'Synthetic revocation', actor: actor() });
  assert.equal((await view()).consent.enabled, false);
  await grantRole({ userId: owner.id, role: 'trusted_developer', reason: 'Synthetic regrant', actor: actor() });
  assert.equal((await view()).consent.enabled, false);
});

test('owner disable and client disable reset preference; direct ownership changes fail closed', async () => {
  await client(); await grant(prisma, owner.id, 'trusted_developer');
  await save({ initiate_login_uri: 'https://client.example.test/login/ddc' });
  await disableAccount({ userId: owner.id, reason: 'Synthetic disable', actor: actor() });
  const disabled = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: 'owned-test' } });
  assert.equal(disabled.skipConfirmationEnabled, false);
  await enableAccount({ userId: owner.id, reason: 'Synthetic enable', actor: actor() });
  // Service-level fixture removes JWT age from this branch; the real HTTP/session regression is separate.
  await prisma.user.update({ where: { id: owner.id }, data: { sessionsResetAt: null } });
  await save();
  const off = await request(server).post('/api/developer/sso/clients/update').set('Authorization', auth()).send({ client_id: 'owned-test', redirect_uris: ['https://client.example.test/callback'], enabled: false });
  assert.equal(off.status, 200, off.text); assert.equal(off.body.consent.enabled, false);
  await prisma.ssoDeveloperClient.update({ where: { clientId: 'owned-test' }, data: { enabled: true, skipConfirmationEnabled: true, skipConfirmationOwnerUserId: owner.id, ownerUserId: stranger.id } });
  await grant(prisma, stranger.id, 'trusted_developer');
  assert.equal((await view(stranger)).consent.enabled, false); assert.equal((await view(stranger)).consent.effective, false);
});

test('card handoff validation accepts only qualified ordinary URI registration, independent of auto opt-in', async () => {
  const { listHandoffClientIds, listFirstPartyClientIds } = require('../../src/services/ssoDeveloperClient');
  const { campaignSsoClientIds, ssoClientIdProblem } = require('../../src/utils/campaignRules');
  await client({ initiateLoginUri: 'https://client.example.test/login/ddc' });
  let ids = campaignSsoClientIds(await listHandoffClientIds());
  assert.match(ssoClientIdProblem('owned-test', ids), /Unknown SSO client/);
  await grant(prisma, owner.id, 'trusted_developer');
  process.env.SSO_TGE_AUTO_APPROVE = 'off';
  ids = campaignSsoClientIds(await listHandoffClientIds());
  assert.equal(ssoClientIdProblem('owned-test', ids), '');
  assert.deepEqual(await listFirstPartyClientIds(), [], 'ordinary qualification does not change the partner-only list');
  assert.deepEqual((await loadPartnerClient('owned-test')).scopes, DEVELOPER_SCOPES);
  assert.equal((await view()).consent.enabled, false);
  await prisma.ssoDeveloperClient.update({ where: { clientId: 'owned-test' }, data: { initiateLoginUri: null } });
  assert.ok(!(await listHandoffClientIds()).includes('owned-test'));
});
