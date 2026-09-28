/**
 * Referral payouts re-check "already paid?" inside the payout transaction, after the inviter's row
 * is locked, and a payout that finds itself second pays nothing and triggers no follow-ups.
 * The race itself needs Postgres (test/db/referralPayoutOnce.dbtest.js); here a fake Point table
 * plays the other request by committing its row between the fast-path lookup and the re-check.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
const src = (rel) => path.join(__dirname, '../../src', rel);
const stub = (rel, exportsValue) => {
  const filename = require.resolve(src(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};

const calls = [];
stub('services/taskService.js', {
  recordTaskProgress: async (userId, taskId) => calls.push(['task', userId, taskId]),
});
stub('services/campaignEffects.js', {
  awardReferralBoost: async (inviterId, inviteeId) => calls.push(['boost', inviterId, inviteeId]),
  syncRaffleTicketsForInviter: async () => ({ skipped: true }),
});
stub('services/distributionService.js', {
  distributeUplineRewards: async (userId) => calls.push(['upline', userId]),
});

const referralService = require(src('services/referralService.js'));
const { MOTHERS_DAY_2026_SLUG } = require(src('constants/referralCampaigns.js'));

/**
 * Point table whose `findFirst` answers from `rows`, except that the n-th lookup (1-based) first
 * inserts `raceRow`, as if a concurrent payout committed just before it.
 */
function fakePoints({ raceOnLookup = 0, raceRow = null } = {}) {
  const rows = [];
  let lookups = 0;
  return {
    rows,
    findFirst: async ({ where }) => {
      lookups += 1;
      calls.push(['lookup', lookups]);
      if (lookups === raceOnLookup && raceRow) rows.push(raceRow);
      return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) || null;
    },
    create: async ({ data }) => {
      calls.push(['point', data.userId, data.source]);
      rows.push({ ...data });
      return data;
    },
  };
}

beforeEach(() => {
  prisma.reset();
  calls.length = 0;
  prisma.user.update = async ({ where }) => {
    calls.push(['user.update', where.id]);
    return { id: where.id };
  };
});

describe('direct referral payout', () => {
  it('pays once and runs the follow-ups when nobody paid before', async () => {
    prisma.point = fakePoints();
    const result = await referralService.processReferralRewardsForInvitee('vee', 'inv', 'CODE');
    assert.deepEqual(result, { processed: true });
    assert.equal(prisma.point.rows.length, 1);
    assert.deepEqual(calls.filter(([k]) => k === 'boost'), [['boost', 'inv', 'vee']]);
    assert.deepEqual(calls.filter(([k]) => k === 'task'), [['task', 'inv', 'referral-1']]);
  });

  it('locks the inviter row before re-checking, then pays', async () => {
    prisma.point = fakePoints();
    await referralService.processReferralRewardsForInvitee('vee', 'inv', 'CODE');
    const order = calls.map(([k, x]) => `${k}:${x}`);
    // fast path, inviter row lock (the increment), in-transaction re-check, then the Point row
    assert.deepEqual(order.slice(0, 4), ['lookup:1', 'user.update:inv', 'lookup:2', 'point:inv']);
  });

  it('pays nothing when a concurrent payout committed after the fast-path lookup', async () => {
    prisma.point = fakePoints({
      raceOnLookup: 2,
      raceRow: { userId: 'inv', source: 'REFERRAL_DIRECT', sourceId: 'vee' },
    });
    const result = await referralService.processReferralRewardsForInvitee('vee', 'inv', 'CODE');
    assert.deepEqual(result, { alreadyProcessed: true });
    assert.equal(prisma.point.rows.length, 1, 'only the concurrent payout row exists');
    assert.deepEqual(calls.filter(([k]) => ['point', 'upline', 'boost', 'task'].includes(k)), []);
  });

  it('still rethrows real transaction errors', async () => {
    prisma.point = fakePoints();
    prisma.user.update = async () => {
      throw new Error('connection lost');
    };
    await assert.rejects(referralService.processReferralRewardsForInvitee('vee', 'inv', 'CODE'), /connection lost/);
  });
});

describe('campaign referral payout', () => {
  it('pays inviter and invitee once when nobody paid before', async () => {
    prisma.point = fakePoints();
    const result = await referralService.processCampaignReferral('vee', 'inv', MOTHERS_DAY_2026_SLUG);
    assert.equal(result.skipped, false);
    assert.deepEqual(calls.filter(([k]) => k === 'point').map(([, u]) => u), ['inv', 'vee']);
  });

  it('pays nothing when a concurrent settlement committed after the fast-path lookup', async () => {
    prisma.point = fakePoints({
      raceOnLookup: 2,
      raceRow: { userId: 'inv', source: 'REFERRAL_CAMPAIGN_MOTHERS_DAY_INVITER', sourceId: 'vee' },
    });
    const result = await referralService.processCampaignReferral('vee', 'inv', MOTHERS_DAY_2026_SLUG);
    assert.deepEqual(result, { skipped: true, reason: 'already_processed' });
    assert.deepEqual(calls.filter(([k]) => k === 'point'), []);
  });
});
