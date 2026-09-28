/**
 * The partner referral bind (POST /partner/tge/referral/bind, decision 30 A) on REAL Postgres
 * (`npm run test:db`; needs TEST_DATABASE_URL pointing at a throwaway, migrated database whose
 * name contains "test").
 *
 * What only the database can prove: the partner path resolves a real code (case-insensitively)
 * and reaches the late-bind transaction; the unique inviteeId turns a lost race for the same user
 * into `already` / `already_referred` instead of a 500 or a second row; and two partner binds racing
 * to close a ring (A binds B's code while B binds A's) cannot both commit — the global late-bind
 * advisory lock shared with /api/referrals/use-code. Fixture rows use a per-run id prefix and are
 * deleted afterwards; no reward is paid (nobody has uploaded).
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
const { bindReferralForPartner } = require('../../src/services/partnerReferralBind');

const RUN = `pb${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
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
async function inviteesOf(name) {
  return prisma.referral.findMany({ where: { inviteeId: id(name) }, select: { inviterId: true } });
}
const bind = (invitee, inviter, { lower = false } = {}) =>
  bindReferralForPartner(id(invitee), lower ? codeOf(inviter).toLowerCase() : codeOf(inviter));

describe('partner referral bind on Postgres', () => {
  before(async () => {
    const names = ['u', 'inv', 'other', 'k', 'd1', 'd2', 'same', 'two', 'ta', 'tb'];
    for (let i = 0; i < 5; i += 1) names.push(`s${i}`, `t${i}`);
    for (const n of names) await user(n);
    await edge('k', 'd1'); await edge('d1', 'd2'); // k → d1 → d2
  });

  after(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "Referral" WHERE id LIKE $1 OR "inviteeId" LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
  });

  it('binds through the real code lookup (case-insensitive), then answers already / already_referred', async () => {
    const first = await bind('u', 'inv', { lower: true });
    assert.deepEqual({ status: first.status, body: first.body }, { status: 200, body: { bound: true, inviter_sub: id('inv') } });
    const again = await bind('u', 'inv');
    assert.deepEqual(again.body, { bound: true, inviter_sub: id('inv'), already: true });
    const other = await bind('u', 'other');
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'already_referred');
    assert.deepEqual(await inviteesOf('u'), [{ inviterId: id('inv') }]);
  });

  it('refuses a downline code (referral_cycle) and an unknown code (invalid_code), writing nothing', async () => {
    assert.equal((await bind('k', 'd2')).body.error, 'referral_cycle');
    assert.equal((await bindReferralForPartner(id('k'), 'QQQQQQQQ')).body.error, 'invalid_code');
    assert.deepEqual(await inviteesOf('k'), []);
  });

  it('two users binding each other through the partner at the same moment: exactly one commits', async () => {
    for (let i = 0; i < 5; i += 1) {
      const [s, t] = [`s${i}`, `t${i}`];
      const results = await Promise.all([bind(s, t), bind(t, s)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], `pair ${i}`);
      assert.equal(results.find((r) => r.status === 409).body.error, 'referral_cycle');
      const rows = [...(await inviteesOf(s)), ...(await inviteesOf(t))];
      assert.equal(rows.length, 1, `pair ${i} formed a ring`);
    }
  });

  it('one user, the same code twice at once: one bound, one already — one row', async () => {
    const results = await Promise.all([bind('same', 'inv'), bind('same', 'inv')]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(results.map((r) => Boolean(r.body.already)).sort(), [false, true]);
    assert.equal((await inviteesOf('same')).length, 1);
  });

  it('one user, two different codes at once: one inviter wins, the other is already_referred', async () => {
    const results = await Promise.all([bind('two', 'ta'), bind('two', 'tb')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409).body.error, 'already_referred');
    const rows = await inviteesOf('two');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].inviterId, results.find((r) => r.status === 200).body.inviter_sub);
  });
});
