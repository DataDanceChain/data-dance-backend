/**
 * The guards that keep money and points actions from running twice, on the in-memory Prisma
 * stand-in (the races themselves run on real Postgres in test/db/noDoubleProcessing.dbtest.js):
 *   - an order's chain attestation is claimed first: a live claim refuses the call (409) and sends
 *     nothing, a stale one is taken over, and the claim is released when the chain call returns
 *     or throws; a stored value that is not a tx hash is attested again and replaced;
 *   - a payout claimed for its re-check ('processing' with its hash kept) is not sent again: a
 *     fresh claim answers 409, a stale one is held for reconciliation;
 *   - a confirmed payout another call attested after this call read it is not attested again;
 *   - a raffle draw locks the campaign row inside its transaction before it reads wins and holders;
 *   - a points adjustment locks the member's row, reads the balance it starts from, and a deduction
 *     checks the balance in the update itself.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

const realChain = require('../../src/utils/commerceAttestChain');
const { FakeChain, randomAddress } = require('../helpers/fakeAttestChain');

// attestHashOnChain runs the real implementation with fake chain deps, or `chainOverride` when set.
let deps = null;
let chainOverride = null;
const chainFile = require.resolve(path.join(__dirname, '../../src/utils/commerceAttestChain.js'));
require.cache[chainFile] = {
  id: chainFile,
  filename: chainFile,
  loaded: true,
  children: [],
  exports: {
    ...realChain,
    attestHashOnChain: (hash) => (chainOverride
      ? chainOverride(hash)
      : realChain.attestHashOnChain(hash, { ...deps, log: { warn() {} } })),
  },
};

// The payout sender records its calls; nothing is sent anywhere. A re-check finds its stored
// transfer paid.
const transfers = [];
const payoutFile = require.resolve(path.join(__dirname, '../../src/services/disbursement/bscPayout.js'));
require.cache[payoutFile] = {
  id: payoutFile,
  filename: payoutFile,
  loaded: true,
  children: [],
  exports: {
    sendBscUsdt: async (args) => {
      transfers.push(args);
      if (args.existingTxHash) return { txHash: args.existingTxHash, state: 'confirmed', replayed: true };
      return { txHash: `0x${'cd'.repeat(32)}`, state: 'confirmed', replayed: false };
    },
  },
};

const commerceAttest = require('../../src/services/commerceAttest');
const disbursement = require('../../src/services/disbursement/service');
const { drawRaffle } = require('../../src/services/campaignEffects');
const { adjustPoints } = require('../../src/controllers/opsAdminController');

const stored = (model, id) => prisma[model].rows.find((r) => r.id === id);
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);

function useChain(chain) {
  deps = { provider: chain.provider, wallet: chain.wallet(), attester: chain.attester };
  return chain;
}

function seedOrder(over = {}) {
  const row = {
    id: `order-${Math.random().toString(36).slice(2)}`,
    orderNumber: `PO-T-${Math.random().toString(36).slice(2, 8)}`,
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    status: 'confirmed',
    currency: 'USD',
    subtotal: 10,
    taxAmount: 0,
    total: 10,
    serviceFeeAmount: 0,
    dataNFTId: null,
    purchaseId: `purchase-${Math.random().toString(36).slice(2)}`,
    attestationHash: null,
    attestationTxHash: null,
    attestationPayload: null,
    attestedAt: null,
    attestationClaimedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
  prisma.purchaseOrder.rows.push(row);
  return row;
}

describe('order attestation claim', () => {
  beforeEach(() => {
    prisma.reset();
    chainOverride = null;
  });

  for (const minutes of [1, 14]) {
    it(`a claim ${minutes} minute(s) old refuses the call (409 ATTESTATION_IN_FLIGHT) and sends and writes nothing`, async () => {
      const chain = useChain(new FakeChain());
      const claimedAt = minutesAgo(minutes);
      const order = seedOrder({ attestationClaimedAt: claimedAt });
      await assert.rejects(commerceAttest.attestPaidOrder(order.id), (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'ATTESTATION_IN_FLIGHT');
        return true;
      });
      assert.equal(chain.sent.length, 0);
      const row = stored('purchaseOrder', order.id);
      assert.equal(row.attestationHash, null);
      assert.equal(row.attestationClaimedAt.getTime(), claimedAt.getTime());
    });
  }

  it('a claim older than 15 minutes is taken over; the attestation is sent once and the claim released', async () => {
    const chain = useChain(new FakeChain());
    const order = seedOrder({ attestationClaimedAt: minutesAgo(16) });
    const result = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(result.chainPending, false);
    assert.equal(chain.sent.length, 1);
    const row = stored('purchaseOrder', order.id);
    assert.equal(row.attestationTxHash, result.attestationTxHash);
    assert.equal(row.attestationClaimedAt, null);
  });

  it('a chain call that throws releases the claim, stores nothing and passes the error on', async () => {
    const order = seedOrder();
    chainOverride = async () => {
      assert.ok(stored('purchaseOrder', order.id).attestationClaimedAt instanceof Date, 'claimed before the chain call');
      throw new Error('signer unavailable');
    };
    await assert.rejects(commerceAttest.attestPaidOrder(order.id), /signer unavailable/);
    const row = stored('purchaseOrder', order.id);
    assert.equal(row.attestationClaimedAt, null);
    assert.equal(row.attestationHash, null);
    assert.equal(row.attestationTxHash, null);
  });

  it('an order another call attested between this call\'s read and its claim is not sent again', async () => {
    const chain = useChain(new FakeChain());
    const order = seedOrder();
    const realUpdateMany = prisma.purchaseOrder.updateMany;
    let first = true;
    prisma.purchaseOrder.updateMany = async (args) => {
      if (first) {
        // The other call stores its tx hash just before this call's claim.
        first = false;
        stored('purchaseOrder', order.id).attestationTxHash = `0x${'12'.repeat(32)}`;
      }
      return realUpdateMany(args);
    };
    try {
      await assert.rejects(commerceAttest.attestPaidOrder(order.id), { code: 'ATTESTATION_IN_FLIGHT' });
    } finally {
      prisma.purchaseOrder.updateMany = realUpdateMany;
    }
    assert.equal(chain.sent.length, 0);
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, `0x${'12'.repeat(32)}`);
    assert.equal(stored('purchaseOrder', order.id).attestationClaimedAt, null);
  });

  it('an order holding a stored value that is not a tx hash is attested again, and the value replaced', async () => {
    const chain = useChain(new FakeChain());
    const order = seedOrder({ attestationTxHash: 'a1b2c3d4' });
    const result = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(chain.sent.length, 1);
    assert.equal(result.chainPending, false);
    const row = stored('purchaseOrder', order.id);
    assert.match(row.attestationTxHash, /^0x[0-9a-f]{64}$/);
    assert.equal(row.attestationTxHash, result.attestationTxHash);
    assert.equal(row.attestationClaimedAt, null);
  });

  it('a failed chain call on such an order clears the value (pending, as before), and the next call sends', async () => {
    const order = seedOrder({ attestationTxHash: 'a1b2c3d4' });
    chainOverride = async () => ({ ok: false, reason: 'rpc unavailable' });
    const failed = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(failed.chainPending, true);
    assert.equal(failed.chainReason, 'rpc unavailable');
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, null);
    assert.equal(stored('purchaseOrder', order.id).attestationClaimedAt, null);
    chainOverride = null;
    const chain = useChain(new FakeChain());
    const retried = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(chain.sent.length, 1);
    assert.equal(retried.chainPending, false);
  });

  it('a tx hash another path stores during the chain call is kept, and the claim released', async () => {
    const order = seedOrder();
    const theirs = `0x${'34'.repeat(32)}`;
    chainOverride = async () => {
      stored('purchaseOrder', order.id).attestationTxHash = theirs;
      return { ok: true, txHash: `0x${'56'.repeat(32)}` };
    };
    const result = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(result.attestationTxHash, theirs);
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, theirs);
    assert.equal(stored('purchaseOrder', order.id).attestationClaimedAt, null);
  });

  it('an order with a stored attestation tx hash is not claimed and not sent', async () => {
    const chain = useChain(new FakeChain());
    const order = seedOrder({ attestationTxHash: `0x${'ef'.repeat(32)}`, attestationClaimedAt: minutesAgo(1) });
    const result = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(chain.sent.length, 0);
    assert.equal(result.attestationTxHash, `0x${'ef'.repeat(32)}`);
  });
});

describe('payout re-check claim', () => {
  beforeEach(() => {
    prisma.reset();
    transfers.length = 0;
    chainOverride = null;
  });

  function seedClaimedRecheck(updatedAt) {
    const row = {
      id: `item-${Math.random().toString(36).slice(2)}`,
      payoutId: `payout-${Math.random().toString(36).slice(2)}`,
      batchId: null,
      partnerId: null,
      origin: 'internal_reward',
      recordClass: 'internal_reward',
      countsAsDataUpload: false,
      walletAddress: randomAddress(),
      amount: 1,
      asset: 'USDT',
      chainId: 56,
      tokenAddress: randomAddress(),
      // Claimed for its re-check: 'processing' with the submitted hash kept.
      status: 'processing',
      txHash: `0x${'ab'.repeat(32)}`,
      submittedAt: updatedAt,
      confirmedAt: null,
      attestationTxHash: null,
      failureReason: null,
      redemptionId: null,
      reconcileClaimedAt: null,
      createdAt: updatedAt,
      updatedAt,
    };
    prisma.disbursementItem.rows.push(row);
    return row;
  }

  it('a re-check claimed moments ago answers 409 and sends nothing', async () => {
    const item = seedClaimedRecheck(minutesAgo(1));
    await assert.rejects(disbursement.processItem(item.id), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'disbursement_in_flight');
      return true;
    });
    assert.equal(transfers.length, 0);
    assert.equal(stored('disbursementItem', item.id).status, 'processing');
  });

  it('a re-check claim older than 15 minutes is held for reconciliation, and nothing is sent', async () => {
    const item = seedClaimedRecheck(minutesAgo(16));
    const result = await disbursement.processItem(item.id);
    assert.equal(result.status, 'held');
    assert.match(result.failureReason, /Reconcile the BSC wallet/);
    assert.equal(result.txHash, item.txHash, 'the submitted hash is kept');
    assert.equal(transfers.length, 0);
    const again = await disbursement.processItem(item.id);
    assert.equal(again.status, 'held');
    assert.equal(transfers.length, 0, 'a held re-check is never sent again');
  });
});

describe('payout reconcile claim', () => {
  beforeEach(() => {
    prisma.reset();
    transfers.length = 0;
    chainOverride = null;
  });

  it('a confirmed payout another call attested between this call\'s read and its claim is not attested again', async () => {
    const chain = useChain(new FakeChain());
    const theirs = `0x${'78'.repeat(32)}`;
    const item = {
      id: `item-${Math.random().toString(36).slice(2)}`,
      payoutId: `payout-${Math.random().toString(36).slice(2)}`,
      batchId: null,
      partnerId: null,
      origin: 'internal_reward',
      recordClass: 'internal_reward',
      countsAsDataUpload: false,
      walletAddress: randomAddress(),
      amount: 1,
      asset: 'USDT',
      chainId: 56,
      tokenAddress: randomAddress(),
      status: 'confirmed',
      txHash: `0x${'9a'.repeat(32)}`,
      submittedAt: minutesAgo(5),
      confirmedAt: minutesAgo(5),
      attestationTxHash: null,
      failureReason: null,
      redemptionId: null,
      reconcileClaimedAt: null,
      createdAt: minutesAgo(5),
      updatedAt: minutesAgo(5),
    };
    prisma.disbursementItem.rows.push(item);
    const realUpdateMany = prisma.disbursementItem.updateMany;
    let first = true;
    prisma.disbursementItem.updateMany = async (args) => {
      if (first) {
        // The other call attests the payout (and releases its claim) just before this call's claim.
        first = false;
        stored('disbursementItem', item.id).attestationTxHash = theirs;
      }
      return realUpdateMany(args);
    };
    let result;
    try {
      result = await disbursement.processItem(item.id);
    } finally {
      prisma.disbursementItem.updateMany = realUpdateMany;
    }
    assert.equal(chain.sent.length, 0, 'no second attestation');
    assert.equal(transfers.length, 0);
    assert.equal(result.attestationTxHash, theirs);
    assert.equal(stored('disbursementItem', item.id).reconcileClaimedAt, null);
  });
});

describe('raffle draw lock', () => {
  it('locks the campaign row inside the transaction before reading the wins and the ticket holders', async () => {
    prisma.reset();
    const calls = [];
    prisma.campaignRaffleWin = {
      findMany: async () => { calls.push('read wins'); return []; },
      create: async ({ data }) => { calls.push('create win'); return { id: `win-${calls.length}`, ...data }; },
    };
    prisma.campaignRaffleTicket = {
      findMany: async () => { calls.push('read holders'); return [{ userId: 'holder-1', tickets: 1 }]; },
    };
    prisma.campaignEvent = { create: async () => { calls.push('event'); return {}; } };
    const original = { tx: prisma.$transaction, raw: prisma.$executeRaw };
    prisma.$transaction = async (fn) => {
      calls.push('begin');
      const result = await original.tx.call(prisma, fn);
      calls.push('commit');
      return result;
    };
    prisma.$executeRaw = async (strings, ...values) => {
      calls.push(`raw ${strings.join('?').trim()} [${values.join(',')}]`);
      return 1;
    };
    try {
      const campaign = {
        id: 'campaign-1',
        template: 'RAFFLE',
        status: 'ENDED',
        config: { prizes: [{ kind: 'BADGE', count: 1, labelEn: 'Badge', labelZh: 'Badge' }] },
      };
      const result = await drawRaffle(campaign, 'ops:test');
      assert.equal(result.created.length, 1);
    } finally {
      prisma.$transaction = original.tx;
      prisma.$executeRaw = original.raw;
      delete prisma.campaignRaffleWin;
      delete prisma.campaignRaffleTicket;
      delete prisma.campaignEvent;
    }
    assert.deepEqual(calls, [
      'begin',
      'raw SELECT 1 FROM "Campaign" WHERE id = ? FOR NO KEY UPDATE [campaign-1]',
      'read wins',
      'read holders',
      'create win',
      'event',
      'commit',
    ]);
  });
});

describe('points adjust balance check', () => {
  beforeEach(() => prisma.reset());

  function call(userId, body) {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    return adjustPoints({ params: { userId }, body, opsAdmin: { username: 'ops-test' } }, res).then(() => res);
  }

  it('a deduction larger than the balance is refused (400) and moves nothing', async () => {
    const member = await prisma.user.create({ data: { email: 'member@example.test', totalPoints: 3 } });
    const res = await call(member.id, { amount: -4, note: 'too much' });
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /Insufficient balance: 3, cannot deduct 4/);
    assert.equal(stored('user', member.id).totalPoints, 3);
    assert.equal(prisma.store.point.length, 0);
  });

  it('a deduction within the balance applies once, with the balance before and after it', async () => {
    const member = await prisma.user.create({ data: { email: 'member@example.test', totalPoints: 10 } });
    const res = await call(member.id, { amount: -4, note: 'duplicate grant' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.balanceBefore, 10);
    assert.equal(res.body.data.balanceAfter, 6);
    assert.equal(stored('user', member.id).totalPoints, 6);
    assert.equal(prisma.store.point.length, 1);
  });

  it('locks the member\'s row before it reads the balance, and reports that balance as before', async () => {
    const member = await prisma.user.create({ data: { email: 'member@example.test', totalPoints: 0.3 } });
    const res = await call(member.id, { amount: 0.1, note: 'goodwill credit' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.balanceBefore, 0.3, 'read, not worked out from the balance after');
    assert.deepEqual(prisma.rawStatements.map((row) => [row.sql.trim(), row.values]), [
      ['SELECT 1 FROM "User" WHERE id = ? FOR NO KEY UPDATE', [member.id]],
    ]);
  });

  it('a credit needs no balance', async () => {
    const member = await prisma.user.create({ data: { email: 'member@example.test', totalPoints: 0 } });
    const res = await call(member.id, { amount: 5, note: 'goodwill credit' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.balanceBefore, 0);
    assert.equal(res.body.data.balanceAfter, 5);
    const { describeOpsAdjustment } = require('../../src/utils/opsAdjustment');
    assert.equal(describeOpsAdjustment(prisma.store.point[0].sourceId).note, 'goodwill credit');
    assert.equal(describeOpsAdjustment(prisma.store.point[0].sourceId).actor, 'ops-test');
  });
});
