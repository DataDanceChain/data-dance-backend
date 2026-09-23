/**
 * G14 read-only guard and raw SQL.
 *
 * The real Prisma client routes `$queryRaw` through `$use` middleware as action `queryRaw` (model
 * undefined). The guard allows only find-, count, aggregate and groupBy inside a read-only scope, so every
 * raw read was refused — which is right for arbitrary SQL (a CTE can hide a DELETE), and was the 500
 * the referral-network endpoint answered on the real stack while the mock-Prisma unit tests passed.
 * The exception is explicit and narrow: `runVettedRawRead(label, fn)` marks a scope in which
 * `queryRaw` — and nothing else — is allowed; it is used only by src/services/referralNetwork.js for
 * its fixed, parameterised SELECT CTEs. `$executeRaw` and model writes stay refused.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { installReadOnlyGuard, runReadOnly, runVettedRawRead } = require('../../src/utils/prismaReadOnly');

/** A client shaped like Prisma 5: `$use` middleware in front of every operation. */
function fakeClient() {
  const middlewares = [];
  const run = (params, finalResult) => {
    const chain = [...middlewares];
    const next = (p) => (chain.length ? chain.shift()(p, next) : Promise.resolve(finalResult));
    return next(params);
  };
  return {
    $use: (fn) => middlewares.push(fn),
    $queryRaw: (..._args) => run({ action: 'queryRaw', model: undefined }, [{ ok: 1 }]),
    $executeRaw: (..._args) => run({ action: 'executeRaw', model: undefined }, 1),
    user: {
      findUnique: () => run({ action: 'findUnique', model: 'User' }, { id: 'u1' }),
      update: () => run({ action: 'update', model: 'User' }, { id: 'u1' }),
    },
  };
}

const refused = (p) => assert.rejects(p, (e) => e.code === 'READ_ONLY_VIOLATION');

describe('read-only guard and raw SQL', () => {
  it('outside a read-only scope nothing is restricted', async () => {
    const c = installReadOnlyGuard(fakeClient());
    assert.deepEqual(await c.$queryRaw`SELECT 1`, [{ ok: 1 }]);
  });

  it('inside a read-only scope an unvetted $queryRaw is refused', async () => {
    const c = installReadOnlyGuard(fakeClient());
    await refused(runReadOnly('unit', () => c.$queryRaw`SELECT 1`));
  });

  it('a vetted raw read is allowed inside the read-only scope', async () => {
    const c = installReadOnlyGuard(fakeClient());
    const rows = await runReadOnly('unit', () => runVettedRawRead('referralNetwork.test', () => c.$queryRaw`SELECT 1`));
    assert.deepEqual(rows, [{ ok: 1 }]);
    assert.deepEqual(await runReadOnly('unit', () => runVettedRawRead('x', () => c.user.findUnique())), { id: 'u1' });
  });

  it('the vetted scope still refuses writes: $executeRaw and model writes', async () => {
    const c = installReadOnlyGuard(fakeClient());
    await refused(runReadOnly('unit', () => runVettedRawRead('x', () => c.$executeRaw`DELETE FROM "User"`)));
    await refused(runReadOnly('unit', () => runVettedRawRead('x', () => c.user.update())));
  });

  it('the vetting ends with its callback', async () => {
    const c = installReadOnlyGuard(fakeClient());
    await runReadOnly('unit', async () => {
      await runVettedRawRead('x', () => c.$queryRaw`SELECT 1`);
      await refused(c.$queryRaw`SELECT 1`);
    });
  });
});
