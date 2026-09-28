/**
 * Late-bind referral cycle check on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing
 * at a throwaway, migrated database whose name contains "test").
 *
 * Decision 11 B (Sloan, 2026-09-26): a registered user who binds an inviter later must not close a
 * ring. What only the database can prove: the advisory lock statement runs inside Prisma's
 * interactive transaction, a ring already in the data does not hang the walk, the real referral-code
 * lookup in useReferralCode reaches the check, and two binds racing to close a ring cannot both
 * commit (the 2-ring A↔B, and a 4-ring closed by two binds that share no user). Fixture rows use a
 * per-run id prefix and are deleted afterwards; no reward is paid (nobody has uploaded).
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
const referralService = require('../../src/services/referralService');

const RUN = `cy${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
// Display codes are six characters; derive a unique one per fixture user.
const codeOf = (name) => crypto.createHash('sha256').update(id(name)).digest('hex').slice(0, 6).toUpperCase();

async function user(name) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "User"(id, email, "referralCode", "updatedAt") VALUES ($1, $2, $3, now())',
    id(name), `${id(name)}@example.test`, codeOf(name),
  );
}
async function edge(inviter, invitee) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "Referral"(id, "inviterId", "inviteeId", code, "updatedAt") VALUES ($1, $2, $3, $4, now())',
    id(`e-${inviter}-${invitee}`), id(inviter), id(invitee), codeOf(inviter),
  );
}
async function inviterOf(name) {
  const row = await prisma.referral.findUnique({ where: { inviteeId: id(name) }, select: { inviterId: true } });
  return row ? row.inviterId : null;
}
const bind = (invitee, inviter) =>
  referralService.createLateBindReferral({ inviteeId: id(invitee), inviterId: id(inviter), code: codeOf(inviter) });

describe('late-bind referral cycle check on Postgres', () => {
  before(async () => {
    const names = ['a', 'b', 'c', 'x', 'p', 'q', 'r', 'z', 'm', 'n'];
    for (let i = 0; i < 5; i += 1) names.push(`s${i}`, `t${i}`);
    names.push('ra', 'rb', 'rx', 'ry');
    for (const n of names) await user(n);
    await edge('a', 'b'); await edge('b', 'c'); // chain a→b→c
    await edge('p', 'q'); await edge('q', 'r'); await edge('r', 'p'); // ring p→q→r→p already in data
    await edge('ra', 'rb'); await edge('ry', 'rx'); // for the disjoint 4-ring race
  });

  after(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "Referral" WHERE id LIKE $1 OR "inviteeId" LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
  });

  it('refuses the 2-ring and the 3-ring inside the real transaction, writing nothing', async () => {
    await assert.rejects(bind('a', 'b'), { code: 'REFERRAL_CYCLE' });
    await assert.rejects(bind('a', 'c'), { code: 'REFERRAL_CYCLE' });
    assert.equal(await inviterOf('a'), null);
  });

  it('a ring already in the data does not hang the walk and does not block a bind below it', async () => {
    const walk = await referralService.findReferralCycle(id('z'), id('q'));
    assert.deepEqual({ cycle: walk.cycle, reason: walk.reason }, { cycle: false, reason: 'existing_ring' });
    await bind('z', 'q');
    assert.equal(await inviterOf('z'), id('q'));
  });

  it('useReferralCode resolves the real code and refuses the cycle', async () => {
    await assert.rejects(referralService.useReferralCode(id('a'), codeOf('c')), { code: 'REFERRAL_CYCLE' });
    const ok = await referralService.useReferralCode(id('x'), codeOf('c'));
    assert.equal(ok.inviterId, id('c'));
    assert.equal(await inviterOf('x'), id('c'));
  });

  it('two users binding each other at the same moment: exactly one bind commits', async () => {
    for (let i = 0; i < 5; i += 1) {
      const [s, t] = [`s${i}`, `t${i}`];
      const results = await Promise.allSettled([bind(s, t), bind(t, s)]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1, `pair ${i}: ${results.map((r) => r.status).join(',')}`);
      assert.equal(refused[0].reason.code, 'REFERRAL_CYCLE');
      const links = [await inviterOf(s), await inviterOf(t)].filter(Boolean);
      assert.equal(links.length, 1, `pair ${i} formed a ring`);
    }
  });

  it('two binds sharing no user cannot close a 4-ring together (ra→rb, ry→rx; ra binds rx, ry binds rb)', async () => {
    const results = await Promise.allSettled([bind('ra', 'rx'), bind('ry', 'rb')]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'REFERRAL_CYCLE');
  });
});
