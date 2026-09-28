/**
 * POST /partner/tge/referral/bind/check runs inside the partner API's read-only scope
 * (readOnlyRequest) and resolves the typed code through referralUtils.findUserByReferralCode,
 * a `$queryRaw` SELECT. Unvetted, the G14 guard refused it and every real /check answered 500
 * (`partner.read_only_violation`, operation queryRaw) while the mock-Prisma unit tests passed.
 * Found on the local integration stack 2026-09-28. This pins the lookup as a vetted raw read.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { installReadOnlyGuard, runReadOnly } = require('../../src/utils/prismaReadOnly');

// A client shaped like Prisma 5: `$use` middleware in front of every operation.
const middlewares = [];
const run = (params, result) => {
  const chain = [...middlewares];
  const next = (p) => (chain.length ? chain.shift()(p, next) : Promise.resolve(result));
  return next(params);
};
const fake = installReadOnlyGuard({
  $use: (fn) => middlewares.push(fn),
  // Lazy like a real PrismaPromise: nothing runs (and the guard is not consulted) until `then`.
  $queryRaw: () => ({ then: (ok, fail) => run({ action: 'queryRaw', model: undefined }, [{ id: 'owner-1', email: 'o@example.invalid', name: 'o', referralCode: 'ABC234' }]).then(ok, fail) }),
  $executeRaw: () => run({ action: 'executeRaw', model: undefined }, 1),
});
const prismaPath = path.resolve(__dirname, '../../src/utils/prisma.js');
const saved = require.cache[prismaPath];
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fake };
const referralUtilsPath = require.resolve('../../src/utils/referralUtils');
delete require.cache[referralUtilsPath];
const { findUserByReferralCode } = require('../../src/utils/referralUtils');
delete require.cache[referralUtilsPath];
if (saved) require.cache[prismaPath] = saved; else delete require.cache[prismaPath];

describe('referral code lookup inside the partner read-only scope', () => {
  it('resolves a DDC- display code without a read-only violation', async () => {
    const owner = await runReadOnly('partner.test', () => findUserByReferralCode('DDC-ABC234', { id: true, referralCode: true }));
    assert.deepEqual(owner, { id: 'owner-1', referralCode: 'ABC234' });
  });

  it('the scope still refuses a raw write', async () => {
    await assert.rejects(runReadOnly('partner.test', () => fake.$executeRaw`DELETE FROM "User"`), (e) => e.code === 'READ_ONLY_VIOLATION');
  });
});
