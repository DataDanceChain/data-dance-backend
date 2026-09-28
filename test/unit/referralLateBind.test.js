/**
 * Late-bound referrals (Sloan, 2026-09-28: 后绑码的邀请关系方面的奖励只算绑定后的).
 *
 * A user who binds an inviter's code AFTER registering must not earn the inviter chain anything for
 * activity from before the bind (Referral.createdAt). The inviter's 150-point direct bonus, the
 * upline share of it, the referral-N task progress and the Summer Travel settlement all wait for a
 * qualifying upload made at or after the bind. Users who signed up with a code are unchanged, and
 * nothing already paid is taken back. No database: test/helpers/mockPrisma.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error' });

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
const src = (rel) => path.join(__dirname, '../../src', rel);
const stub = (rel, exportsValue) => {
  const filename = require.resolve(src(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};

// taskService drags in crawler/asset/X services; only recordTaskProgress is used by referrals.
const taskProgress = [];
stub('services/taskService.js', {
  recordTaskProgress: async (userId, taskId, amount) => taskProgress.push({ userId, taskId, amount }),
});
const boosts = [];
stub('services/campaignEffects.js', {
  awardReferralBoost: async (inviterId, inviteeId) => boosts.push({ inviterId, inviteeId }),
  syncRaffleTicketsForInviter: async () => ({ skipped: true }),
});

const STAY_RULES = {
  isActive: true,
  sites: ['airbnb', 'booking'],
  startUtc: new Date('2026-01-01T00:00:00Z'),
  endUtc: new Date('2027-01-01T00:00:00Z'),
  stayStartDate: '2026-06-01',
  stayEndDate: '2026-12-31',
  inviterPoints: 300,
  inviteePoints: 100,
};
stub('utils/stayBonus.js', {
  ...require(src('utils/stayBonus.js')),
  resolveStayBonusRules: async () => STAY_RULES,
  assertReferralCampaignUsable: async () => {},
});
// The real lookup is raw SQL; resolve codes against the mock user table instead.
stub('utils/referralUtils.js', {
  ...require(src('utils/referralUtils.js')),
  findUserByReferralCode: async (code) => {
    const row = prisma.user.rows.find((u) => u.referralCode === code);
    return row ? { id: row.id, name: row.name, referralCode: row.referralCode } : null;
  },
});

const referralService = require(src('services/referralService.js'));
const { distributeUplineRewards } = require(src('services/distributionService.js'));
const { hasCompletedFirstValidUpload } = require(src('utils/firstValidUpload.js'));
const { hasCompletedFirstValidSummerOrder } = require(src('utils/summerTravelEligibility.js'));

const HOUR = 3_600_000;
const ago = (ms) => new Date(Date.now() - ms);
const later = (ms) => new Date(Date.now() + ms);

function user(id) {
  prisma.user.rows.push({ id, name: id, email: `${id}@example.test`, referralCode: `CODE-${id}`, totalPoints: 0 });
}
function edge(inviterId, inviteeId, createdAt, campaignSlug = null) {
  prisma.referral.rows.push({ id: `r-${inviteeId}`, inviterId, inviteeId, code: `CODE-${inviterId}`, campaignSlug, createdAt });
}
let uploadSeq = 0;
function upload(userId, createdAt, extra = {}) {
  uploadSeq += 1;
  prisma.crawlerData.rows.push({ id: `cd-${uploadSeq}`, userId, source: 'amazon', payload: {}, metadata: null, createdAt, ...extra });
}
const stay = (userId, createdAt) =>
  upload(userId, createdAt, { source: 'airbnb', payload: { startDate: '2026-08-01', status: 'confirmed' } });
const pointsOf = (userId, source) => prisma.point.rows.filter((p) => p.userId === userId && (!source || p.source === source));
const direct = (inviterId) => pointsOf(inviterId, 'REFERRAL_DIRECT');

beforeEach(() => {
  prisma.reset();
  taskProgress.length = 0;
  boosts.length = 0;
  ['a', 'b', 'c'].forEach(user);
  prisma.task.rows.push(
    { id: 'referral-1', points: 100 },
    { id: 'referral-2', points: 50 },
    { id: 'referral-3', points: 20 },
    { id: 'referral-4', points: 10 },
  );
});

describe('eligibility helpers honour a bind-time cutoff', () => {
  it('hasCompletedFirstValidUpload: without `since` any upload counts; with it only uploads at or after', async () => {
    const bind = ago(HOUR);
    upload('c', ago(2 * HOUR));
    assert.equal(await hasCompletedFirstValidUpload('c'), true);
    assert.equal(await hasCompletedFirstValidUpload('c', prisma, { since: bind }), false);
    upload('c', bind); // exactly at the bind instant counts
    assert.equal(await hasCompletedFirstValidUpload('c', prisma, { since: bind }), true);
  });

  it('hasCompletedFirstValidUpload: a data-pack import after the bind still never counts', async () => {
    const bind = ago(HOUR);
    upload('c', later(HOUR), { metadata: { importSource: 'data-pack' } });
    assert.equal(await hasCompletedFirstValidUpload('c', prisma, { since: bind }), false);
  });

  it('hasCompletedFirstValidSummerOrder: a stay uploaded before the bind does not count', async () => {
    const bind = ago(HOUR);
    stay('c', ago(2 * HOUR));
    assert.equal(await hasCompletedFirstValidSummerOrder('c'), true);
    assert.equal(await hasCompletedFirstValidSummerOrder('c', prisma, { since: bind }), false);
    stay('c', later(HOUR));
    assert.equal(await hasCompletedFirstValidSummerOrder('c', prisma, { since: bind }), true);
  });
});

describe('late bind via POST /api/referrals/use-code', () => {
  it('pre-bind uploads pay nothing at bind; the first upload after the bind pays the inviter and upline', async () => {
    edge('a', 'b', ago(10 * HOUR)); // a → b, long established
    upload('c', ago(HOUR)); // c was active before binding

    await referralService.useReferralCode('c', 'CODE-b');

    assert.equal(direct('b').length, 0, 'inviter must not be paid at bind for pre-bind activity');
    assert.equal(pointsOf('a', 'upline_reward').length, 0);
    assert.deepEqual(taskProgress, []);
    assert.deepEqual(boosts, []);

    upload('c', later(HOUR));
    const result = await referralService.onInviteeFirstValidUpload('c');

    assert.deepEqual(result, { processed: true });
    assert.deepEqual(direct('b').map((p) => [p.amount, p.sourceId]), [[150, 'c']]);
    assert.deepEqual(pointsOf('a', 'upline_reward').map((p) => p.amount), [15]);
    // referral-N progress now starts for the chain (its level walk is existing behaviour, not asserted here).
    assert.deepEqual(taskProgress[0], { userId: 'b', taskId: 'referral-1', amount: 1 });
    assert.deepEqual(boosts, [{ inviterId: 'b', inviteeId: 'c' }]);
  });

  it('a later upload from an invitee who had only pre-bind uploads stays deferred until a post-bind one exists', async () => {
    upload('c', ago(HOUR));
    await referralService.useReferralCode('c', 'CODE-b');
    // e.g. onInviteeFirstValidUpload re-run by an unrelated insert path with no new row yet
    assert.deepEqual(await referralService.onInviteeFirstValidUpload('c'), { deferred: true });
    assert.equal(direct('b').length, 0);
  });
});

describe('users who registered with a code are unchanged', () => {
  it('bonus is deferred at signup and paid on the first upload', async () => {
    const signup = ago(HOUR);
    edge('b', 'c', signup);
    assert.deepEqual(await referralService.processReferral('c', 'b', 'CODE-b'), { deferred: true });
    upload('c', ago(HOUR / 2));
    assert.deepEqual(await referralService.onInviteeFirstValidUpload('c'), { processed: true });
    assert.equal(direct('b').length, 1);
  });
});

describe('nothing already paid is clawed back', () => {
  it('an invitee whose bonus was paid before this rule keeps it and is never paid twice', async () => {
    upload('c', ago(2 * HOUR));
    edge('b', 'c', ago(HOUR));
    prisma.point.rows.push({ id: 'old', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'c', createdAt: ago(HOUR) });
    upload('c', later(HOUR));
    assert.deepEqual(await referralService.onInviteeFirstValidUpload('c'), { alreadyProcessed: true });
    assert.deepEqual(direct('b').map((p) => p.id), ['old']);
  });

  it('a historical late binder already paid for stays qualified, so the inviter keeps referral-1', async () => {
    // Bound before this rule with only pre-bind uploads; the old code paid b at bind.
    upload('c', ago(3 * HOUR));
    edge('b', 'c', ago(2 * HOUR));
    prisma.point.rows.push({ id: 'old', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'c', createdAt: ago(2 * HOUR) });
    edge('a', 'b', ago(10 * HOUR));

    const forB = await referralService.getReferralOverview('b');
    assert.deepEqual(forB.qualifiedLevelCounts, { 1: 1, 2: 0, 3: 0, 4: 0 });
    assert.equal(forB.referrals[0].qualified, true);
    assert.deepEqual((await referralService.getReferralOverview('a')).qualifiedLevelCounts, { 1: 0, 2: 1, 3: 0, 4: 0 });

    // Under an upline-rebate cutoff later than the payment, the old payment no longer vouches for c.
    const sinceLater = await referralService.getReferralOverview('b', { since: ago(HOUR) });
    assert.deepEqual(sinceLater.qualifiedLevelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });
  });

  it('a paid bonus row for another invitee does not qualify an unpaid late binder', async () => {
    upload('c', ago(3 * HOUR));
    edge('b', 'c', ago(2 * HOUR));
    prisma.point.rows.push({ id: 'other', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'someone-else', createdAt: ago(2 * HOUR) });
    assert.deepEqual((await referralService.getReferralOverview('b')).qualifiedLevelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });
  });
});

describe('bonuses paid at signup before the 2026-06-02 upload gate (ef34c4c) qualify nobody', () => {
  it('a code-registered invitee paid at signup who never uploaded stays unqualified, as on main', async () => {
    const signup = ago(10 * HOUR);
    edge('a', 'b', ago(20 * HOUR));
    upload('b', ago(19 * HOUR));
    edge('b', 'c', signup);
    prisma.point.rows.push({ id: 'signup-paid', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'c', createdAt: signup });

    const forB = await referralService.getReferralOverview('b');
    assert.equal(forB.referrals[0].qualified, false);
    assert.deepEqual(forB.qualifiedLevelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });
    assert.equal(forB.unclaimReferralAwards, 0);
    const forA = await referralService.getReferralOverview('a');
    assert.deepEqual(forA.qualifiedLevelCounts, { 1: 1, 2: 0, 3: 0, 4: 0 });
    assert.equal(forA.referrals[0].theirPoints, 0);

    // A data-pack seed is not an upload either.
    upload('c', ago(HOUR), { metadata: { importSource: 'data-pack' } });
    assert.deepEqual((await referralService.getReferralOverview('b')).qualifiedLevelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });

    // A real upload qualifies them, as on main.
    upload('c', ago(HOUR / 2));
    assert.deepEqual((await referralService.getReferralOverview('b')).qualifiedLevelCounts, { 1: 1, 2: 0, 3: 0, 4: 0 });
    assert.deepEqual((await referralService.getReferralOverview('a')).qualifiedLevelCounts, { 1: 1, 2: 1, 3: 0, 4: 0 });
  });

  it('a late binder paid at bind who never uploaded at all stays unqualified', async () => {
    edge('b', 'c', ago(2 * HOUR));
    prisma.point.rows.push({ id: 'paid', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'c', createdAt: ago(2 * HOUR) });
    assert.deepEqual((await referralService.getReferralOverview('b')).qualifiedLevelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });
  });
});

describe('query cost of the referral tree', () => {
  const spy = (model, method, calls) => {
    const original = prisma[model][method];
    prisma[model][method] = async (args) => {
      calls.push(args);
      return original(args);
    };
    return () => {
      prisma[model][method] = original;
    };
  };
  const bonusLookups = (calls) => calls.filter((args) => args?.where?.source === 'REFERRAL_DIRECT' && args?.where?.sourceId);

  it('a tree where everyone signed up with a code never looks up bonus payments', async () => {
    ['d'].forEach(user);
    edge('a', 'b', ago(10 * HOUR));
    upload('b', ago(9 * HOUR));
    edge('b', 'c', ago(8 * HOUR));
    upload('c', ago(7 * HOUR));
    edge('c', 'd', ago(6 * HOUR)); // d never uploaded
    prisma.point.rows.push(
      { id: 'pb', userId: 'a', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'b', createdAt: ago(9 * HOUR) },
      { id: 'pc', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'c', createdAt: ago(7 * HOUR) },
    );
    const calls = [];
    const restore = spy('point', 'findMany', calls);
    try {
      const forA = await referralService.getReferralOverview('a');
      assert.deepEqual(forA.qualifiedLevelCounts, { 1: 1, 2: 1, 3: 0, 4: 0 });
      assert.deepEqual(bonusLookups(calls), []);
      // Under the claimant's own bind (a signed up without a code: none) nothing changes either.
      assert.deepEqual(await referralService.qualifiedLevelCountsSince(forA.referrals, ago(10 * HOUR)), { 1: 1, 2: 1, 3: 0, 4: 0 });
      assert.deepEqual(bonusLookups(calls), []);
    } finally {
      restore();
    }
  });

  it('looks up bonus payments in ONE query per fetch, however many parents have late binders', async () => {
    ['d', 'x', 'y'].forEach(user);
    edge('a', 'b', ago(10 * HOUR));
    upload('b', ago(9 * HOUR));
    edge('a', 'x', ago(10 * HOUR));
    upload('x', ago(9 * HOUR));
    upload('c', ago(8 * HOUR)); // three late binders under three different parents, on two levels
    edge('b', 'c', ago(7 * HOUR));
    prisma.point.rows.push({ id: 'pc', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'c', createdAt: ago(7 * HOUR) });
    upload('y', ago(8 * HOUR));
    edge('x', 'y', ago(6 * HOUR));
    upload('d', ago(6.5 * HOUR));
    edge('c', 'd', ago(5 * HOUR));

    const calls = [];
    const restore = spy('point', 'findMany', calls);
    try {
      const forA = await referralService.getReferralOverview('a');
      assert.deepEqual(forA.qualifiedLevelCounts, { 1: 2, 2: 1, 3: 0, 4: 0 });
      assert.equal(bonusLookups(calls).length, 1, 'one batched lookup for the whole tree, not one per parent');
      assert.deepEqual([...bonusLookups(calls)[0].where.sourceId.in].sort(), ['c', 'd', 'y']);

      // A later floor puts b and x behind their cutoff too: one more query, for just those two.
      calls.length = 0;
      const since = ago(8.5 * HOUR);
      assert.deepEqual(await referralService.qualifiedLevelCountsSince(forA.referrals, since), { 1: 0, 2: 1, 3: 0, 4: 0 });
      assert.equal(bonusLookups(calls).length, 1);
      assert.deepEqual([...bonusLookups(calls)[0].where.sourceId.in].sort(), ['b', 'x']);

      calls.length = 0;
      assert.deepEqual((await referralService.getReferralOverview('a', { since })).qualifiedLevelCounts, { 1: 0, 2: 1, 3: 0, 4: 0 });
      assert.equal(bonusLookups(calls).length, 1);
    } finally {
      restore();
    }
  });

  it('qualifiedLevelCountsSince matches a fresh getReferralOverview(since) without walking the tree again', async () => {
    ['d', 'e'].forEach(user);
    edge('a', 'b', ago(10 * HOUR));
    upload('b', ago(9 * HOUR));
    edge('b', 'c', ago(8 * HOUR));
    upload('c', ago(7 * HOUR));
    prisma.point.rows.push({ id: 'pc', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'c', createdAt: ago(7 * HOUR) });
    edge('b', 'd', ago(5 * HOUR));
    upload('d', ago(6 * HOUR)); // pre-bind only, grandfathered by a payment at bind
    prisma.point.rows.push({ id: 'pd', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'd', createdAt: ago(5 * HOUR) });
    edge('c', 'e', ago(4 * HOUR));
    upload('e', ago(HOUR));

    const tree = (await referralService.getReferralOverview('a')).referrals;
    for (const since of [null, ago(9.5 * HOUR), ago(6.5 * HOUR), ago(5 * HOUR), ago(3 * HOUR), ago(HOUR / 2)]) {
      const expected = (await referralService.getReferralOverview('a', { since })).qualifiedLevelCounts;
      const walks = [];
      const restore = spy('referral', 'findMany', walks);
      try {
        assert.deepEqual(await referralService.qualifiedLevelCountsSince(tree, since), expected, `since=${since?.toISOString()}`);
      } finally {
        restore();
      }
      assert.equal(walks.length, 0, 'no referral query: the loaded tree is re-judged in memory');
    }
  });
});

describe('referral overview / referral-N task eligibility', () => {
  it('a late binder counts as qualified for every ancestor only after a post-bind upload', async () => {
    edge('a', 'b', ago(10 * HOUR));
    upload('b', ago(9 * HOUR)); // after b's bind → qualified
    upload('c', ago(3 * HOUR)); // before c's bind
    edge('b', 'c', ago(2 * HOUR));

    let forA = await referralService.getReferralOverview('a');
    let forB = await referralService.getReferralOverview('b');
    assert.deepEqual(forA.qualifiedLevelCounts, { 1: 1, 2: 0, 3: 0, 4: 0 });
    assert.deepEqual(forB.qualifiedLevelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });
    assert.equal(forA.referrals[0].theirPoints, 0);

    upload('c', ago(HOUR));
    forA = await referralService.getReferralOverview('a');
    forB = await referralService.getReferralOverview('b');
    assert.deepEqual(forA.qualifiedLevelCounts, { 1: 1, 2: 1, 3: 0, 4: 0 });
    assert.deepEqual(forB.qualifiedLevelCounts, { 1: 1, 2: 0, 3: 0, 4: 0 });
    assert.equal(forA.referrals[0].theirPoints, 150);
  });
});

describe('a user with an existing downline binds an inviter late', () => {
  it('the new inviter counts no descendant who qualified only before that bind', async () => {
    ['z', 'd', 'f'].forEach(user);
    edge('a', 'd', ago(10 * HOUR)); // d signed up with a's code
    upload('d', ago(9 * HOUR));
    prisma.point.rows.push({ id: 'paid-d', userId: 'a', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'd', createdAt: ago(9 * HOUR) });
    edge('d', 'f', ago(8 * HOUR)); // f signed up with d's code
    upload('f', ago(7 * HOUR));
    edge('z', 'a', ago(2 * HOUR)); // a (no inviter until now) binds z's code

    // a's own view is unchanged: d and f joined through code signups and qualified after them.
    assert.deepEqual((await referralService.getReferralOverview('a')).qualifiedLevelCounts, { 1: 1, 2: 1, 3: 0, 4: 0 });
    // z gets nothing from the subtree's pre-bind activity, the grandfathered bonus for d included.
    assert.deepEqual((await referralService.getReferralOverview('z')).qualifiedLevelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });

    upload('f', ago(HOUR)); // f is active after the a→z bind
    assert.deepEqual((await referralService.getReferralOverview('z')).qualifiedLevelCounts, { 1: 0, 2: 0, 3: 1, 4: 0 });
    upload('d', ago(HOUR / 2));
    assert.deepEqual((await referralService.getReferralOverview('z')).qualifiedLevelCounts, { 1: 0, 2: 1, 3: 1, 4: 0 });
  });
});

describe('Summer Travel settlement', () => {
  it('a stay uploaded before binding does not settle; one uploaded after does', async () => {
    stay('c', ago(2 * HOUR));
    edge('b', 'c', ago(HOUR), 'summer-travel-2026');

    assert.deepEqual(await referralService.onInviteeFirstValidUpload('c'), { deferred: true });
    assert.equal(pointsOf('b', 'SUMMER_TRAVEL_2026_INVITER').length + pointsOf('b').length, 0);

    stay('c', later(HOUR));
    const settled = await referralService.onInviteeFirstValidUpload('c');
    assert.equal(settled.skipped, false);
    assert.equal(pointsOf('b').length, 1);
    assert.equal(pointsOf('c').length, 1);
  });
});

// Task claims, whose activity can predate the claim, are covered in taskClaimLateBind.test.js.
describe('upline rebate on points earned by an upload (the activity is the moment of payment)', () => {
  it('pays nobody while the earner has no inviter, so pre-bind upload points can never be rebated', async () => {
    const result = await distributeUplineRewards('c', 100, prisma, 'crawler_data_upload');
    assert.deepEqual(result.distributedRewards, []);
    assert.equal(result.totalDistributed, 0);
    assert.equal(prisma.point.rows.length, 0);
  });

  it('after the bind, rebates follow the chain for points earned from then on', async () => {
    edge('a', 'b', ago(10 * HOUR));
    edge('b', 'c', ago(HOUR));
    const result = await distributeUplineRewards('c', 100, prisma, 'crawler_data_upload');
    assert.deepEqual(result.distributedRewards.map((r) => [r.referrerId, r.amount]), [['b', 10], ['a', 5]]);
  });
});
