/**
 * One-time campaign grants happen once under concurrency, on REAL Postgres (`npm run test:db`;
 * needs TEST_DATABASE_URL pointing at a throwaway, migrated database whose name contains "test").
 *
 * Point has no unique key, so "already granted?" must be decided where only one caller can decide
 * it at a time. What only the database can prove: twenty calls arriving together for the same
 * first-action bonus (or referral boost) write exactly one Point row per user and one increment.
 * The fixture campaigns run in 2099 and the calls pass that date as `now`, so no other test (or
 * real request) sees them. Fixture rows use a per-run id prefix and are deleted afterwards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const src = (rel) => path.join(__dirname, '../../src', rel);
const prisma = require(src('utils/prisma.js'));
const { awardFirstActionBonus, awardReferralBoost } = require(src('services/campaignEffects.js'));
const { POINT_SOURCE_FIRST_ACTION, POINT_SOURCE_REFERRAL_BOOST } = require(src('utils/campaignRules.js'));
const { findDuplicateGrants } = require('../../scripts/reportDuplicateCampaignGrants');

const RUN = `cg${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const PARALLEL = 20;
const NOW = new Date('2099-06-15T12:00:00Z');
const USERS = ['first', 'inviter', 'invitee', 'legacy'];

async function user(name) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "User"(id, email, "referralCode", "updatedAt") VALUES ($1, $2, $3, now())',
    id(name), `${id(name)}@example.test`, id(name).toUpperCase(),
  );
}
async function campaign(name, template, config) {
  return prisma.campaign.create({
    data: {
      id: id(name),
      slug: id(name),
      internalName: id(name),
      titleEn: 'Test',
      titleZh: 'Test',
      blurbEn: 'Test',
      blurbZh: 'Test',
      template,
      status: 'LIVE',
      startsAt: new Date('2099-06-01T00:00:00Z'),
      endsAt: new Date('2099-07-01T00:00:00Z'),
      ctaKind: 'ROUTE',
      ctaValue: '/',
      config,
      createdBy: 'dbtest',
      updatedBy: 'dbtest',
    },
  });
}
const pointsOf = (name, source) => prisma.point.findMany({ where: { userId: id(name), source } });
const total = async (name) => Number((await prisma.user.findUnique({ where: { id: id(name) }, select: { totalPoints: true } })).totalPoints);

describe('one-time campaign grants happen once under concurrency (Postgres)', () => {
  let firstAction;
  let referralBoost;

  before(async () => {
    for (const name of USERS) await user(name);
    firstAction = await campaign('first-action', 'FIRST_ACTION_BONUS', { action: 'first_distillation', points: 50 });
    referralBoost = await campaign('referral-boost', 'REFERRAL_BOOST', { extraInviterPoints: 30, extraInviteePoints: 20 });
  });

  after(async () => {
    const ids = USERS.map(id);
    await prisma.point.deleteMany({ where: { userId: { in: ids } } });
    await prisma.campaign.deleteMany({ where: { id: { in: [id('first-action'), id('referral-boost')] } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it(`${PARALLEL} concurrent first-action calls grant the bonus exactly once`, async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => awardFirstActionBonus(id('first'), 'first_distillation', NOW)),
    );
    assert.equal(results.filter((r) => r.skipped === false).length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.reason === 'already_processed').length, PARALLEL - 1);

    const rows = await pointsOf('first', POINT_SOURCE_FIRST_ACTION);
    assert.deepEqual(rows.map((p) => [Number(p.amount), p.sourceId]), [[50, `first_distillation:${firstAction.id}`]]);
    assert.equal(await total('first'), 50);
  });

  it('a later call is a no-op', async () => {
    assert.deepEqual(await awardFirstActionBonus(id('first'), 'first_distillation', NOW), { skipped: true, reason: 'already_processed' });
    assert.equal(await total('first'), 50);
  });

  it(`${PARALLEL} concurrent referral-boost calls reward each side exactly once`, async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => awardReferralBoost(id('inviter'), id('invitee'), NOW)),
    );
    assert.equal(results.filter((r) => r.skipped === false).length, 1, JSON.stringify(results));

    const inviter = await pointsOf('inviter', POINT_SOURCE_REFERRAL_BOOST);
    const invitee = await pointsOf('invitee', POINT_SOURCE_REFERRAL_BOOST);
    assert.deepEqual(inviter.map((p) => [Number(p.amount), p.sourceId]), [[30, `${referralBoost.id}:${id('invitee')}`]]);
    assert.deepEqual(invitee.map((p) => [Number(p.amount), p.sourceId]), [[20, `${referralBoost.id}:${id('inviter')}`]]);
    assert.equal(await total('inviter'), 30);
    assert.equal(await total('invitee'), 20);
  });

  it('the duplicate-grant report lists grants written twice before, and changes nothing', async () => {
    const sourceId = `first_distillation:${firstAction.id}`;
    for (let i = 0; i < 2; i += 1) {
      await prisma.point.create({ data: { userId: id('legacy'), amount: 50, source: POINT_SOURCE_FIRST_ACTION, sourceId } });
    }
    const mine = (await findDuplicateGrants()).filter((g) => USERS.map(id).includes(g.userId));
    assert.deepEqual(
      mine.map((g) => [g.userId, g.source, g.sourceId, g.rows, g.totalAmount]),
      [[id('legacy'), POINT_SOURCE_FIRST_ACTION, sourceId, 2, 100]],
    );
    assert.equal((await pointsOf('legacy', POINT_SOURCE_FIRST_ACTION)).length, 2);
  });
});
