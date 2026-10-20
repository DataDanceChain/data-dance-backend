/**
 * Money and points actions run once when two requests collide, on REAL Postgres (`npm run test:db`;
 * needs TEST_DATABASE_URL pointing at a throwaway database that `prisma migrate deploy` has built —
 * its name must contain "test").
 *
 * Calls that race each other are run at once through the real ops router (and, for orders, the
 * plain service the buyer paths use):
 *   - order attestation: two attests (or a payment confirm and a manual attest) send one chain
 *     attestation; a claim newer than 15 minutes blocks the next call, an older one (left by a
 *     crash) is taken over; a chain call that fails releases the claim.
 *   - payouts: two re-checks of a submitted payout reach the sender once; a failed re-check leaves
 *     it submitted for the next one; a payout claimed for its re-check still counts toward the
 *     month's cap; two reconciles of a confirmed payout attest it once, also while the call that
 *     sent it is still attesting, and also when the second call read the payout before the first
 *     attested it but reaches its claim only after the first is done; a reconcile claim newer than
 *     15 minutes blocks, an older one is taken over.
 *   - raffle: draws of one campaign run one at a time and hand out exactly the prize seats.
 *   - points: two deductions at once never take a balance below zero.
 *
 * The chain is the in-memory fake (test/helpers/fakeAttestChain.js) and the payout sender is a stub
 * that records its calls: nothing is sent anywhere. Fixture rows use a per-run id prefix and are
 * deleted afterwards.
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'no-double-processing-db-test-key';
delete process.env.DISBURSEMENT_PAUSED;
delete process.env.DISBURSEMENT_MONTHLY_MAX;

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ethers } = require('ethers');

function replaceModule(file, exports) {
  const resolved = require.resolve(file);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], exports };
}

// Every attestation goes through the real attestHashOnChain against the in-memory chain.
const realChain = require('../../src/utils/commerceAttestChain');
const { FakeChain } = require('../helpers/fakeAttestChain');

const chain = new FakeChain();
// A test can make every chain call slow (`chainGate.delayMs`), so two calls overlap.
const chainGate = { delayMs: 0 };
replaceModule(path.join(__dirname, '../../src/utils/commerceAttestChain.js'), {
  ...realChain,
  attestHashOnChain: async (hash) => {
    if (chainGate.delayMs) await new Promise((resolve) => setTimeout(resolve, chainGate.delayMs));
    return realChain.attestHashOnChain(hash, {
      provider: chain.provider, wallet: chain.wallet(), attester: chain.attester, log: { warn() {} },
    });
  },
});

/** Run `fn` with every chain call taking `ms`. */
async function slowChain(ms, fn) {
  chainGate.delayMs = ms;
  try {
    return await fn();
  } finally {
    chainGate.delayMs = 0;
  }
}

// The payout sender: records each transfer it is asked for and answers a confirmed transfer: a
// re-check finds its stored transfer paid, a first send pays a new one (and reports its hash through
// `onSubmitted` when the caller passes one). A test can make it slow (`sender.delayMs`, so two calls
// overlap) or fail once (`sender.failNext`).
const transfers = [];
const sender = { delayMs: 0, failNext: null };
const realPayout = require('../../src/services/disbursement/bscPayout');
replaceModule(path.join(__dirname, '../../src/services/disbursement/bscPayout.js'), {
  ...realPayout,
  sendBscUsdt: async (args) => {
    transfers.push(args);
    if (sender.delayMs) await new Promise((resolve) => setTimeout(resolve, sender.delayMs));
    if (sender.failNext) {
      const error = sender.failNext;
      sender.failNext = null;
      throw error;
    }
    if (args.existingTxHash) return { txHash: args.existingTxHash, state: 'confirmed', replayed: true };
    const txHash = ethers.hexlify(ethers.randomBytes(32));
    if (typeof args.onSubmitted === 'function') await args.onSubmitted({ txHash });
    return { txHash, state: 'confirmed', replayed: false };
  },
});

/** Run `fn` with every transfer taking `ms`. */
async function slowSender(ms, fn) {
  sender.delayMs = ms;
  try {
    return await fn();
  } finally {
    sender.delayMs = 0;
  }
}

const prisma = require('../../src/utils/prisma');

// A test can hold the next reconcile claim (the payout update that sets reconcileClaimedAt) until it
// lets it go: `holdNextReconcileClaim()` answers { reached, release }.
let claimGate = null;
prisma.$use(async (params, next) => {
  if (claimGate && params.model === 'DisbursementItem' && params.action === 'updateMany'
    && params.args?.data?.reconcileClaimedAt instanceof Date) {
    const gate = claimGate;
    claimGate = null;
    gate.arrived();
    await gate.released;
  }
  return next(params);
});

function holdNextReconcileClaim() {
  let arrived;
  let release;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  claimGate = { arrived, released };
  let timer;
  // Fails (instead of waiting forever) when no call reaches a reconcile claim within 5 s.
  const reached = Promise.race([
    arrival,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('no call reached its reconcile claim')), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
  return {
    reached,
    release,
    /** Lets a held call go and disarms the gate if no call reached it. */
    reset() {
      claimGate = null;
      release();
    },
  };
}

// Modules that build their own client at load get the shared one, so after() closes it.
const clientFile = require.resolve('@prisma/client');
require.cache[clientFile].exports = {
  ...require.cache[clientFile].exports,
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const opsRouter = require('../../src/routes/opsAdminRoutes');
const { attestPaidOrder } = require('../../src/services/commerceAttest');
const { tokenAddress, chainId } = require('../../src/services/disbursement/policy');
const { recordClassForOrigin } = require('../../src/services/disbursement/classify');

const app = express();
app.use(express.json());
app.use('/api/ops', opsRouter);

const RUN = `nd${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
// A personal ops session of a ddc_admin account (seeded in before()): the payout routes need
// ops.payouts, which only ddc_admin holds.
const AUTH = `Bearer ${jwt.sign({ type: 'ops_admin', kind: 'user', sub: `${RUN}-admin` }, process.env.JWT_SECRET, { expiresIn: '10m' })}`;

const post = (route, body = {}) => request(app).post(`/api/ops${route}`).set('Authorization', AUTH).send(body);
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it answers true (or fail after `ms`). */
async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await pause(10);
  }
  throw new Error('waitFor: condition not reached');
}

async function user(name, { organization = false, ...extra } = {}) {
  return prisma.user.create({
    data: {
      id: id(name),
      email: `${id(name)}@example.test`,
      name: id(name),
      referralCode: id(name).toUpperCase(),
      isOrganization: organization,
      userType: organization ? 'organization' : 'regular',
      ...extra,
    },
  });
}

async function cleanup() {
  await prisma.disbursementItem.deleteMany({ where: { payoutId: { startsWith: RUN } } });
  await prisma.campaign.deleteMany({ where: { slug: { startsWith: RUN } } });
  const users = (await prisma.user.findMany({ where: { id: { startsWith: RUN } }, select: { id: true } })).map((u) => u.id);
  if (users.length) {
    const orders = (await prisma.purchaseOrder.findMany({
      where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] },
      select: { id: true },
    })).map((o) => o.id);
    await prisma.payment.deleteMany({ where: { OR: [{ payerId: { in: users } }, { payeeId: { in: users } }] } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: orders } } });
    await prisma.point.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}

before(async () => {
  const admin = await user('admin');
  await prisma.userRoleGrant.create({ data: { userId: admin.id, role: 'ddc_admin', grantedBy: 'script', reason: 'seed for test' } });
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('order attestation: one chain send at a time', () => {
  /** An order with one payment (`paymentStatus`) and no attestation yet. */
  async function unattestedOrder(name, paymentStatus = 'confirmed') {
    const buyer = await user(`${name}-buyer`, { organization: true });
    const seller = await user(`${name}-seller`, { organization: true });
    const order = await prisma.purchaseOrder.create({
      data: { id: id(name), orderNumber: id(name).toUpperCase(), buyerId: buyer.id, sellerId: seller.id, subtotal: 30, total: 30 },
    });
    const payment = await prisma.payment.create({
      data: {
        id: id(`${name}-pay`),
        paymentNumber: id(`${name}-pay`).toUpperCase(),
        orderId: order.id,
        payerId: buyer.id,
        payeeId: seller.id,
        amount: 30,
        method: 'bank_transfer',
        status: paymentStatus,
        paidAt: paymentStatus === 'confirmed' ? new Date() : null,
      },
    });
    return { order, payment };
  }

  it('two attests at once: one chain attestation; the other is refused (409 ATTESTATION_IN_FLIGHT) and writes nothing', async () => {
    const { order } = await unattestedOrder('attest-race');
    const sent = chain.sent.length;
    const results = await slowChain(300, () => Promise.all([
      post(`/orders/${order.id}/attest`),
      post(`/orders/${order.id}/attest`),
    ]));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
    assert.equal(results.find((r) => r.status === 409).body.code, 'ATTESTATION_IN_FLIGHT');
    assert.equal(chain.sent.length, sent + 1, 'one chain attestation');
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.attestationClaimedAt, null, 'the claim is released');

    const later = await post(`/orders/${order.id}/attest`);
    assert.equal(later.status, 200);
    assert.equal(chain.sent.length, sent + 1, 'an attested order is not sent again');
  });

  it('a payment confirm and a manual attest at once: one chain attestation', async () => {
    const { order, payment } = await unattestedOrder('confirm-attest-race', 'pending');
    const sent = chain.sent.length;
    const [confirmed, attested] = await slowChain(300, () => Promise.all([
      post(`/payments/${payment.id}/confirm`),
      post(`/orders/${order.id}/attest`),
    ]));
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.ok([200, 409].includes(attested.status), JSON.stringify(attested.body));
    assert.equal(chain.sent.length, sent + 1, 'one chain attestation');
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.attestationClaimedAt, null);
  });

  it('a chain call that fails releases the claim, and the next attest sends', async () => {
    const { order } = await unattestedOrder('attest-fails');
    const sent = chain.sent.length;
    chain.failures.sendTransaction = new Error('rpc unavailable');
    let failed;
    try {
      failed = await post(`/orders/${order.id}/attest`);
    } finally {
      delete chain.failures.sendTransaction;
    }
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.data.chainPending, true);
    const pending = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(pending.attestationHash, 'the receipt hash is stored for the retry');
    assert.equal(pending.attestationTxHash, null);
    assert.equal(pending.attestationClaimedAt, null, 'released after the failed call');
    const retried = await post(`/orders/${order.id}/attest`);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(chain.sent.length, sent + 1);
    assert.ok((await prisma.purchaseOrder.findUnique({ where: { id: order.id } })).attestationTxHash);
  });

  it('a live claim (1 or 14 minutes old) refuses with 409 and sends and writes nothing; one older than 15 minutes is taken over', async () => {
    const { order } = await unattestedOrder('attest-stale');
    const sent = chain.sent.length;

    for (const minutes of [1, 14]) {
      const claimedAt = minutesAgo(minutes);
      await prisma.purchaseOrder.update({ where: { id: order.id }, data: { attestationClaimedAt: claimedAt } });
      const blocked = await post(`/orders/${order.id}/attest`);
      assert.equal(blocked.status, 409, `${minutes} min: ${JSON.stringify(blocked.body)}`);
      assert.equal(blocked.body.code, 'ATTESTATION_IN_FLIGHT');
      assert.equal(chain.sent.length, sent, `${minutes} min: nothing sent`);
      const held = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
      assert.equal(held.attestationHash, null, `${minutes} min: nothing written`);
      assert.equal(held.attestationTxHash, null);
      assert.equal(held.attestationClaimedAt.getTime(), claimedAt.getTime(), `${minutes} min: the claim stays as it was`);
    }

    await prisma.purchaseOrder.update({ where: { id: order.id }, data: { attestationClaimedAt: minutesAgo(16) } });
    const taken = await post(`/orders/${order.id}/attest`);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(chain.sent.length, sent + 1, 'the stale claim is taken over and the attestation sent once');
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.attestationClaimedAt, null, 'the claim is released');
  });

  it('without an ops session (the buyer paths) the same claim holds: two at once send once', async () => {
    const { order } = await unattestedOrder('attest-race-plain');
    const sent = chain.sent.length;
    const results = await slowChain(300, () => Promise.allSettled([attestPaidOrder(order.id), attestPaidOrder(order.id)]));
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'ATTESTATION_IN_FLIGHT');
    assert.equal(chain.sent.length, sent + 1);
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash && saved.attestationHash);
    assert.equal(saved.attestationClaimedAt, null);
  });
});

describe('payouts', () => {
  const wallet = () => ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)));

  async function payout(name, extra = {}) {
    return prisma.disbursementItem.create({
      data: {
        payoutId: id(name),
        origin: 'internal_reward',
        recordClass: recordClassForOrigin('internal_reward'),
        walletAddress: wallet(),
        amount: 5,
        asset: 'USDT',
        chainId: chainId(),
        tokenAddress: tokenAddress(),
        reason: 'db test',
        status: 'accepted',
        ...extra,
      },
    });
  }

  const submittedPayout = (name, amount = 4) => payout(name, {
    amount,
    status: 'submitted',
    txHash: ethers.hexlify(ethers.randomBytes(32)),
    submittedAt: new Date(),
  });

  const confirmedPayout = (name, amount = 3) => payout(name, {
    amount,
    status: 'confirmed',
    txHash: ethers.hexlify(ethers.randomBytes(32)),
    submittedAt: new Date(),
    confirmedAt: new Date(),
  });

  it('two calls at once on a submitted payout re-check it once (one call reaches the sender)', async () => {
    const item = await submittedPayout('recheck-race');
    const before = transfers.length;
    const results = await slowSender(300, () => Promise.all([
      post(`/disbursements/items/${item.id}/process`),
      post(`/disbursements/items/${item.id}/process`),
    ]));
    assert.equal(transfers.length, before + 1, 'only one caller reached the sender');
    assert.equal(transfers[transfers.length - 1].existingTxHash, item.txHash);
    const statuses = results.map((r) => r.status).sort();
    assert.ok(statuses[0] === 200 && [200, 409].includes(statuses[1]), JSON.stringify(results.map((r) => r.body)));
    const saved = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.equal(saved.status, 'confirmed');
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.reconcileClaimedAt, null);
  });

  it('a re-check that fails releases the payout as submitted, and the next call re-checks it', async () => {
    const item = await submittedPayout('recheck-fails');
    const before = transfers.length;
    sender.failNext = Object.assign(new Error('rpc unavailable'), { statusCode: 503, code: 'rpc_unavailable' });
    const failed = await post(`/disbursements/items/${item.id}/process`);
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    const released = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.equal(released.status, 'submitted');
    assert.equal(released.txHash, item.txHash);
    const ok = await post(`/disbursements/items/${item.id}/process`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(transfers.length, before + 2);
    assert.equal((await prisma.disbursementItem.findUnique({ where: { id: item.id } })).status, 'confirmed');
  });

  it("a payout claimed for its re-check still counts toward the month's cap", async () => {
    const recheck = await submittedPayout('cap-recheck', 4);
    const next = await payout('cap-next', { amount: 5 });
    const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const spent = await prisma.disbursementItem.aggregate({
      _sum: { amount: true },
      where: {
        status: { in: ['submitted', 'processing', 'confirmed'] },
        OR: [{ confirmedAt: { gte: start } }, { submittedAt: { gte: start } }],
      },
    });
    // Room for `next` only if the payout being re-checked were left out of the month's total.
    process.env.DISBURSEMENT_MONTHLY_MAX = String(Number(spent._sum.amount || 0) + 2);
    const before = transfers.length;
    try {
      await slowSender(500, async () => {
        const rechecking = post(`/disbursements/items/${recheck.id}/process`);
        // The request is sent once awaited: start it, then wait until the payout is claimed.
        const done = rechecking.then((res) => res);
        await waitFor(async () => (await prisma.disbursementItem.findUnique({ where: { id: recheck.id } })).status === 'processing');
        const res = await post(`/disbursements/items/${next.id}/process`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.status, 'held', JSON.stringify(res.body));
        assert.match(res.body.data.failureReason, /monthly limit/);
        assert.equal((await done).status, 200);
      });
    } finally {
      delete process.env.DISBURSEMENT_MONTHLY_MAX;
    }
    assert.equal(transfers.length, before + 1, 'only the re-check reached the sender');
  });

  it('two calls at once on a confirmed, unattested payout reconcile it once (one attestation)', async () => {
    const item = await confirmedPayout('reconcile-race');
    const sent = chain.sent.length;
    const before = transfers.length;
    const results = await slowChain(300, () => Promise.all([
      post(`/disbursements/items/${item.id}/process`),
      post(`/disbursements/items/${item.id}/process`),
    ]));
    assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results.map((r) => r.body)));
    assert.equal(chain.sent.length, sent + 1, 'one attestation');
    assert.equal(transfers.length, before, 'a confirmed payout is never sent again');
    const saved = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.reconcileClaimedAt, null, 'the claim is released');

    const again = await post(`/disbursements/items/${item.id}/process`);
    assert.equal(again.status, 200);
    assert.equal(chain.sent.length, sent + 1, 'an attested payout needs nothing more');
  });

  it('a call that arrives while the sending call is still attesting the payout attests nothing', async () => {
    const item = await payout('send-then-reconcile');
    const sent = chain.sent.length;
    const before = transfers.length;
    await slowChain(500, async () => {
      const sending = post(`/disbursements/items/${item.id}/process`).then((res) => res);
      // The transfer is confirmed and the slow attestation has started.
      await waitFor(async () => (await prisma.disbursementItem.findUnique({ where: { id: item.id } })).status === 'confirmed');
      const second = await post(`/disbursements/items/${item.id}/process`);
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal((await sending).status, 200);
    });
    assert.equal(transfers.length, before + 1, 'one transfer');
    assert.equal(chain.sent.length, sent + 1, 'one attestation');
    const saved = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.reconcileClaimedAt, null, 'the claim is released');
  });

  it('a call that read the payout before another call attested it, and claims only after that call is done, attests nothing', async () => {
    const item = await confirmedPayout('reconcile-stale-read');
    const sent = chain.sent.length;
    const before = transfers.length;
    await slowChain(300, async () => {
      const first = post(`/disbursements/items/${item.id}/process`).then((res) => res);
      // The first call holds the claim and is inside its slow chain call.
      await waitFor(async () => (await prisma.disbursementItem.findUnique({ where: { id: item.id } })).reconcileClaimedAt !== null);
      // The second call reads the payout (confirmed, unattested) and is held at its claim.
      const gate = holdNextReconcileClaim();
      const second = post(`/disbursements/items/${item.id}/process`).then((res) => res);
      try {
        await gate.reached;
        assert.equal((await first).status, 200);
        const done = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
        assert.ok(done.attestationTxHash, 'the first call attested the payout');
        assert.equal(done.reconcileClaimedAt, null, 'and released its claim');
        gate.release();
        const late = await second;
        assert.equal(late.status, 200, JSON.stringify(late.body));
        assert.equal(late.body.data.attestationTxHash, done.attestationTxHash, 'the late call answers the stored attestation');
      } finally {
        gate.reset();
        await Promise.allSettled([first, second]);
      }
    });
    assert.equal(chain.sent.length, sent + 1, 'one attestation');
    assert.equal(transfers.length, before, 'a confirmed payout is never sent again');
    const saved = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.equal(saved.reconcileClaimedAt, null);
  });

  it('a call that read the payout while the sending call attested it, and claims only after that call is done, attests nothing', async () => {
    const item = await payout('send-then-stale-read');
    const sent = chain.sent.length;
    const before = transfers.length;
    await slowChain(300, async () => {
      const sending = post(`/disbursements/items/${item.id}/process`).then((res) => res);
      // The transfer is confirmed and the slow attestation has started.
      await waitFor(async () => (await prisma.disbursementItem.findUnique({ where: { id: item.id } })).status === 'confirmed');
      const gate = holdNextReconcileClaim();
      const second = post(`/disbursements/items/${item.id}/process`).then((res) => res);
      try {
        await gate.reached;
        assert.equal((await sending).status, 200);
        const done = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
        assert.ok(done.attestationTxHash, 'the sending call attested the payout');
        assert.equal(done.reconcileClaimedAt, null, 'and released its claim');
        gate.release();
        const late = await second;
        assert.equal(late.status, 200, JSON.stringify(late.body));
        assert.equal(late.body.data.attestationTxHash, done.attestationTxHash);
      } finally {
        gate.reset();
        await Promise.allSettled([sending, second]);
      }
    });
    assert.equal(transfers.length, before + 1, 'one transfer');
    assert.equal(chain.sent.length, sent + 1, 'one attestation');
  });

  it('a live reconcile claim (1 or 14 minutes old) leaves the payout alone; one older than 15 minutes is taken over', async () => {
    const item = await confirmedPayout('reconcile-stale', 2);
    const sent = chain.sent.length;
    const before = transfers.length;

    for (const minutes of [1, 14]) {
      const claimedAt = minutesAgo(minutes);
      await prisma.disbursementItem.update({ where: { id: item.id }, data: { reconcileClaimedAt: claimedAt } });
      const res = await post(`/disbursements/items/${item.id}/process`);
      assert.equal(res.status, 200, `${minutes} min: ${JSON.stringify(res.body)}`);
      assert.equal(chain.sent.length, sent, `${minutes} min: no attestation while the claim is live`);
      const held = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
      assert.equal(held.attestationTxHash, null);
      assert.equal(held.reconcileClaimedAt.getTime(), claimedAt.getTime(), `${minutes} min: the claim stays as it was`);
    }

    await prisma.disbursementItem.update({ where: { id: item.id }, data: { reconcileClaimedAt: minutesAgo(16) } });
    const taken = await post(`/disbursements/items/${item.id}/process`);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(chain.sent.length, sent + 1, 'the stale claim is taken over and the payout attested once');
    assert.equal(transfers.length, before, 'a confirmed payout is never sent again');
    const saved = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.status, 'confirmed');
    assert.equal(saved.reconcileClaimedAt, null, 'the claim is released');
  });
});

describe('raffle draw', () => {
  it('three draws of one campaign at once run one after the other and hand out exactly the prize seats', async () => {
    const now = Date.now();
    const campaign = await prisma.campaign.create({
      data: {
        slug: id('raffle-race'),
        internalName: id('raffle-race'),
        titleEn: 'Raffle',
        titleZh: 'Raffle',
        blurbEn: 'Raffle',
        blurbZh: 'Raffle',
        template: 'RAFFLE',
        status: 'ENDED',
        startsAt: new Date(now - 86400000),
        endsAt: new Date(now - 3600000),
        ctaKind: 'none',
        ctaValue: '',
        createdBy: 'db-test',
        updatedBy: 'db-test',
        config: { prizes: [{ kind: 'POINTS', points: 10, count: 2, labelEn: 'Ten points', labelZh: 'Ten points' }] },
      },
    });
    const holders = [];
    for (let n = 0; n < 6; n += 1) {
      const holder = await user(`raffle-race-holder-${n}`);
      holders.push(holder.id);
      await prisma.campaignRaffleTicket.create({ data: { campaignId: campaign.id, userId: holder.id, tickets: 1 } });
    }
    const results = await Promise.all([1, 2, 3].map(() => post(`/campaigns/${campaign.id}/raffle/draw`)));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200], JSON.stringify(results.map((r) => r.body)));
    // One draw picked the winners; the ones after it found no open seat.
    assert.deepEqual(results.map((r) => r.body.data.created.length).sort(), [0, 0, 2]);
    const wins = await prisma.campaignRaffleWin.findMany({ where: { campaignId: campaign.id } });
    assert.equal(wins.length, 2, 'two seats, two wins');
    assert.equal(new Set(wins.map((w) => w.userId)).size, 2, 'no one wins the same prize twice');
    assert.equal(await prisma.point.count({ where: { sourceId: { in: wins.map((w) => w.id) } } }), 2);
    const balances = await prisma.user.findMany({ where: { id: { in: holders } }, select: { totalPoints: true } });
    assert.equal(balances.reduce((sum, row) => sum + row.totalPoints, 0), 20, 'ten points for each of the two seats');
  });
});

describe('points adjust', () => {
  it('two deductions at once never take the balance below zero', async () => {
    const member = await user('points-race', { totalPoints: 50 });
    const deduct = () => post(`/users/${member.id}/points`, { amount: -30, note: 'duplicate grant' });
    const results = await Promise.all([deduct(), deduct()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400], JSON.stringify(results.map((r) => r.body)));
    const ok = results.find((r) => r.status === 200).body.data;
    assert.equal(ok.balanceBefore, 50);
    assert.equal(ok.balanceAfter, 20);
    assert.match(results.find((r) => r.status === 400).body.message, /Insufficient balance: 20, cannot deduct 30/);
    assert.equal((await prisma.user.findUnique({ where: { id: member.id } })).totalPoints, 20);
    assert.equal(await prisma.point.count({ where: { userId: member.id } }), 1);
  });

  it('a credit and a deduction at once both apply', async () => {
    const member = await user('points-mixed', { totalPoints: 10 });
    const results = await Promise.all([
      post(`/users/${member.id}/points`, { amount: 25, note: 'goodwill credit' }),
      post(`/users/${member.id}/points`, { amount: -5, note: 'duplicate grant' }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results.map((r) => r.body)));
    assert.equal((await prisma.user.findUnique({ where: { id: member.id } })).totalPoints, 30);
    assert.equal(await prisma.point.count({ where: { userId: member.id } }), 2);
  });
});
