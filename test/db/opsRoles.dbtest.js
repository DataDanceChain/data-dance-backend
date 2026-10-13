/**
 * Operator accounts, roles and the ops audit log on REAL Postgres (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway database that `prisma migrate deploy` has built — its
 * name must contain "test").
 *
 * What only the database can prove about 20261017100000_ops_roles_audit: the tables, columns and
 * indexes exist on a migrated database; the CHECK constraints refuse values outside the closed sets;
 * deleting a user cascades to its role grants and sign-in codes, while its audit rows survive (no
 * foreign keys); the role and account services run on it, including the advisory lock that keeps
 * at least one enabled ddc_admin when two admins act at once. Fixture rows use a per-run id prefix
 * and are deleted afterwards (audit rows by their per-run labels).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const prisma = require('../../src/utils/prisma');
const { grantRole, revokeRole, activeRoles, loadUserWithRoles } = require('../../src/services/userRoles');
const { disableAccount, enableAccount } = require('../../src/services/opsAccounts');
const { writeAudit, listAudit } = require('../../src/services/opsAudit');

const RUN = `or${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const actorOf = (user) => ({ kind: 'user', userId: user.id, label: user.email, role: 'ddc_admin' });

async function user(name, extra = {}) {
  return prisma.user.create({
    data: { id: id(name), email: `${id(name)}@example.test`, name: id(name), referralCode: id(name).toUpperCase(), ...extra },
  });
}

/** The SQLSTATE of a failed raw statement (23514 = check_violation). */
async function sqlState(promise) {
  try {
    await promise;
  } catch (error) {
    const meta = error && error.meta;
    return (meta && (meta.code || meta.sqlState)) || (error && error.code) || String(error && error.message);
  }
  return 'no error';
}

after(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM "OpsAuditLog" WHERE "actorLabel" LIKE $1 OR "targetId" LIKE $1', `${RUN}%`);
  await prisma.$executeRawUnsafe('DELETE FROM "IdentityConflict" WHERE "candidateUserId" LIKE $1', `${RUN}%`);
  await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id LIKE $1', `${RUN}%`);
  await prisma.$disconnect();
});

describe('the migration on a migrated database', () => {
  it('creates the four tables and the two User columns', async () => {
    const tables = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name IN ('UserRoleGrant','OpsAuditLog','OpsSignInCode','IdentityConflict')
       ORDER BY table_name`,
    );
    assert.deepEqual(tables.map((row) => row.table_name), ['IdentityConflict', 'OpsAuditLog', 'OpsSignInCode', 'UserRoleGrant']);
    const columns = await prisma.$queryRawUnsafe(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'User' AND column_name IN ('disabledAt','disabledBy','disabledReason')
       ORDER BY column_name`,
    );
    assert.deepEqual(columns.map((row) => [row.column_name, row.is_nullable]), [['disabledAt', 'YES'], ['disabledBy', 'YES'], ['disabledReason', 'YES']]);
  });

  it('creates the indexes the lists read by', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
       AND tablename IN ('UserRoleGrant','OpsAuditLog','OpsSignInCode','IdentityConflict')`,
    );
    const names = new Set(rows.map((row) => row.indexname));
    for (const name of [
      'UserRoleGrant_pkey', 'UserRoleGrant_role_idx',
      'OpsAuditLog_createdAt_idx', 'OpsAuditLog_targetType_targetId_createdAt_idx', 'OpsAuditLog_actorUserId_createdAt_idx', 'OpsAuditLog_action_createdAt_idx',
      'OpsSignInCode_codeHash_key', 'OpsSignInCode_expiresAt_idx',
      'IdentityConflict_createdAt_idx', 'IdentityConflict_candidateUserId_createdAt_idx', 'IdentityConflict_reason_createdAt_idx',
    ]) {
      assert.ok(names.has(name), `missing index ${name}`);
    }
  });
});

describe('CHECK constraints', () => {
  let target;
  before(async () => { target = await user('check-target'); });

  it('UserRoleGrant.role is ddc_admin | operator | developer', async () => {
    const state = await sqlState(prisma.$executeRawUnsafe(
      'INSERT INTO "UserRoleGrant" ("userId","role","grantedBy","reason") VALUES ($1,$2,$3,$4)',
      target.id, 'root', 'script', 'not a role',
    ));
    assert.match(String(state), /23514|check/i);
    for (const role of ['ddc_admin', 'operator', 'developer']) {
      await prisma.$executeRawUnsafe(
        'INSERT INTO "UserRoleGrant" ("userId","role","grantedBy","reason") VALUES ($1,$2,$3,$4)',
        target.id, role, 'script', 'allowed role',
      );
    }
    assert.deepEqual(await activeRoles(target.id), ['ddc_admin', 'operator', 'developer']);
    await prisma.userRoleGrant.deleteMany({ where: { userId: target.id } });
  });

  it('OpsAuditLog.actorKind and surface are closed sets', async () => {
    const insert = (actorKind, surface) => prisma.$executeRawUnsafe(
      `INSERT INTO "OpsAuditLog" ("id","actorKind","actorLabel","actorRole","action","targetType","surface")
       VALUES ($1,$2,$3,'x','ops.write','user',$4)`,
      crypto.randomUUID(), actorKind, `${RUN}-check`, surface,
    );
    assert.match(String(await sqlState(insert('robot', 'ops'))), /23514|check/i);
    assert.match(String(await sqlState(insert('user', 'web'))), /23514|check/i);
    assert.equal(await insert('system', 'script'), 1);
  });

  it('IdentityConflict.route is network_rebind | backfill | create', async () => {
    const insert = (route) => prisma.$executeRawUnsafe(
      'INSERT INTO "IdentityConflict" ("id","reason","route","candidateUserId","verifier") VALUES ($1,$2,$3,$4,$5)',
      crypto.randomUUID(), 'test', route, `${RUN}-x`, 'v',
    );
    assert.match(String(await sqlState(insert('elsewhere'))), /23514|check/i);
    assert.equal(await insert('backfill'), 1);
  });
});

describe('deleting a user', () => {
  it('cascades to its grants and sign-in codes; its audit rows survive', async () => {
    const admin = await user('cascade-admin');
    await grantRole({ userId: admin.id, role: 'ddc_admin', reason: 'db test admin', actor: { kind: 'system', userId: null, label: `${RUN}-script`, role: 'system' }, surface: 'script' });
    const doomed = await user('cascade-doomed');
    await grantRole({ userId: doomed.id, role: 'operator', reason: 'db test operator', actor: actorOf(admin) });
    await prisma.opsSignInCode.create({
      data: { codeHash: crypto.randomBytes(32).toString('hex'), userId: doomed.id, challenge: 'c'.repeat(43), expiresAt: new Date(Date.now() + 60000) },
    });
    await writeAudit(prisma, {
      actor: actorOf(doomed), action: 'auth.sign_in', target: { type: 'user', id: doomed.id, label: doomed.email }, detail: { role: 'operator' }, surface: 'ops',
    });

    await prisma.user.delete({ where: { id: doomed.id } });

    assert.equal(await prisma.userRoleGrant.count({ where: { userId: doomed.id } }), 0);
    assert.equal(await prisma.opsSignInCode.count({ where: { userId: doomed.id } }), 0);
    const history = await listAudit({ targetType: 'user', targetId: doomed.id });
    assert.deepEqual(history.items.map((row) => row.action).sort(), ['auth.sign_in', 'role.grant']);
    const asActor = await prisma.opsAuditLog.count({ where: { actorUserId: doomed.id } });
    assert.equal(asActor, 1, 'the row the user wrote is kept too');
  });
});

describe('the services on Postgres', () => {
  it('a failed audit write inside the transaction leaves no grant', async () => {
    const admin = await user('tx-admin');
    const target = await user('tx-target');
    // An actor kind the audit log does not know: the grant row is written first, then the audit
    // write throws inside the same transaction, which Postgres rolls back.
    await assert.rejects(
      grantRole({ userId: target.id, role: 'operator', reason: 'db test operator', actor: { kind: 'robot', userId: admin.id, label: admin.email, role: 'ddc_admin' } }),
      /Unknown audit actor kind/,
    );
    assert.deepEqual(await activeRoles(target.id), []);
  });

  it('LAST_ADMIN holds when two admins disable each other at the same time', async () => {
    // Only this test's admins may count: retire any other enabled ddc_admin row for the duration.
    const others = await prisma.userRoleGrant.findMany({ where: { role: 'ddc_admin', NOT: { userId: { startsWith: `${RUN}-race` } } } });
    await prisma.userRoleGrant.deleteMany({ where: { role: 'ddc_admin', userId: { in: others.map((row) => row.userId) } } });
    try {
      const a = await user('race-a');
      const b = await user('race-b');
      const script = { kind: 'system', userId: null, label: `${RUN}-script`, role: 'system' };
      await grantRole({ userId: a.id, role: 'ddc_admin', reason: 'db test admin', actor: script, surface: 'script' });
      await grantRole({ userId: b.id, role: 'ddc_admin', reason: 'db test admin', actor: script, surface: 'script' });

      const results = await Promise.allSettled([
        disableAccount({ userId: b.id, reason: 'concurrent test', actor: actorOf(a) }),
        disableAccount({ userId: a.id, reason: 'concurrent test', actor: actorOf(b) }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1, JSON.stringify(results.map((r) => r.status)));
      assert.equal(refused.length, 1);
      assert.equal(refused[0].reason.code, 'LAST_ADMIN');
      const enabled = await prisma.user.count({ where: { id: { in: [a.id, b.id] }, disabledAt: null } });
      assert.equal(enabled, 1, 'one ddc_admin stays enabled');

      const disabledId = (await prisma.user.findFirst({ where: { id: { in: [a.id, b.id] }, disabledAt: { not: null } } })).id;
      const enabledId = disabledId === a.id ? b.id : a.id;
      const staff = await loadUserWithRoles(disabledId);
      assert.ok(staff.user.disabledAt, 'the disabled admin keeps the grant but is disabled');
      assert.deepEqual(staff.roles, ['ddc_admin']);
      await assert.rejects(
        revokeRole({ userId: enabledId, role: 'ddc_admin', reason: 'leave none', actor: script, surface: 'script' }),
        (error) => error.code === 'LAST_ADMIN',
      );
      const back = await enableAccount({ userId: disabledId, reason: 'concurrent test done', actor: { kind: 'user', userId: enabledId, label: `${RUN}-enabler`, role: 'ddc_admin' } });
      assert.equal(back.user.disabledAt, null);
    } finally {
      for (const row of others) {
        await prisma.userRoleGrant.create({ data: row }).catch(() => {});
      }
    }
  });

  it('disable deletes the account\'s MCP tokens and SSO tickets in the same change', async () => {
    const admin = await user('dis-admin');
    const member = await user('dis-member');
    await prisma.mcpToken.create({ data: { userId: member.id, tokenHash: crypto.randomBytes(32).toString('hex'), tokenPrefix: 'ddc_mcp_x', label: 'Claude' } });
    await prisma.ssoTicket.create({ data: { ticketHash: crypto.randomBytes(32).toString('hex'), userId: member.id, clientId: 'c', expiresAt: new Date(Date.now() + 60000) } });
    const result = await disableAccount({ userId: member.id, reason: 'db test disable', actor: actorOf(admin) });
    assert.ok(result.user.disabledAt);
    assert.equal(await prisma.mcpToken.count({ where: { userId: member.id } }), 0);
    assert.equal(await prisma.ssoTicket.count({ where: { userId: member.id } }), 0);
    const row = await prisma.opsAuditLog.findUnique({ where: { id: result.auditId } });
    assert.deepEqual(row.detail, { mcpTokens: 1, ssoTickets: 1 });
    await enableAccount({ userId: member.id, reason: 'db test enable', actor: actorOf(admin) });
  });
});
