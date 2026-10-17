/**
 * Payment decisions, merchant credits and procurement order attestations run once when two
 * requests collide, on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at a
 * throwaway database that `prisma migrate deploy` has built — its name must contain "test").
 *
 * Calls that race each other are run at once through the real ops router and the real commerce
 * router (the payee's and the buyer's paths):
 *   - payments: of a confirm and a reject at once exactly one applies and the other answers 409
 *     and changes nothing; a confirmed payment is never rejected (409 PAYMENT_ALREADY_CONFIRMED);
 *     a repeat reject changes nothing; only the confirm that changed the payment attests its order;
 *     decisions on two payments of one invoice settle it one after the other.
 *   - merchant credit: one Idempotency-Key credits once, also when two requests with it are both
 *     past their lookup before either writes (the database decides); a repeat answers the first
 *     credit; the same key with another amount or note is refused.
 *   - procurement order attestation: two attests (or a buyer attest and an ops attest) send one
 *     chain attestation; a claim newer than 15 minutes blocks, an older one is taken over; a store
 *     that fails after the chain call keeps the claim.
 *
 * The chain is the in-memory fake (test/helpers/fakeAttestChain.js): nothing is sent anywhere.
 * Fixture rows use a per-run id prefix and are deleted afterwards.
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'no-double-processing-commerce-db-test-key';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { listenLoopback } = require('../helpers/loopbackServer');

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

const prisma = require('../../src/utils/prisma');

// Gates on the shared client: a barrier holds matching queries until `count` of them have arrived
// (so two requests are both past their reads before either writes), and `failNextQuery` makes the
// next matching query throw.
const barriers = new Set();
let failNext = null;
prisma.$use(async (params, next) => {
  for (const gate of barriers) {
    if (gate.match(params)) await gate.arrive();
  }
  if (failNext && failNext.match(params)) {
    const { error } = failNext;
    failNext = null;
    throw error;
  }
  return next(params);
});

/**
 * Holds every query `match` accepts until `count` have arrived, then lets them all go. Gives up
 * waiting after `ms` (a code path that never issues the query is not stalled). `done()` disarms it.
 */
function holdUntilAll(match, { count = 2, ms = 3000 } = {}) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let arrived = 0;
  const timer = setTimeout(release, ms);
  const gate = {
    match,
    async arrive() {
      arrived += 1;
      if (arrived >= count) {
        clearTimeout(timer);
        release();
      }
      await released;
    },
  };
  barriers.add(gate);
  return {
    arrived: () => arrived,
    done() {
      clearTimeout(timer);
      release();
      barriers.delete(gate);
    },
  };
}

function failNextQuery(match, error) {
  failNext = { match, error };
}

// Modules that build their own client at load get the shared one, so after() closes it.
const clientFile = require.resolve('@prisma/client');
require.cache[clientFile].exports = {
  ...require.cache[clientFile].exports,
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

// Every attestation that follows a payment confirmation is counted (the controllers call it on
// the module object at call time).
const commerceAttest = require('../../src/services/commerceAttest');
const followUpAttests = [];
const realAttestSafe = commerceAttest.attestPaidOrderSafe;
commerceAttest.attestPaidOrderSafe = (orderId, ...rest) => {
  followUpAttests.push(orderId);
  return realAttestSafe(orderId, ...rest);
};
const attestsFor = (orderId) => followUpAttests.filter((value) => value === orderId).length;

const opsRouter = require('../../src/routes/opsAdminRoutes');
const commerceRouter = require('../../src/routes/commerceRoutes');

const app = express();
app.use(express.json());
app.use('/api/ops', opsRouter);
app.use('/api/commerce', commerceRouter);

// A loopback-bound server for supertest (see test/helpers/loopbackServer.js).
let server;
before(async () => { server = await listenLoopback(app); });

const RUN = `ndc${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
// A personal ops session of a ddc_admin account (seeded in before()).
const OPS_AUTH = `Bearer ${jwt.sign({ type: 'ops_admin', kind: 'user', sub: `${RUN}-admin` }, process.env.JWT_SECRET, { expiresIn: '10m' })}`;
const userAuth = (userId) => `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '10m' })}`;

const ops = (route, body = {}) => request(server).post(`/api/ops${route}`).set('Authorization', OPS_AUTH).send(body);
const as = (member, route, body = {}) => request(server).post(`/api/commerce${route}`).set('Authorization', userAuth(member.id)).send(body);
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
const codes = (results) => JSON.stringify(results.map((r) => [r.status, r.body.code || null, r.body.message || null]));

async function user(name, { organization = true, ...extra } = {}) {
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
  const users = (await prisma.user.findMany({ where: { id: { startsWith: RUN } }, select: { id: true } })).map((u) => u.id);
  if (!users.length) return;
  const orders = (await prisma.purchaseOrder.findMany({
    where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] },
    select: { id: true },
  })).map((o) => o.id);
  await prisma.payment.deleteMany({ where: { OR: [{ payerId: { in: users } }, { payeeId: { in: users } }] } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: orders } } });
  await prisma.organizationTransaction.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}

before(async () => {
  const admin = await user('admin', { organization: false });
  await prisma.userRoleGrant.create({ data: { userId: admin.id, role: 'ddc_admin', grantedBy: 'script', reason: 'seed for test' } });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanup();
  await prisma.$disconnect();
});

/** A buyer and a seller (both organizations) and an order between them, with no attestation. */
async function orderBetween(name, total = 30) {
  const buyer = await user(`${name}-buyer`);
  const seller = await user(`${name}-seller`);
  const order = await prisma.purchaseOrder.create({
    data: {
      id: id(name),
      orderNumber: id(name).toUpperCase(),
      buyerId: buyer.id,
      sellerId: seller.id,
      status: 'invoiced',
      subtotal: total,
      total,
    },
  });
  return { buyer, seller, order };
}

/** An issued invoice for the order. */
async function invoiceFor(order, name) {
  return prisma.invoice.create({
    data: {
      id: id(`${name}-inv`),
      invoiceNumber: id(`${name}-inv`).toUpperCase(),
      orderId: order.id,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      status: 'issued',
      subtotal: order.total,
      total: order.total,
      sellerSnapshot: {},
      buyerSnapshot: {},
    },
  });
}

/** A pending bank-transfer payment of the order (on `invoice` when given). */
async function pendingPayment(name, { order, invoice = null, amount = order.total }) {
  return prisma.payment.create({
    data: {
      id: id(name),
      paymentNumber: id(name).toUpperCase(),
      orderId: order.id,
      invoiceId: invoice ? invoice.id : null,
      payerId: order.buyerId,
      payeeId: order.sellerId,
      amount,
      method: 'bank_transfer',
      status: 'pending',
      matchStatus: 'unmatched',
    },
  });
}

/** A merchant's pending wallet top-up: a PENDING DEPOSIT entry and its pending payment. */
async function pendingTopUp(name, amount = 40) {
  const payer = await user(`${name}-payer`);
  const payee = await user(`${name}-payee`);
  const ledger = await prisma.organizationTransaction.create({
    data: { userId: payer.id, amount, type: 'DEPOSIT', status: 'PENDING', description: 'Wallet top-up', metadata: { source: 'commerce_top_up' } },
  });
  const payment = await prisma.payment.create({
    data: {
      id: id(name),
      paymentNumber: id(name).toUpperCase(),
      payerId: payer.id,
      payeeId: payee.id,
      amount,
      method: 'top_up',
      status: 'pending',
      matchStatus: 'unmatched',
      organizationTransactionId: ledger.id,
    },
  });
  return { payment, ledger };
}

const paymentRow = (paymentId) => prisma.payment.findUnique({ where: { id: paymentId } });
const ledgerRow = (ledgerId) => prisma.organizationTransaction.findUnique({ where: { id: ledgerId } });

describe('payment decisions: one decision per payment', () => {
  it('ops: a confirm and a reject of a pending top-up at once: exactly one applies; the other answers 409 and changes nothing', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { payment, ledger } = await pendingTopUp(`topup-race-${round}`);
      // Both calls read the payment as pending before either writes it.
      const gate = holdUntilAll((p) => p.model === 'Payment' && p.action === 'updateMany' && p.args?.where?.id === payment.id);
      let results;
      try {
        results = await Promise.all([
          ops(`/payments/${payment.id}/confirm`),
          ops(`/payments/${payment.id}/reject`, { notes: 'slip does not match' }),
        ]);
      } finally {
        gate.done();
      }
      const [confirmed, rejected] = results;
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], `round ${round}: ${codes(results)}`);
      const row = await paymentRow(payment.id);
      const entry = await ledgerRow(ledger.id);
      if (row.status === 'confirmed') {
        assert.equal(confirmed.status, 200);
        assert.equal(rejected.body.code, 'PAYMENT_ALREADY_CONFIRMED', `round ${round}`);
        assert.equal(entry.status, 'COMPLETED', `round ${round}`);
        assert.equal(row.notes, null, `round ${round}: the losing reject wrote no notes`);
      } else {
        assert.equal(row.status, 'rejected', `round ${round}`);
        assert.equal(rejected.status, 200);
        assert.equal(confirmed.body.code, 'payment_not_pending', `round ${round}`);
        assert.equal(entry.status, 'FAILED', `round ${round}`);
        assert.equal(row.paidAt, null, `round ${round}: the losing confirm set no paidAt`);
      }
      const decidedBy = ['confirmedBy', 'rejectedBy'].filter((key) => key in (entry.metadata || {}));
      assert.equal(decidedBy.length, 1, `round ${round}: one decision recorded on the entry (${decidedBy})`);
      // #55: the audit row is written in the decision's transaction, by the call that changed it.
      const audits = await prisma.opsAuditLog.findMany({ where: { targetType: 'payment', targetId: payment.id } });
      assert.deepEqual(
        audits.map((a) => [a.action, a.detail.statusBefore, a.detail.statusAfter]),
        [[row.status === 'confirmed' ? 'payment.confirm' : 'payment.reject', 'pending', row.status]],
        `round ${round}: one audit row, from the call that applied`,
      );
    }
  });

  it('ops: rejecting a confirmed payment answers 409 PAYMENT_ALREADY_CONFIRMED; the payment, its entry and its invoice stay as they were', async () => {
    const { payment, ledger } = await pendingTopUp('reject-confirmed-topup');
    assert.equal((await ops(`/payments/${payment.id}/confirm`)).status, 200);
    const refused = await ops(`/payments/${payment.id}/reject`, { notes: 'too late' });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'PAYMENT_ALREADY_CONFIRMED');
    assert.equal((await paymentRow(payment.id)).status, 'confirmed');
    const entry = await ledgerRow(ledger.id);
    assert.equal(entry.status, 'COMPLETED');
    assert.equal('rejectedBy' in entry.metadata, false);

    const { order } = await orderBetween('reject-confirmed-invoice');
    const invoice = await invoiceFor(order, 'reject-confirmed-invoice');
    const paid = await pendingPayment('reject-confirmed-invoice-pay', { order, invoice });
    assert.equal((await ops(`/payments/${paid.id}/confirm`)).status, 200);
    assert.equal((await prisma.invoice.findUnique({ where: { id: invoice.id } })).status, 'paid');
    const again = await ops(`/payments/${paid.id}/reject`, { notes: 'too late' });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.code, 'PAYMENT_ALREADY_CONFIRMED');
    assert.equal((await paymentRow(paid.id)).status, 'confirmed');
    assert.equal((await prisma.invoice.findUnique({ where: { id: invoice.id } })).status, 'paid');
    assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: order.id } })).status, 'paid');
  });

  it('ops: rejecting a rejected payment changes nothing (its notes and entry stay); confirming it answers 409 payment_not_pending', async () => {
    const { payment, ledger } = await pendingTopUp('reject-twice');
    assert.equal((await ops(`/payments/${payment.id}/reject`, { notes: 'slip does not match' })).status, 200);
    const firstEntry = await ledgerRow(ledger.id);
    const again = await ops(`/payments/${payment.id}/reject`, { notes: 'a second note' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const row = await paymentRow(payment.id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.notes, 'slip does not match', 'the notes stay as the first reject left them');
    assert.deepEqual(await ledgerRow(ledger.id), firstEntry, 'the entry is not written again');

    const confirm = await ops(`/payments/${payment.id}/confirm`);
    assert.equal(confirm.status, 409, JSON.stringify(confirm.body));
    assert.equal(confirm.body.code, 'payment_not_pending');
    assert.equal((await paymentRow(payment.id)).status, 'rejected');
    assert.deepEqual(await ledgerRow(ledger.id), firstEntry);
  });

  it('ops: two confirms at once: both answer 200, one confirms, and only that call attests the order (once)', async () => {
    const { order } = await orderBetween('confirm-twice');
    const payment = await pendingPayment('confirm-twice-pay', { order });
    const sent = chain.sent.length;
    const gate = holdUntilAll((p) => p.model === 'Payment' && p.action === 'updateMany' && p.args?.where?.id === payment.id);
    let results;
    try {
      results = await slowChain(200, () => Promise.all([
        ops(`/payments/${payment.id}/confirm`),
        ops(`/payments/${payment.id}/confirm`),
      ]));
    } finally {
      gate.done();
    }
    assert.deepEqual(results.map((r) => r.status), [200, 200], codes(results));
    assert.equal(attestsFor(order.id), 1, 'one follow-up attestation');
    assert.equal(chain.sent.length, sent + 1, 'one chain attestation');
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.attestationClaimedAt, null);
  });

  it('ops: a repeat confirm of a confirmed payment whose order is not attested attests nothing and leaves the order alone', async () => {
    const { order } = await orderBetween('repeat-unattested');
    const payment = await prisma.payment.create({
      data: {
        id: id('repeat-unattested-pay'),
        paymentNumber: id('repeat-unattested-pay').toUpperCase(),
        orderId: order.id,
        payerId: order.buyerId,
        payeeId: order.sellerId,
        amount: 30,
        method: 'bank_transfer',
        status: 'confirmed',
        paidAt: new Date(),
      },
    });
    const sent = chain.sent.length;
    const res = await ops(`/payments/${payment.id}/confirm`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(attestsFor(order.id), 0);
    assert.equal(chain.sent.length, sent, 'no chain transaction');
    const after = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.equal(after.attestationHash, null);
    assert.equal(after.attestedAt, null);
    assert.equal(after.updatedAt.getTime(), order.updatedAt.getTime(), 'the order row was not written');
  });

  it('payee: a confirm and a reject of an invoiced payment at once: exactly one applies, and the invoice and order follow it', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { order, seller } = await orderBetween(`payee-race-${round}`);
      const invoice = await invoiceFor(order, `payee-race-${round}`);
      const payment = await pendingPayment(`payee-race-${round}-pay`, { order, invoice });
      const results = await Promise.all([
        as(seller, `/payments/${payment.id}/confirm`),
        as(seller, `/payments/${payment.id}/reject`, { notes: 'slip does not match' }),
      ]);
      const [confirmed, rejected] = results;
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], `round ${round}: ${codes(results)}`);
      const row = await paymentRow(payment.id);
      const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
      const ord = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
      if (row.status === 'confirmed') {
        assert.equal(rejected.body.code, 'PAYMENT_ALREADY_CONFIRMED', `round ${round}`);
        assert.equal(inv.status, 'paid', `round ${round}`);
        assert.equal(ord.status, 'paid', `round ${round}`);
        assert.equal(attestsFor(order.id), 1, `round ${round}`);
      } else {
        assert.equal(row.status, 'rejected', `round ${round}`);
        assert.equal(confirmed.body.code, 'payment_not_pending', `round ${round}`);
        assert.equal(inv.status, 'issued', `round ${round}`);
        assert.equal(ord.status, 'invoiced', `round ${round}`);
        assert.equal(attestsFor(order.id), 0, `round ${round}`);
      }
    }
  });

  it('payee: rejecting a confirmed payment answers 409 PAYMENT_ALREADY_CONFIRMED and changes nothing', async () => {
    const { order, seller } = await orderBetween('payee-reject-confirmed');
    const invoice = await invoiceFor(order, 'payee-reject-confirmed');
    const payment = await pendingPayment('payee-reject-confirmed-pay', { order, invoice });
    assert.equal((await as(seller, `/payments/${payment.id}/confirm`)).status, 200);
    const refused = await as(seller, `/payments/${payment.id}/reject`, { notes: 'changed my mind' });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'PAYMENT_ALREADY_CONFIRMED');
    const row = await paymentRow(payment.id);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.notes, null);
    assert.equal((await prisma.invoice.findUnique({ where: { id: invoice.id } })).status, 'paid');
  });

  it('payee: the confirm that changes the payment attests its order; a repeat confirm attests nothing', async () => {
    const { order, seller } = await orderBetween('payee-confirm-attests');
    const payment = await pendingPayment('payee-confirm-attests-pay', { order });
    const sent = chain.sent.length;
    const first = await as(seller, `/payments/${payment.id}/confirm`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(attestsFor(order.id), 1);
    assert.equal(chain.sent.length, sent + 1);
    const attested = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(attested.attestationTxHash);

    const again = await as(seller, `/payments/${payment.id}/confirm`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(attestsFor(order.id), 1, 'the repeat attests nothing');
    assert.equal(chain.sent.length, sent + 1);
    const after = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.equal(after.attestedAt.getTime(), attested.attestedAt.getTime(), 'the attestation is not written again');
  });

  it('two payments of one invoice confirmed at once: each counts the other, and the invoice and order end paid', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { order } = await orderBetween(`split-${round}`);
      const invoice = await invoiceFor(order, `split-${round}`);
      const first = await pendingPayment(`split-${round}-a`, { order, invoice, amount: 15 });
      const second = await pendingPayment(`split-${round}-b`, { order, invoice, amount: 15 });
      const results = await Promise.all([
        ops(`/payments/${first.id}/confirm`),
        ops(`/payments/${second.id}/confirm`),
      ]);
      assert.deepEqual(results.map((r) => r.status), [200, 200], codes(results));
      const matches = [(await paymentRow(first.id)).matchStatus, (await paymentRow(second.id)).matchStatus].sort();
      assert.deepEqual(matches, ['matched', 'partial'], `round ${round}: the later confirm counts the earlier one`);
      assert.equal((await prisma.invoice.findUnique({ where: { id: invoice.id } })).status, 'paid', `round ${round}`);
      assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: order.id } })).status, 'paid', `round ${round}`);
    }
  });
});

describe('merchant credit with an Idempotency-Key', () => {
  const credit = (merchant, body, key) => {
    const req = request(server).post(`/api/ops/merchants/${merchant.id}/credit`).set('Authorization', OPS_AUTH);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const deposits = (merchant) => prisma.organizationTransaction.count({ where: { userId: merchant.id, type: 'DEPOSIT' } });

  it('two credits with one key at once, both past their lookup before either writes: one credit; both answer it, one of them replayed', async () => {
    const merchant = await user('idem-race');
    const key = `${RUN}-credit-race`;
    const body = { amount: 25, note: 'goodwill credit' };
    const gate = holdUntilAll((p) => p.model === 'OrganizationTransaction' && p.action === 'create' && p.args?.data?.idempotencyKey === key);
    let results;
    try {
      results = await Promise.all([credit(merchant, body, key), credit(merchant, body, key)]);
    } finally {
      gate.done();
    }
    assert.deepEqual(results.map((r) => r.status), [200, 200], codes(results));
    assert.equal(await deposits(merchant), 1, 'one credit');
    assert.equal(results[0].body.data.transaction.id, results[1].body.data.transaction.id, 'both answer the same credit');
    assert.deepEqual(results.map((r) => Boolean(r.body.data.replayed)).sort(), [false, true]);
    assert.deepEqual(results.map((r) => r.body.data.balance), [25, 25]);
    assert.equal(gate.arrived(), 2, 'both calls reached their write: the database refused the second');
    // #55: the refused write rolled its audit row back with it; the credit has one row.
    const audits = await prisma.opsAuditLog.findMany({ where: { action: 'merchant.credit', targetId: merchant.id } });
    assert.deepEqual(audits.map((a) => a.detail.organizationTransactionId), [results[0].body.data.transaction.id]);
  });

  it('a repeat with the same key answers the first credit (replayed: true) and writes nothing', async () => {
    const merchant = await user('idem-repeat');
    const key = `${RUN}-credit-repeat`;
    const body = { amount: 10, note: 'goodwill credit' };
    const first = await credit(merchant, body, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.replayed, undefined);
    const again = await credit(merchant, body, key);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(await deposits(merchant), 1);
    assert.equal(again.body.data.replayed, true);
    assert.equal(again.body.data.transaction.id, first.body.data.transaction.id);
    assert.equal(again.body.data.balance, 10);
    assert.equal(first.body.data.transaction.idempotencyKey, key);
  });

  it('the same key with another amount or another note answers 409 IDEMPOTENCY_KEY_REUSED and writes nothing', async () => {
    const merchant = await user('idem-reused');
    const key = `${RUN}-credit-reused`;
    assert.equal((await credit(merchant, { amount: 10, note: 'goodwill credit' }, key)).status, 200);
    for (const body of [{ amount: 11, note: 'goodwill credit' }, { amount: 10, note: 'another reason' }]) {
      const res = await credit(merchant, body, key);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REUSED');
    }
    assert.equal(await deposits(merchant), 1);
  });

  it('a malformed key is 400 INVALID_IDEMPOTENCY_KEY and credits nothing; without a key every call credits; the same key for another merchant is another credit', async () => {
    const merchant = await user('idem-plain');
    for (const bad of ['short', 'has spaces in it', 'x'.repeat(129), 'semi;colon-key']) {
      const res = await credit(merchant, { amount: 10, note: 'goodwill credit' }, bad);
      assert.equal(res.status, 400, `${bad}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'INVALID_IDEMPOTENCY_KEY');
    }
    assert.equal(await deposits(merchant), 0);
    assert.equal((await credit(merchant, { amount: 10, note: 'goodwill credit' })).status, 200);
    assert.equal((await credit(merchant, { amount: 10, note: 'goodwill credit' }, '')).status, 200);
    assert.equal(await deposits(merchant), 2, 'no key: each call credits');

    const key = `${RUN}-credit-shared`;
    const other = await user('idem-plain-other');
    assert.equal((await credit(merchant, { amount: 10, note: 'goodwill credit' }, key)).body.data.replayed, undefined);
    assert.equal((await credit(other, { amount: 10, note: 'goodwill credit' }, key)).body.data.replayed, undefined);
    assert.equal(await deposits(merchant), 3);
    assert.equal(await deposits(other), 1);
  });

  it('the database holds one row per merchant and key', async () => {
    const merchant = await user('idem-unique');
    const key = `${RUN}-credit-unique`;
    const row = { userId: merchant.id, amount: 5, type: 'DEPOSIT', status: 'COMPLETED', description: 'x', idempotencyKey: key };
    await prisma.organizationTransaction.create({ data: row });
    await assert.rejects(prisma.organizationTransaction.create({ data: row }), (error) => error.code === 'P2002');
    await prisma.organizationTransaction.create({ data: { ...row, idempotencyKey: null } });
    await prisma.organizationTransaction.create({ data: { ...row, idempotencyKey: null } });
    assert.equal(await deposits(merchant), 3, 'rows without a key never conflict');
  });
});

describe('procurement order attestation: one chain send at a time', () => {
  it('two buyer attests at once: one chain attestation; the other is refused (409 ATTESTATION_IN_FLIGHT) and writes nothing', async () => {
    const { order, buyer } = await orderBetween('proc-race');
    const sent = chain.sent.length;
    const results = await slowChain(300, () => Promise.all([
      as(buyer, `/orders/${order.id}/attest`),
      as(buyer, `/orders/${order.id}/attest`),
    ]));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], codes(results));
    assert.equal(results.find((r) => r.status === 409).body.code, 'ATTESTATION_IN_FLIGHT');
    assert.equal(chain.sent.length, sent + 1, 'one chain attestation');
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.attestationPayload.type, 'datadance.procurement.metadata.v1');
    assert.equal(saved.attestationClaimedAt, null, 'the claim is released');

    const later = await as(buyer, `/orders/${order.id}/attest`);
    assert.equal(later.status, 200);
    assert.equal(chain.sent.length, sent + 1, 'an attested order is not sent again');
  });

  it('a buyer attest and an ops attest at once: one chain attestation', async () => {
    const { order, buyer } = await orderBetween('proc-ops-race');
    const sent = chain.sent.length;
    const results = await slowChain(300, () => Promise.all([
      as(buyer, `/orders/${order.id}/attest`),
      ops(`/orders/${order.id}/attest`),
    ]));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], codes(results));
    assert.equal(chain.sent.length, sent + 1, 'one chain attestation');
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.attestationClaimedAt, null);
  });

  it('a live claim (1 or 14 minutes old) refuses with 409 and sends and writes nothing; one older than 15 minutes is taken over', async () => {
    const { order, buyer } = await orderBetween('proc-stale');
    const sent = chain.sent.length;
    for (const minutes of [1, 14]) {
      const claimedAt = minutesAgo(minutes);
      await prisma.purchaseOrder.update({ where: { id: order.id }, data: { attestationClaimedAt: claimedAt } });
      const blocked = await as(buyer, `/orders/${order.id}/attest`);
      assert.equal(blocked.status, 409, `${minutes} min: ${JSON.stringify(blocked.body)}`);
      assert.equal(blocked.body.code, 'ATTESTATION_IN_FLIGHT');
      assert.equal(chain.sent.length, sent, `${minutes} min: nothing sent`);
      const held = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
      assert.equal(held.attestationHash, null, `${minutes} min: nothing written`);
      assert.equal(held.attestationTxHash, null);
      assert.equal(held.attestationClaimedAt.getTime(), claimedAt.getTime(), `${minutes} min: the claim stays as it was`);
    }

    await prisma.purchaseOrder.update({ where: { id: order.id }, data: { attestationClaimedAt: minutesAgo(16) } });
    const taken = await as(buyer, `/orders/${order.id}/attest`);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(chain.sent.length, sent + 1, 'the stale claim is taken over and the attestation sent once');
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash);
    assert.equal(saved.attestationClaimedAt, null, 'the claim is released');
  });

  it('a chain call that fails releases the claim, and the next attest sends', async () => {
    const { order, buyer } = await orderBetween('proc-chain-fails');
    const sent = chain.sent.length;
    chain.failures.sendTransaction = new Error('rpc unavailable');
    let failed;
    try {
      failed = await as(buyer, `/orders/${order.id}/attest`);
    } finally {
      delete chain.failures.sendTransaction;
    }
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.data.attestationTxHash, null);
    const pending = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(pending.attestationHash, 'the hash is stored for the retry');
    assert.equal(pending.attestationClaimedAt, null, 'released after the failed call');
    const retried = await as(buyer, `/orders/${order.id}/attest`);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(chain.sent.length, sent + 1);
    assert.ok((await prisma.purchaseOrder.findUnique({ where: { id: order.id } })).attestationTxHash);
  });

  it('a store that fails after the chain call keeps the claim: the next attest is refused and nothing is sent again', async () => {
    const { order, buyer } = await orderBetween('proc-store-fails');
    const sent = chain.sent.length;
    failNextQuery(
      (p) => p.model === 'PurchaseOrder' && ['update', 'updateMany'].includes(p.action)
        && p.args?.where?.id === order.id && p.args?.data?.attestationHash !== undefined,
      new Error('connection lost while storing'),
    );
    let failed;
    try {
      failed = await as(buyer, `/orders/${order.id}/attest`);
    } finally {
      failNext = null;
    }
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(chain.sent.length, sent + 1, 'the attestation went out once');
    const held = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(held.attestationClaimedAt instanceof Date, 'the claim stays');
    assert.equal(held.attestationTxHash, null);

    const next = await as(buyer, `/orders/${order.id}/attest`);
    assert.equal(next.status, 409, JSON.stringify(next.body));
    assert.equal(next.body.code, 'ATTESTATION_IN_FLIGHT');
    assert.equal(chain.sent.length, sent + 1, 'nothing is sent again while the claim is live');
  });
});
