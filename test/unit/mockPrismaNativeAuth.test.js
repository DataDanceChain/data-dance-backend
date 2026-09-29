/**
 * test/helpers/mockPrisma.js knows the native-login models the way Postgres does: every model
 * of migration 20260930090000_native_auth_identity exists, its unique keys reject duplicates with
 * a P2002-shaped error (the /complete race paths depend on it), and its column defaults match
 * the schema. The legacy models keep their permissive behaviour unless a test opts in.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createMockPrisma } = require('../helpers/mockPrisma');

const NATIVE_MODELS = ['AuthIdentity', 'NativeWalletBinding', 'AuthLoginAttempt', 'AuthEmailChallenge', 'AuthFlowState', 'WalletAddressHistory'];
const lowerFirst = (name) => name[0].toLowerCase() + name.slice(1);

async function rejectsP2002(promise, target) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'P2002');
    assert.deepEqual(err.meta.target, target);
    return true;
  });
}

describe('mockPrisma: native-login models', () => {
  it('has a model for every native-login table in prisma/schema.prisma', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const prisma = createMockPrisma();
    for (const model of NATIVE_MODELS) {
      assert.match(schema, new RegExp(`^model ${model} \\{`, 'm'), `${model} missing from the schema`);
      assert.equal(typeof prisma[lowerFirst(model)]?.create, 'function', `mockPrisma.${lowerFirst(model)} missing`);
    }
  });

  it('AuthIdentity (provider, subject) is unique; NULL e-mails never collide', async () => {
    const prisma = createMockPrisma();
    await prisma.authIdentity.create({ data: { userId: 'u1', provider: 'google', subject: 's1', linkedVia: 'created' } });
    await rejectsP2002(
      prisma.authIdentity.create({ data: { userId: 'u2', provider: 'google', subject: 's1', linkedVia: 'created' } }),
      ['provider', 'subject'],
    );
    const other = await prisma.authIdentity.create({ data: { userId: 'u2', provider: 'apple', subject: 's1', linkedVia: 'created' } });
    assert.equal(other.email, null);
    assert.equal(other.emailLinkGrade, 'none');
    assert.equal(other.isPrivateRelay, false);
  });

  it('NativeWalletBinding: one per user, subject unique, update into a clash is refused', async () => {
    const prisma = createMockPrisma();
    const a = await prisma.nativeWalletBinding.create({ data: { userId: 'u1', connection: 'c', network: 'n', subject: 'w1', address: '0x1' } });
    assert.ok(a.boundAt instanceof Date);
    await rejectsP2002(prisma.nativeWalletBinding.create({ data: { userId: 'u1', connection: 'c', network: 'n', subject: 'w2', address: '0x2' } }), ['userId']);
    await rejectsP2002(prisma.nativeWalletBinding.create({ data: { userId: 'u2', connection: 'c', network: 'n', subject: 'w1', address: '0x2' } }), ['subject']);
    const b = await prisma.nativeWalletBinding.create({ data: { userId: 'u2', connection: 'c', network: 'n', subject: 'w2', address: '0x2' } });
    await rejectsP2002(prisma.nativeWalletBinding.update({ where: { id: b.id }, data: { subject: 'w1' } }), ['subject']);
    assert.equal(prisma.nativeWalletBinding.rows.find((r) => r.id === b.id).subject, 'w2', 'a refused update writes nothing');
  });

  it('AuthLoginAttempt: explicit id (the loginId) kept, defaults filled, claim by updateMany counts once', async () => {
    const prisma = createMockPrisma();
    const expiresAt = new Date(Date.now() + 60_000);
    const row = await prisma.authLoginAttempt.create({
      data: { id: 'login-1', loginSecretHash: 'h', intent: 'login', method: 'email', provider: 'email', subject: 'a@x.io', resolution: 'existing', expiresAt },
    });
    assert.equal(row.id, 'login-1');
    assert.equal(row.state, 'identified');
    assert.equal(row.w3aTokenCount, 0);
    assert.equal(row.walletProof, null);
    await rejectsP2002(prisma.authLoginAttempt.create({ data: { ...row } }), ['id']);
    const where = { id: 'login-1', state: 'identified', expiresAt: { gt: new Date() } };
    assert.equal((await prisma.authLoginAttempt.updateMany({ where, data: { state: 'completing' } })).count, 1);
    assert.equal((await prisma.authLoginAttempt.updateMany({ where, data: { state: 'completing' } })).count, 0);
    await prisma.authLoginAttempt.updateMany({ where: { id: 'login-1' }, data: { w3aTokenCount: { increment: 1 } } });
    assert.equal(prisma.authLoginAttempt.rows[0].w3aTokenCount, 1);
  });

  it('AuthFlowState valueHash is unique when set, NULL allowed many times', async () => {
    const prisma = createMockPrisma();
    const expiresAt = new Date(Date.now() + 60_000);
    await prisma.authFlowState.create({ data: { kind: 'idp_nonce', valueHash: 'v', data: {}, expiresAt } });
    await rejectsP2002(prisma.authFlowState.create({ data: { kind: 'idp_nonce', valueHash: 'v', data: {}, expiresAt } }), ['valueHash']);
    await prisma.authFlowState.create({ data: { kind: 'step_up', data: {}, expiresAt } });
    await prisma.authFlowState.create({ data: { kind: 'step_up', data: {}, expiresAt } });
    assert.equal(prisma.authFlowState.rows.length, 3);
  });

  it('User keeps today\'s permissive mock unless unique enforcement is asked for', async () => {
    const loose = createMockPrisma();
    await loose.user.create({ data: { email: 'a@x.io', referralCode: 'R1' } });
    await loose.user.create({ data: { email: 'a@x.io', referralCode: 'R2' } });
    assert.equal(loose.user.rows.length, 2);

    const strict = createMockPrisma({ enforceUnique: true });
    await strict.user.create({ data: { email: 'a@x.io', referralCode: 'R1', walletAddress: null } });
    await rejectsP2002(strict.user.create({ data: { email: 'a@x.io', referralCode: 'R2' } }), ['email']);
    await strict.user.create({ data: { email: 'b@x.io', referralCode: 'R2', walletAddress: null } });
    await rejectsP2002(strict.user.create({ data: { email: 'c@x.io', referralCode: 'R1' } }), ['referralCode']);
  });

  it('$queryRaw is recorded, never run', async () => {
    const prisma = createMockPrisma();
    assert.deepEqual(await prisma.$queryRaw(['SELECT pg_advisory_xact_lock(', ')'], 42), []);
    assert.equal(prisma.rawStatements.length, 1);
  });
});
