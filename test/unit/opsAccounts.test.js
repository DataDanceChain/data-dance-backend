/**
 * Disable / re-enable an account from ops (admin issue #2), and every path that must refuse a
 * disabled account while it is disabled: the wallet API (`protect`), the Web3Auth sign-in
 * (`resolveUser`), the App SSO ticket and its exchange, the SSO session principal, the partner API,
 * MCP, the live partner bridge, the developer console and ops itself. After a re-enable, an
 * unexpired wallet JWT works again. Through the REAL application on the in-memory Prisma stand-in.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, settle, ISSUER, recordLabel } = require('../helpers/opsApp');

const PARTNER_CLIENT = 'tge-test';
const { prisma, app } = installOpsApp({
  env: {
    SSO_TGE_ENABLED: 'true',
    SSO_TGE_CLIENT_ID: PARTNER_CLIENT,
    SSO_TGE_CLIENT_NAME: 'DDC TGE',
    SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update('tge-secret-dev').digest('hex'),
    SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/oauth/callback',
    SSO_TGE_INITIATE_LOGIN_URI: 'https://tge.example.com/login/ddc',
  },
});
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { signSsoSession } = require('../../src/routes/ssoRoutes');
const { findUserByMcpToken } = require('../../src/services/mcpTokenService');
const { readPartnerMe } = require('../../src/services/ssoDeveloperLive');
const { resolveUser } = require('../../src/services/web3authIdentity');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

let admin;
let adminAuth;
let member;
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  admin = await seedUser(prisma, { email: 'admin@example.test' });
  await grant(prisma, admin.id, 'ddc_admin');
  adminAuth = bearer(tokens.ops(admin));
  member = await seedUser(prisma, {
    email: 'member@example.test',
    web3authVerifier: 'web3auth-google-sapphire-mainnet',
    web3authVerifierId: 'member@example.test',
  });
});

const disable = (userId, body, auth = adminAuth) =>
  request(server).post(`/api/ops/users/${userId}/disable`).set('Authorization', auth).send(body);
const enable = (userId, body, auth = adminAuth) =>
  request(server).post(`/api/ops/users/${userId}/enable`).set('Authorization', auth).send(body);
const userRow = (id) => prisma.store.user.find((row) => row.id === id);

async function seedAccessFor(user) {
  const mcp = `ddc_mcp_${crypto.randomBytes(24).toString('base64url')}`;
  const partner = `ddc_sso_${crypto.randomBytes(24).toString('base64url')}`;
  await prisma.mcpToken.create({
    data: { userId: user.id, tokenHash: sha256(mcp), tokenPrefix: mcp.slice(0, 12), label: 'Claude', source: 'manual', clientId: '', resource: '', scope: '', expiresAt: null, lastUsedAt: null },
  });
  await prisma.mcpToken.create({
    data: {
      userId: user.id, tokenHash: sha256(partner), tokenPrefix: partner.slice(0, 12), label: 'DDC TGE', source: 'partner',
      clientId: PARTNER_CLIENT, resource: `${ISSUER}/partner/sso`, scope: 'sso:identity sso:status', expiresAt: new Date(Date.now() + 300000), lastUsedAt: null,
    },
  });
  const ticket = await prisma.ssoTicket.create({
    data: { ticketHash: sha256('ticket-for-session'), userId: user.id, clientId: PARTNER_CLIENT, expiresAt: new Date(Date.now() + 60000), consumedAt: new Date() },
  });
  return { mcp, partner, ticket };
}

describe('POST /api/ops/users/:userId/disable and /enable', () => {
  it('disables: sets the three fields, ends MCP/partner tokens and SSO tickets, writes account.disable', async () => {
    await seedAccessFor(member);
    const res = await disable(member.id, { reason: 'fraud report #12' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const state = res.body.data.user;
    assert.equal(state.id, member.id);
    assert.ok(state.disabledAt);
    assert.equal(state.disabledBy, recordLabel(admin.id), 'the record label, never the e-mail');
    assert.equal(state.disabledReason, 'fraud report #12');
    const row = userRow(member.id);
    assert.ok(row.disabledAt instanceof Date);
    assert.equal(row.disabledBy, recordLabel(admin.id));
    assert.equal(row.sessionsResetAt.getTime(), row.disabledAt.getTime(), 'a disable resets the staff sessions');
    assert.equal(prisma.store.mcpToken.filter((t) => t.userId === member.id).length, 0);
    assert.equal(prisma.store.ssoTicket.filter((t) => t.userId === member.id).length, 0);
    await settle();
    const audit = prisma.store.opsAuditLog;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'account.disable');
    assert.equal(audit[0].targetId, member.id);
    assert.equal(audit[0].reason, 'fraud report #12');
    assert.deepEqual(audit[0].detail, { mcpTokens: 2, ssoTickets: 1 });
  });

  it('enables: clears the three fields and records what they were; role grants are kept', async () => {
    await grant(prisma, member.id, 'developer');
    await disable(member.id, { reason: 'fraud report #12' });
    const disabledReset = userRow(member.id).sessionsResetAt;
    const res = await enable(member.id, { reason: 'cleared after review' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.user, { id: member.id, disabledAt: null, disabledBy: null, disabledReason: null });
    const row = userRow(member.id);
    assert.ok(row.sessionsResetAt instanceof Date && row.sessionsResetAt >= disabledReset, 'a re-enable resets them again');
    assert.equal(row.disabledAt, null);
    assert.equal(row.disabledBy, null);
    assert.equal(row.disabledReason, null);
    const enabled = prisma.store.opsAuditLog.find((r) => r.action === 'account.enable');
    assert.equal(enabled.reason, 'cleared after review');
    assert.equal(enabled.detail.previous.disabledBy, recordLabel(admin.id));
    assert.equal(enabled.actorLabel, 'admin@example.test', 'the audit row keeps who acted');
    assert.equal(enabled.detail.previous.disabledReason, 'fraud report #12');
    assert.match(enabled.detail.previous.disabledAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(prisma.store.userRoleGrant.filter((g) => g.userId === member.id).map((g) => g.role), ['developer']);
  });

  it('refuses: already disabled, not disabled, yourself, no reason, no account', async () => {
    await disable(member.id, { reason: 'first time' });
    const twice = await disable(member.id, { reason: 'second time' });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'ALREADY_DISABLED');

    const other = await seedUser(prisma);
    const notDisabled = await enable(other.id, { reason: 'nothing to do' });
    assert.equal(notDisabled.status, 409);
    assert.equal(notDisabled.body.code, 'NOT_DISABLED');

    const self = await disable(admin.id, { reason: 'myself' });
    assert.equal(self.status, 409);
    assert.equal(self.body.code, 'SELF_CHANGE');

    for (const reason of [undefined, '', 'no']) {
      const res = await disable(other.id, { reason });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'REASON_REQUIRED');
    }
    const missing = await disable('no-such-user', { reason: 'nobody' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'USER_NOT_FOUND');
    assert.equal(userRow(other.id).disabledAt, null);
  });

  it('LAST_ADMIN: two admins disabling each other at once cannot leave none enabled', async () => {
    const secondAdmin = await seedUser(prisma, { email: 'second-admin@example.test' });
    await grant(prisma, secondAdmin.id, 'ddc_admin');
    // admin disables secondAdmin: admin stays enabled, so this is allowed.
    const first = await disable(secondAdmin.id, { reason: 'rotation test' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // secondAdmin's request had already passed its session check when admin's committed (the two
    // run under one advisory lock): it now finds admin the last enabled ddc_admin and is refused.
    const { disableAccount } = require('../../src/services/opsAccounts');
    await assert.rejects(
      disableAccount({
        userId: admin.id,
        reason: 'rotation test',
        actor: { kind: 'user', userId: secondAdmin.id, label: 'second-admin@example.test', role: 'ddc_admin' },
      }),
      (error) => error.code === 'LAST_ADMIN' && error.status === 409,
    );
    assert.equal(userRow(admin.id).disabledAt, null);
    assert.ok(prisma.rawStatements.some((row) => /pg_advisory_xact_lock/.test(row.sql)), 'the change ran under the admin lock');
  });

  it('the shared login cannot disable or enable (no ops.admin)', async () => {
    process.env.OPS_SHARED_LOGIN = 'on';
    try {
      const res = await disable(member.id, { reason: 'shared tries' }, bearer(tokens.shared()));
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'FORBIDDEN_ROLE');
    } finally {
      delete process.env.OPS_SHARED_LOGIN;
    }
    assert.equal(userRow(member.id).disabledAt, null);
  });

  it('a failed audit write leaves the account enabled and its tokens in place', async () => {
    await seedAccessFor(member);
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw new Error('audit store down'); };
    try {
      const res = await disable(member.id, { reason: 'fraud report #12' });
      assert.equal(res.status, 500);
    } finally {
      prisma.opsAuditLog.create = original;
    }
    assert.equal(userRow(member.id).disabledAt, null);
    assert.equal(prisma.store.mcpToken.filter((t) => t.userId === member.id).length, 2);
  });
});

describe('while disabled, every path refuses the account; after enable the wallet JWT works again', () => {
  it('walks every path', async () => {
    await grant(prisma, member.id, 'operator');
    // Issued a few seconds before the disable (JWT `iat` has whole seconds).
    const walletJwt = bearer(tokens.wallet(member, { ageSec: 5 }));
    const opsSession = bearer(tokens.ops(member, { ageSec: 5 }));
    assert.equal((await request(server).get('/api/developer/sso/clients').set('Authorization', walletJwt)).status, 200);

    const access = await seedAccessFor(member);
    assert.equal((await disable(member.id, { reason: 'fraud report #12' })).status, 200);
    // Rows a disable would have deleted, put back so each path's own check is what refuses.
    const again = await seedAccessFor(member);

    // Wallet API (`protect`).
    const wallet = await request(server).get('/api/developer/sso/clients').set('Authorization', walletJwt);
    assert.equal(wallet.status, 403);
    assert.equal(wallet.body.code, 'ACCOUNT_DISABLED');

    // Web3Auth sign-in (resolveUser, pair hit).
    await assert.rejects(
      resolveUser({ verifier: 'web3auth-google-sapphire-mainnet', verifierId: 'member@example.test', email: 'member@example.test' }, { db: prisma }),
      (error) => error.code === 'ACCOUNT_DISABLED',
    );

    // App SSO ticket mint.
    const ticket = await request(server).post('/api/sso/app-ticket').set('Authorization', walletJwt).send({ client_id: PARTNER_CLIENT });
    assert.equal(ticket.status, 403);
    assert.equal(ticket.body.code, 'ACCOUNT_DISABLED');

    // App SSO ticket exchange.
    const rawTicket = `ddc_tkt_${crypto.randomBytes(16).toString('hex')}`;
    await prisma.ssoTicket.create({
      data: { ticketHash: sha256(rawTicket), userId: member.id, clientId: PARTNER_CLIENT, expiresAt: new Date(Date.now() + 60000), consumedAt: null },
    });
    const exchanged = await request(server).post('/api/sso/ticket/exchange').send({ ticket: rawTicket });
    assert.equal(exchanged.status, 403);
    assert.equal(exchanged.body.code, 'ACCOUNT_DISABLED');

    // The consent-only SSO session principal.
    const { token: session } = signSsoSession({ userId: member.id, clientId: PARTNER_CLIENT, jti: again.ticket.id });
    const consent = await request(server).get('/api/oauth/requests/missing-request').set('Authorization', `Bearer ${session}`);
    assert.equal(consent.status, 401);
    assert.equal(consent.body.code, 'SSO_SESSION_EXPIRED');

    // Partner API.
    const partner = await request(server).get('/partner/sso/me').set('Authorization', `Bearer ${again.partner}`);
    assert.equal(partner.status, 403);
    assert.equal(partner.body.error, 'account_disabled');

    // MCP and the live partner bridge.
    assert.equal(await findUserByMcpToken(again.mcp), null);
    assert.equal(await readPartnerMe(again.partner), null);

    // Developer console (also its role endpoint).
    const consoleMe = await request(server).get('/api/developer/sso/me').set('Authorization', walletJwt);
    assert.equal(consoleMe.status, 403);

    // Ops (a personal session of the disabled account) and the ops sign-in code.
    const ops = await request(server).get('/api/ops/auth/me').set('Authorization', opsSession);
    assert.equal(ops.status, 403);
    assert.equal(ops.body.code, 'ACCOUNT_DISABLED');
    const code = await request(server).post('/api/ops/auth/code').set('Authorization', walletJwt).send({ code_challenge: 'a'.repeat(43) });
    assert.equal(code.status, 403);

    // The first set of rows really was deleted by the disable.
    assert.equal(prisma.store.mcpToken.some((t) => t.tokenHash === sha256(access.mcp)), false);

    // Re-enable: the unexpired wallet JWT works again, and so does the SSO session principal.
    assert.equal((await enable(member.id, { reason: 'cleared after review' })).status, 200);
    const back = await request(server).get('/api/developer/sso/clients').set('Authorization', walletJwt);
    assert.equal(back.status, 200);
    const consentBack = await request(server).get('/api/oauth/requests/missing-request').set('Authorization', `Bearer ${session}`);
    assert.notEqual(consentBack.status, 401);
    assert.ok(await readPartnerMe(again.partner));

    // ...but not as staff: the ops session and the wallet JWT issued before the re-enable stay
    // refused on the ops routes. A new sign-in works.
    const oldOps = await request(server).get('/api/ops/auth/me').set('Authorization', opsSession);
    assert.equal(oldOps.status, 401);
    assert.equal(oldOps.body.code, 'OPS_SESSION_INVALID');
    const oldCode = await request(server).post('/api/ops/auth/code').set('Authorization', walletJwt).send({ code_challenge: 'a'.repeat(43) });
    assert.equal(oldCode.status, 401);
    assert.equal(oldCode.body.code, 'SESSION_REVOKED');
    assert.equal(prisma.store.opsSignInCode.length, 0);
    const fresh = await request(server).get('/api/ops/auth/me').set('Authorization', bearer(tokens.ops(member)));
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const freshCode = await request(server).post('/api/ops/auth/code').set('Authorization', bearer(tokens.wallet(member))).send({ code_challenge: 'a'.repeat(43) });
    assert.equal(freshCode.status, 200, JSON.stringify(freshCode.body));
  });
});
