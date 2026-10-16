/**
 * Role grants (admin issue #2): GET /api/ops/roles, POST /users/:userId/roles and
 * POST /users/:userId/roles/:role/revoke, plus scripts/opsRoles.js, which uses the same rules.
 * Through the REAL application on the in-memory Prisma stand-in (transactions roll back).
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, settle, recordLabel } = require('../helpers/opsApp');

const { prisma, app } = installOpsApp();
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const script = require('../../scripts/opsRoles');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

let admin;
let adminAuth;
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  admin = await seedUser(prisma, { email: 'admin@example.test' });
  await grant(prisma, admin.id, 'ddc_admin');
  adminAuth = bearer(tokens.ops(admin));
});

const grantRole = (userId, body, auth = adminAuth) =>
  request(server).post(`/api/ops/users/${userId}/roles`).set('Authorization', auth).send(body);
const revokeRole = (userId, role, body, auth = adminAuth) =>
  request(server).post(`/api/ops/users/${userId}/roles/${role}/revoke`).set('Authorization', auth).send(body);
const grantsOf = (userId) => prisma.store.userRoleGrant.filter((row) => row.userId === userId).map((row) => row.role).sort();
const auditRows = (action) => prisma.store.opsAuditLog.filter((row) => !action || row.action === action);

describe('grant', () => {
  it('grants a role and writes role.grant in the same change', async () => {
    const user = await seedUser(prisma, { email: 'tge@example.test' });
    const res = await grantRole(user.id, { role: 'developer', reason: 'TGE partner integration' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.grant.userId, user.id);
    assert.equal(res.body.data.grant.role, 'developer');
    assert.equal(res.body.data.grant.grantedBy, recordLabel(admin.id), 'the record label, never the e-mail');
    assert.equal(res.body.data.grant.reason, 'TGE partner integration');
    assert.deepEqual(grantsOf(user.id), ['developer']);
    const row = prisma.store.userRoleGrant.find((r) => r.userId === user.id);
    assert.equal(row.grantedByUserId, admin.id);

    await settle();
    const rows = auditRows();
    assert.equal(rows.length, 1, 'one row: the endpoint wrote its own, so no generic ops.write row');
    assert.equal(rows[0].action, 'role.grant');
    assert.equal(rows[0].actorUserId, admin.id);
    assert.equal(rows[0].actorLabel, 'admin@example.test');
    assert.equal(rows[0].actorRole, 'ddc_admin');
    assert.equal(rows[0].targetType, 'user');
    assert.equal(rows[0].targetId, user.id);
    assert.equal(rows[0].targetLabel, 'tge@example.test');
    assert.equal(rows[0].reason, 'TGE partner integration');
    assert.deepEqual(rows[0].detail, { role: 'developer' });
    assert.ok(rows[0].requestId, 'the request id is recorded');
  });

  it('refuses an unknown role, a missing or short reason, an unknown account', async () => {
    const user = await seedUser(prisma);
    const bad = await grantRole(user.id, { role: 'superuser', reason: 'because I can' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_ROLE');
    for (const reason of [undefined, '', '  ', 'ok', 'x'.repeat(201)]) {
      const res = await grantRole(user.id, { role: 'operator', reason });
      assert.equal(res.status, 400, String(reason));
      assert.equal(res.body.code, 'REASON_REQUIRED');
    }
    const missing = await grantRole('no-such-user', { role: 'operator', reason: 'new operator' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'USER_NOT_FOUND');
    assert.deepEqual(grantsOf(user.id), []);
    assert.equal(auditRows().length, 0);
  });

  it('refuses a role already held (409 ALREADY_GRANTED), a disabled account and an organization', async () => {
    const user = await seedUser(prisma);
    await grant(prisma, user.id, 'operator');
    const twice = await grantRole(user.id, { role: 'operator', reason: 'second time' });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'ALREADY_GRANTED');

    const disabled = await seedUser(prisma, { disabledAt: new Date() });
    const d = await grantRole(disabled.id, { role: 'operator', reason: 'new operator' });
    assert.equal(d.status, 409);
    assert.equal(d.body.code, 'ACCOUNT_DISABLED');

    const org = await seedUser(prisma, { isOrganization: true, userType: 'organization' });
    const o = await grantRole(org.id, { role: 'developer', reason: 'merchant dev' });
    assert.equal(o.status, 409);
    assert.equal(o.body.code, 'ORG_NOT_ALLOWED');
    assert.deepEqual(grantsOf(disabled.id), []);
    assert.deepEqual(grantsOf(org.id), []);
  });

  it('a failed audit write leaves no grant', async () => {
    const user = await seedUser(prisma);
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw new Error('audit store down'); };
    try {
      const res = await grantRole(user.id, { role: 'operator', reason: 'new operator' });
      assert.equal(res.status, 500);
    } finally {
      prisma.opsAuditLog.create = original;
    }
    assert.deepEqual(grantsOf(user.id), []);
  });
});

describe('revoke', () => {
  it('revokes a role and writes role.revoke with what the grant was', async () => {
    const user = await seedUser(prisma);
    await grant(prisma, user.id, 'operator', { grantedBy: 'second-admin@example.test', grantedAt: new Date('2026-10-02T00:00:00Z') });
    const res = await revokeRole(user.id, 'operator', { reason: 'left the ops team' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { revoked: { userId: user.id, role: 'operator' } });
    assert.deepEqual(grantsOf(user.id), []);
    const [row] = auditRows('role.revoke');
    assert.equal(row.reason, 'left the ops team');
    assert.deepEqual(row.detail, { role: 'operator', grantedAt: '2026-10-02T00:00:00.000Z', grantedBy: 'second-admin@example.test' });
  });

  it('refuses a role the account does not hold (404 NOT_GRANTED) and needs a reason', async () => {
    const user = await seedUser(prisma);
    const res = await revokeRole(user.id, 'operator', { reason: 'not there' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_GRANTED');
    await grant(prisma, user.id, 'operator');
    const noReason = await revokeRole(user.id, 'operator', {});
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'REASON_REQUIRED');
    assert.deepEqual(grantsOf(user.id), ['operator']);
  });

  it('refuses your own ddc_admin (409 SELF_CHANGE)', async () => {
    const other = await seedUser(prisma);
    await grant(prisma, other.id, 'ddc_admin');
    const res = await revokeRole(admin.id, 'ddc_admin', { reason: 'stepping down' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SELF_CHANGE');
    assert.deepEqual(grantsOf(admin.id), ['ddc_admin']);
  });

  it('refuses to leave no enabled ddc_admin (409 LAST_ADMIN); a disabled admin does not count', async () => {
    const secondAdmin = await seedUser(prisma);
    await grant(prisma, secondAdmin.id, 'ddc_admin');
    const former = await seedUser(prisma, { disabledAt: new Date() });
    await grant(prisma, former.id, 'ddc_admin');

    // admin revokes secondAdmin: admin remains, so this is allowed.
    const first = await revokeRole(secondAdmin.id, 'ddc_admin', { reason: 'rotation test' });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // Through the script (no SELF_CHANGE there): admin is now the only enabled ddc_admin.
    const logs = [];
    const code = await script.main(['revoke', '--email', admin.email, '--role', 'ddc_admin', '--reason', 'last one', '--apply'], {
      db: prisma, log: (line) => logs.push(line), logError: (line) => logs.push(line),
    });
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /LAST_ADMIN/);
    assert.deepEqual(grantsOf(admin.id), ['ddc_admin']);

    // Revoking the disabled admin's grant is fine: it never counted.
    const third = await revokeRole(former.id, 'ddc_admin', { reason: 'clean up' });
    assert.equal(third.status, 200);
  });

  it('LAST_ADMIN holds when the target is re-enabled between its first read and the lock', async () => {
    const { revokeRole: revoke } = require('../../src/services/userRoles');
    const { enableAccount } = require('../../src/services/opsAccounts');
    const { SCRIPT_ACTOR } = require('../../src/services/opsAudit');
    // admin (A) is an enabled ddc_admin; former (B) is a disabled one.
    const former = await seedUser(prisma, { disabledAt: new Date(), disabledBy: 'script', disabledReason: 'on leave' });
    await grant(prisma, former.id, 'ddc_admin');

    // A real database hands back a fresh object per read (the in-memory stand-in hands back the
    // stored row, which would follow later changes). revoke(B) is held after its first read.
    let arrived;
    const atTransaction = new Promise((resolve) => { arrived = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const db = {
      ...prisma,
      user: {
        ...prisma.user,
        findUnique: async (args) => {
          const row = await prisma.user.findUnique(args);
          return row && structuredClone(row);
        },
      },
      $transaction: async (fn) => {
        arrived();
        await gate;
        return prisma.$transaction(fn);
      },
    };
    const asScript = { actor: SCRIPT_ACTOR, surface: 'script' };
    const slow = revoke({ userId: former.id, role: 'ddc_admin', reason: 'clean up', ...asScript }, db);
    slow.catch(() => {});
    await atTransaction;

    // Meanwhile B is re-enabled (under the admin lock) and A's grant goes: B is now the other admin.
    const statements = prisma.rawStatements.length;
    await enableAccount({ userId: former.id, reason: 'back from leave', ...asScript });
    assert.ok(
      prisma.rawStatements.slice(statements).some((row) => /pg_advisory_xact_lock/.test(row.sql)),
      're-enable runs under the admin lock',
    );
    await revoke({ userId: admin.id, role: 'ddc_admin', reason: 'rotation test', ...asScript });

    // revoke(B) resumes: under the lock it reads B as enabled now, and B is the last admin.
    release();
    await assert.rejects(slow, (error) => error.code === 'LAST_ADMIN' && error.status === 409);
    assert.deepEqual(grantsOf(former.id), ['ddc_admin']);
    const enabledAdmins = prisma.store.userRoleGrant.filter(
      (row) => row.role === 'ddc_admin' && !prisma.store.user.find((u) => u.id === row.userId).disabledAt,
    );
    assert.equal(enabledAdmins.length, 1, 'one enabled ddc_admin remains');
  });

  it('a failed audit write leaves the grant in place', async () => {
    const user = await seedUser(prisma);
    await grant(prisma, user.id, 'operator');
    const original = prisma.opsAuditLog.create;
    prisma.opsAuditLog.create = async () => { throw new Error('audit store down'); };
    try {
      const res = await revokeRole(user.id, 'operator', { reason: 'left the ops team' });
      assert.equal(res.status, 500);
    } finally {
      prisma.opsAuditLog.create = original;
    }
    assert.deepEqual(grantsOf(user.id), ['operator']);
  });
});

describe('GET /api/ops/roles', () => {
  it('lists the active grants with the account, filtered by role', async () => {
    const disabled = await seedUser(prisma, { email: 'gone@example.test', disabledAt: new Date('2026-10-05T00:00:00Z') });
    await grant(prisma, disabled.id, 'developer');
    const all = await request(server).get('/api/ops/roles').set('Authorization', adminAuth);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.data.items.map((i) => [i.role, i.email]).sort(), [['ddc_admin', 'admin@example.test'], ['developer', 'gone@example.test']]);
    const dev = await request(server).get('/api/ops/roles?role=developer').set('Authorization', adminAuth);
    assert.equal(dev.body.data.items.length, 1);
    assert.equal(dev.body.data.items[0].disabledAt, '2026-10-05T00:00:00.000Z');
    const operators = await request(server).get('/api/ops/roles?role=operator').set('Authorization', adminAuth);
    assert.deepEqual(operators.body.data.items, [], 'no operators yet');
    const bad = await request(server).get('/api/ops/roles?role=root').set('Authorization', adminAuth);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_ROLE');
  });
});

describe('scripts/opsRoles.js', () => {
  const run = async (argv) => {
    const lines = [];
    const code = await script.main(argv, { db: prisma, log: (l) => lines.push(l), logError: (l) => lines.push(l) });
    return { code, out: lines.join('\n') };
  };

  it('is a dry run unless --apply: nothing written', async () => {
    const secondAdmin = await seedUser(prisma, { email: 'Second-Admin@Example.test' });
    const { code, out } = await run(['grant', '--email', 'second-admin@example.test', '--role', 'ddc_admin', '--reason', 'founding admin']);
    assert.equal(code, 0);
    assert.match(out, /DRY RUN grant ddc_admin .* would grant/);
    assert.deepEqual(grantsOf(secondAdmin.id), []);
    assert.equal(auditRows().length, 0);
  });

  it('--apply grants and writes a system audit row on the script surface', async () => {
    const secondAdmin = await seedUser(prisma, { email: 'second-admin@example.test' });
    const { code } = await run(['grant', '--email', 'second-admin@example.test', '--role', 'ddc_admin', '--reason', 'founding admin', '--apply']);
    assert.equal(code, 0);
    assert.deepEqual(grantsOf(secondAdmin.id), ['ddc_admin']);
    const row = prisma.store.userRoleGrant.find((r) => r.userId === secondAdmin.id);
    assert.equal(row.grantedBy, 'script');
    assert.equal(row.grantedByUserId, null);
    const [audit] = auditRows('role.grant');
    assert.equal(audit.actorKind, 'system');
    assert.equal(audit.actorLabel, 'script');
    assert.equal(audit.surface, 'script');

    const listed = await run(['list']);
    assert.match(listed.out, /ddc_admin\tsecond-admin@example\.test/);
  });

  it('refuses bad arguments and unknown accounts', async () => {
    assert.equal((await run([])).code, 2);
    assert.equal((await run(['grant', '--email', 'a@example.test', '--role', 'root', '--reason', 'xyz'])).code, 2);
    assert.equal((await run(['grant', '--email', 'a@example.test', '--role', 'operator'])).code, 2);
    const missing = await run(['grant', '--email', 'nobody@example.test', '--role', 'operator', '--reason', 'new operator', '--apply']);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /No account uses/);
  });
});
