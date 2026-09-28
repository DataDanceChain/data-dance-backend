/**
 * Upline rebate on task claims for late-bound referrals (Sloan, 2026-09-28:
 * 后绑码的邀请关系方面的奖励只算绑定后的).
 *
 * claimTask pays the claimant's inviter chain 10/5/2% of the task's points. A task completed before
 * the claimant bound their inviter, and claimed afterwards, must not pay that chain anything: the
 * rebate needs the task to be complete on activity at or after the latest bind on the path to each
 * receiving level. The claimant's own points are unchanged. Tasks with no activity time (profile,
 * holdings, social) count the claim itself as the activity. No database: test/helpers/mockPrisma.
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
// taskService's other collaborators (NFT/X/crawler services) are not on the claim paths tested here.
stub('services/assetService.js', {});
stub('services/xService.js', {});
stub('services/crawlerService.js', { TASK_TEMPLATES: {} });

const { claimTask } = require(src('services/taskService.js'));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms);

function user(id, createdAt = ago(10 * DAY), extra = {}) {
  prisma.user.rows.push({ id, name: id, email: `${id}@example.test`, referralCode: `CODE-${id}`, totalPoints: 0, createdAt, ...extra });
}
function edge(inviterId, inviteeId, createdAt) {
  prisma.referral.rows.push({ id: `r-${inviteeId}`, inviterId, inviteeId, code: `CODE-${inviterId}`, campaignSlug: null, createdAt });
}
let seq = 0;
function upload(userId, createdAt, source = 'amazon') {
  seq += 1;
  prisma.crawlerData.rows.push({ id: `cd-${seq}`, userId, source, type: 'order', payload: {}, metadata: null, createdAt });
}
const rebates = (userId) =>
  prisma.point.rows.filter((p) => p.userId === userId && p.source === 'upline_reward').map((p) => p.amount);
const claimed = (userId) =>
  prisma.point.rows.filter((p) => p.userId === userId && p.source === 'TASK_CLAIM').map((p) => [p.sourceId, p.amount]);

beforeEach(() => {
  prisma.reset();
  seq = 0;
  ['z', 'a', 'b', 'c'].forEach((id) => user(id));
  prisma.task.rows.push(
    { id: 'amazon-order-submit', awardId: 'amazon-data-collection', points: 100, claimLimit: null, metadata: null },
    { id: 'new-user-first-upload', awardId: 'new-user-bonus', points: 50, claimLimit: 1, metadata: null },
    { id: 'profile-1', awardId: 'profile-awards', points: 20, claimLimit: 1, requirementCount: 3, metadata: null },
    { id: 'referral-1', awardId: 'referral-rewards', points: 100, claimLimit: 1, metadata: null },
    { id: 'referral-2', awardId: 'referral-rewards', points: 50, claimLimit: 1, metadata: null },
    { id: 'referral-3', awardId: 'referral-rewards', points: 20, claimLimit: 1, metadata: null },
    { id: 'referral-4', awardId: 'referral-rewards', points: 10, claimLimit: 1, metadata: null },
  );
  edge('z', 'a', ago(9 * DAY)); // a signed up with z's code long ago
});

describe('task completed before a late bind, claimed after it', () => {
  it('data-collection task: the claimant is paid, the new inviter chain is not', async () => {
    upload('b', ago(3 * HOUR)); // completes amazon-order-submit before binding
    edge('a', 'b', ago(HOUR)); // b binds a's code later (use-code / login with a code)

    await claimTask('b', 'amazon-order-submit');

    assert.deepEqual(claimed('b'), [['amazon-order-submit', 100]]);
    assert.deepEqual(rebates('a'), []);
    assert.deepEqual(rebates('z'), []);
  });

  it('new-user task: same, the pre-bind upload does not rebate', async () => {
    user('n', ago(2 * DAY));
    upload('n', ago(DAY));
    edge('a', 'n', ago(HOUR));

    await claimTask('n', 'new-user-first-upload');

    assert.deepEqual(claimed('n'), [['new-user-first-upload', 50]]);
    assert.deepEqual(rebates('a'), []);
  });

  it('referral-1: an invitee who qualified before the claimant bound upward rebates nothing', async () => {
    edge('b', 'c', ago(5 * HOUR));
    upload('c', ago(4 * HOUR));
    prisma.point.rows.push({ id: 'paid-c', userId: 'b', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'c', createdAt: ago(4 * HOUR) });
    edge('a', 'b', ago(HOUR));

    await claimTask('b', 'referral-1');

    assert.deepEqual(claimed('b'), [['referral-1', 100]]);
    assert.deepEqual(rebates('a'), []);
  });
});

describe('activity at or after the bind still rebates', () => {
  it('a post-bind upload completes the task on its own: 10% to the inviter, 5% above', async () => {
    upload('b', ago(3 * HOUR));
    edge('a', 'b', ago(HOUR));
    upload('b', ago(HOUR / 2));

    await claimTask('b', 'amazon-order-submit');

    assert.deepEqual(rebates('a'), [10]);
    assert.deepEqual(rebates('z'), [5]);
  });

  it('referral-1: an invitee who uploads after the claimant bound rebates', async () => {
    edge('b', 'c', ago(5 * HOUR));
    upload('c', ago(4 * HOUR));
    edge('a', 'b', ago(HOUR));
    upload('c', ago(HOUR / 2));

    await claimTask('b', 'referral-1');

    assert.deepEqual(rebates('a'), [10]);
  });

  it('the cutoff is the latest bind on the path: a level above a later bind gets nothing', async () => {
    prisma.referral.rows.length = 0;
    edge('a', 'b', ago(9 * DAY)); // b signed up with a's code
    upload('b', ago(3 * HOUR)); // after b→a, before a→z
    edge('z', 'a', ago(HOUR)); // a binds z's code late

    await claimTask('b', 'amazon-order-submit');

    assert.deepEqual(rebates('a'), [10]);
    assert.deepEqual(rebates('z'), []);
  });
});

describe('a late bind inside the claimant\'s own downline (referral-2/3/4)', () => {
  it('an existing user who late-binds brings no pre-bind qualified subtree to the new inviter', async () => {
    // Clean chain: a (no inviter) invited b at b's signup; b uploaded and qualified long ago.
    prisma.referral.rows.length = 0;
    edge('a', 'b', ago(9 * DAY));
    upload('b', ago(8 * DAY));
    prisma.point.rows.push({ id: 'paid-b', userId: 'a', amount: 150, source: 'REFERRAL_DIRECT', sourceId: 'b', createdAt: ago(8 * DAY) });
    edge('z', 'a', ago(HOUR)); // a binds z's code late; a has not uploaded since

    const refused = await claimTask('z', 'referral-2');
    assert.equal(refused.status, 500);
    assert.equal(refused.error.details, 'Task not completed, cannot claim');
    assert.deepEqual(claimed('z'), []);

    upload('b', ago(HOUR / 2)); // b is active after the a→z bind
    const ok = await claimTask('z', 'referral-2');
    assert.equal(ok.status, 'success');
    assert.deepEqual(claimed('z'), [['referral-2', 50]]);
  });

  it('claim check and upline rebate agree: code-registered claimant, late bind lower in the tree', async () => {
    // a invited c at c's signup; e signed up with d's code and uploaded; d later bound c's code.
    prisma.referral.rows.length = 0;
    ['d', 'e'].forEach((id) => user(id));
    edge('a', 'c', ago(10 * DAY));
    edge('d', 'e', ago(9 * DAY));
    upload('e', ago(8 * DAY));
    edge('c', 'd', ago(2 * DAY));
    upload('d', ago(DAY));

    // e's upload predates d→c, so it earns c nothing; c cannot claim referral-2 and a gets nothing.
    const refused = await claimTask('c', 'referral-2');
    assert.equal(refused.error.details, 'Task not completed, cannot claim');
    assert.deepEqual(rebates('a'), []);

    // Once e is active after d→c, c claims and a (bound before all of it) gets the usual 10%.
    upload('e', ago(HOUR));
    const ok = await claimTask('c', 'referral-2');
    assert.equal(ok.status, 'success');
    assert.deepEqual(claimed('c'), [['referral-2', 50]]);
    assert.deepEqual(rebates('a'), [5]);
  });
});

describe('cost of the referral-N rebate check inside the claim transaction', () => {
  const countReferralTreeQueries = async (fn) => {
    const original = prisma.referral.findMany;
    let calls = 0;
    prisma.referral.findMany = async (args) => {
      calls += 1;
      return original(args);
    };
    try {
      await fn();
    } finally {
      prisma.referral.findMany = original;
    }
    return calls;
  };

  it('walks the claimant\'s tree once, even when every upline level has its own later bind', async () => {
    user('y');
    edge('b', 'c', ago(5 * HOUR));
    upload('c', ago(4 * HOUR));
    edge('a', 'b', ago(3 * HOUR)); // b binds a late
    upload('c', ago(2 * HOUR)); // after a→b: counts for a (and z, bound long before)
    edge('y', 'z', ago(HOUR)); // z binds y later still: c's activity predates it

    const { getReferralOverview } = require(src('services/referralService.js'));
    const oneWalk = await countReferralTreeQueries(() => getReferralOverview('b'));
    const duringClaim = await countReferralTreeQueries(() => claimTask('b', 'referral-1'));

    assert.equal(duringClaim, oneWalk);
    assert.deepEqual(claimed('b'), [['referral-1', 100]]);
    assert.deepEqual(rebates('a'), [10]);
    assert.deepEqual(rebates('z'), [5]);
    assert.deepEqual(rebates('y'), []);
  });
});

describe('unchanged cases', () => {
  it('a user who signed up with a code: bind = registration, every later upload counts', async () => {
    const signup = ago(DAY);
    user('s', signup);
    edge('a', 's', signup);
    upload('s', ago(HOUR));

    await claimTask('s', 'amazon-order-submit');

    assert.deepEqual(rebates('a'), [10]);
    assert.deepEqual(rebates('z'), [5]);
  });

  it('a task with no activity time (profile) counts the claim itself, so it rebates after a late bind', async () => {
    prisma.user.rows.find((u) => u.id === 'b').avatar = 'https://example.test/b.png';
    edge('a', 'b', ago(HOUR));

    await claimTask('b', 'profile-1');

    assert.deepEqual(rebates('a'), [2]);
  });
});
