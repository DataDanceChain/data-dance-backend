/**
 * The full user view (admin issue #2): GET /api/ops/users/:userId keeps its existing keys and adds
 * account, identity, roles, data licence, privacy requests, developer clients, merchant, sign-in
 * issues and history. The last two need ops.support (null otherwise, e.g. for demo). Search rows
 * gain disabledAt. Through the REAL application on the in-memory Prisma stand-in.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens } = require('../helpers/opsApp');

const { prisma, app } = installOpsApp();
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { writeAudit } = require('../../src/services/opsAudit');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const EXISTING_KEYS = ['user', 'points', 'uploads', 'referral'];
const NEW_KEYS = ['account', 'identity', 'roles', 'dataLicence', 'privacyRequests', 'developerClients', 'merchant', 'identityConflicts', 'audit'];
const USER_KEYS = ['id', 'email', 'name', 'walletAddress', 'referralCode', 'totalPoints', 'authType', 'userType', 'createdAt', 'xid', 'xUsername', 'disabledAt'];

let admin;
let member;
const auth = {};
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  delete process.env.OPS_SHARED_LOGIN;
  admin = await seedUser(prisma, { email: 'sloan@example.test' });
  await grant(prisma, admin.id, 'ddc_admin');
  const operator = await seedUser(prisma);
  await grant(prisma, operator.id, 'operator');
  auth.admin = bearer(tokens.ops(admin));
  auth.operator = bearer(tokens.ops(operator));
  auth.demo = bearer(tokens.demo());

  member = await seedUser(prisma, {
    email: 'member@example.test',
    walletAddress: '0x1111111111111111111111111111111111111111',
    xUsername: 'member_x',
    web3authVerifier: 'web3auth-google-sapphire-mainnet',
    web3authVerifierId: 'member@example.test',
    web3authLinkedAt: new Date('2026-10-02T00:00:00Z'),
    disabledAt: new Date('2026-10-10T00:00:00Z'),
    disabledBy: 'sloan@example.test',
    disabledReason: 'fraud report #12',
  });
  await grant(prisma, member.id, 'developer', { grantedBy: 'sloan@example.test', reason: 'TGE partner integration' });
  await prisma.dataLicenceConsent.create({
    data: { userId: member.id, policyVersion: '2026-09', grantedAt: new Date('2026-09-05T00:00:00Z'), withdrawnAt: null, source: 'connect' },
  });
  for (let i = 0; i < 22; i += 1) {
    await prisma.privacyRequest.create({
      data: { userId: member.id, kind: 'export', createdAt: new Date(Date.UTC(2026, 8, 1 + i)) },
    });
  }
  await prisma.ssoDeveloperClient.create({
    data: { clientId: 'ddc_dev_member', clientName: 'Member app', contactEmail: 'member@example.test', secretHash: 'h'.repeat(64), redirectUris: [], enabled: true, kind: 'developer', ownerUserId: member.id, createdAt: new Date('2026-10-03T00:00:00Z') },
  });
  await prisma.legalEntity.create({
    data: { userId: member.id, companyName: 'Member Ltd', kycStatus: 'approved', kycReviewedAt: new Date('2026-10-04T00:00:00Z') },
  });
  await prisma.web3AuthNetworkRebind.create({
    data: {
      userId: member.id, runId: 'run-1', fromNetwork: 'sapphire_devnet', toNetwork: 'sapphire_mainnet',
      walletPolicy: 'replace', evidence: 'devnet_pair', status: 'rebound',
      oldAddress: '0x2222222222222222222222222222222222222222', newAddress: '0x1111111111111111111111111111111111111111',
      reboundAt: new Date('2026-10-06T00:00:00Z'),
    },
  });
  await prisma.identityConflict.create({
    data: { reason: 'wallet_in_use', route: 'network_rebind', candidateBy: 'email', candidateUserId: member.id, verifier: 'web3auth-google-sapphire-mainnet' },
  });
  await writeAudit(prisma, {
    actor: { kind: 'user', userId: admin.id, label: 'sloan@example.test', role: 'ddc_admin' },
    action: 'account.disable',
    target: { type: 'user', id: member.id, label: 'member@example.test' },
    reason: 'fraud report #12',
    detail: { mcpTokens: 0, ssoTickets: 0 },
    surface: 'ops',
  });
});

const view = (userId, authorization) => request(server).get(`/api/ops/users/${userId}`).set('Authorization', authorization);

describe('GET /api/ops/users/:userId', () => {
  it('keeps the existing keys, adds the new sections, and `user` gains only disabledAt', async () => {
    const res = await view(member.id, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.deepEqual(Object.keys(data).sort(), [...EXISTING_KEYS, ...NEW_KEYS].sort());
    assert.deepEqual(Object.keys(data.user).sort(), [...USER_KEYS].sort());
    assert.equal(data.user.disabledAt, '2026-10-10T00:00:00.000Z');
    assert.equal(data.user.web3authVerifierId, undefined, 'identity columns stay out of `user`');
  });

  it('fills every section', async () => {
    const data = (await view(member.id, auth.admin)).body.data;
    assert.deepEqual(data.account, {
      authType: 'web3auth',
      userType: 'regular',
      isOrganization: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      disabledAt: '2026-10-10T00:00:00.000Z',
      disabledBy: 'sloan@example.test',
      disabledReason: 'fraud report #12',
    });
    assert.deepEqual(data.identity.web3auth, {
      verifier: 'web3auth-google-sapphire-mainnet',
      verifierId: 'member@example.test',
      linkedAt: '2026-10-02T00:00:00.000Z',
    });
    assert.equal(data.identity.walletAddress, '0x1111111111111111111111111111111111111111');
    assert.equal(data.identity.xUsername, 'member_x');
    assert.equal(data.identity.rebind.status, 'rebound');
    assert.equal(data.identity.rebind.walletPolicy, 'replace');
    assert.equal(data.identity.rebind.evidence, 'devnet_pair');
    assert.equal(data.identity.rebind.oldAddress, '0x2222222222222222222222222222222222222222');
    assert.equal(data.identity.rebind.reboundAt, '2026-10-06T00:00:00.000Z');
    assert.equal(data.roles.length, 1);
    assert.deepEqual(
      { role: data.roles[0].role, grantedBy: data.roles[0].grantedBy, reason: data.roles[0].reason },
      { role: 'developer', grantedBy: 'sloan@example.test', reason: 'TGE partner integration' },
    );
    assert.deepEqual(data.dataLicence, { policyVersion: '2026-09', grantedAt: '2026-09-05T00:00:00.000Z', withdrawnAt: null, source: 'connect' });
    assert.equal(data.privacyRequests.length, 20, 'the newest 20');
    assert.equal(data.privacyRequests[0].createdAt, '2026-09-22T00:00:00.000Z');
    assert.deepEqual(Object.keys(data.privacyRequests[0]).sort(), ['createdAt', 'id', 'kind', 'resolvedAt', 'resolvedBy', 'status']);
    assert.deepEqual(data.developerClients, [
      { client_id: 'ddc_dev_member', client_name: 'Member app', kind: 'developer', enabled: true, created_at: '2026-10-03T00:00:00.000Z' },
    ]);
    assert.ok(!JSON.stringify(data.developerClients).includes('h'.repeat(64)), 'never a secret hash');
    assert.deepEqual(data.merchant, {
      isOrganization: false,
      legalEntity: { companyName: 'Member Ltd', kycStatus: 'approved', kycReviewedAt: '2026-10-04T00:00:00.000Z' },
    });
    assert.equal(data.identityConflicts.length, 1);
    assert.deepEqual(
      { reason: data.identityConflicts[0].reason, route: data.identityConflicts[0].route, verifier: data.identityConflicts[0].verifier },
      { reason: 'wallet_in_use', route: 'network_rebind', verifier: 'web3auth-google-sapphire-mainnet' },
    );
    assert.equal(data.audit.length, 1);
    assert.equal(data.audit[0].action, 'account.disable');
    assert.deepEqual(data.audit[0].actor, { kind: 'user', userId: admin.id, label: 'sloan@example.test', role: 'ddc_admin' });
  });

  it('an account with nothing extra gets empty sections, not errors', async () => {
    const plain = await seedUser(prisma);
    const data = (await view(plain.id, auth.admin)).body.data;
    assert.equal(data.identity.web3auth, null);
    assert.equal(data.identity.rebind, null);
    assert.deepEqual(data.roles, []);
    assert.equal(data.dataLicence, null);
    assert.deepEqual(data.privacyRequests, []);
    assert.deepEqual(data.developerClients, []);
    assert.deepEqual(data.merchant, { isOrganization: false, legalEntity: null });
    assert.deepEqual(data.identityConflicts, []);
    assert.deepEqual(data.audit, []);
  });

  it('an operator (ops.support) sees sign-in issues, history, identity and who acted; demo and shared do not', async () => {
    const newest = prisma.store.privacyRequest.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    Object.assign(newest, { status: 'resolved', resolvedAt: new Date('2026-10-05T00:00:00Z'), resolvedBy: 'sloan@example.test' });

    const operatorView = (await view(member.id, auth.operator)).body.data;
    assert.equal(operatorView.identityConflicts.length, 1);
    assert.equal(operatorView.audit.length, 1);
    assert.equal(operatorView.identity.web3auth.verifierId, 'member@example.test');
    assert.equal(operatorView.identity.rebind.oldAddress, '0x2222222222222222222222222222222222222222');
    assert.equal(operatorView.account.disabledBy, 'sloan@example.test');
    assert.equal(operatorView.account.disabledReason, 'fraud report #12');
    assert.equal(operatorView.roles[0].grantedBy, 'sloan@example.test');
    assert.equal(operatorView.privacyRequests[0].resolvedBy, 'sloan@example.test');

    process.env.OPS_SHARED_LOGIN = 'on';
    for (const [name, authorization] of [['demo', auth.demo], ['shared', bearer(tokens.shared())]]) {
      const res = await view(member.id, authorization);
      assert.equal(res.status, 200, name);
      const data = res.body.data;
      assert.equal(data.identityConflicts, null, name);
      assert.equal(data.audit, null, name);
      assert.equal(data.identity, null, `${name}: no verifier ids, rebind addresses or evidence`);
      assert.equal(data.account.disabledAt, '2026-10-10T00:00:00.000Z', `${name}: the status itself stays`);
      assert.equal(data.account.disabledBy, null, name);
      assert.equal(data.account.disabledReason, null, name);
      assert.equal(data.roles.length, 1, `${name}: the rest of the view is readable`);
      assert.equal(data.roles[0].grantedBy, null, name);
      assert.equal(data.privacyRequests[0].status, 'resolved', name);
      assert.equal(data.privacyRequests[0].resolvedBy, null, name);
      const text = JSON.stringify(data);
      for (const hidden of ['fraud report #12', '0x2222222222222222222222222222222222222222', 'devnet_pair', 'web3auth-google-sapphire-mainnet']) {
        assert.ok(!text.includes(hidden), `${name}: ${hidden} is not in the answer`);
      }
    }
  });

  it('an unknown account is 404 USER_NOT_FOUND', async () => {
    const res = await view('no-such-user', auth.admin);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'USER_NOT_FOUND');
  });
});

describe('GET /api/ops/users/search', () => {
  it('rows carry disabledAt', async () => {
    // By id: the in-memory stand-in does not implement `contains`; the select is the same for every match.
    const res = await request(server).get(`/api/ops/users/search?q=${member.id}`).set('Authorization', auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.data.users.find((u) => u.id === member.id);
    assert.ok(row);
    assert.equal(row.disabledAt, '2026-10-10T00:00:00.000Z');
  });
});
