/**
 * The ops routes that move money or balances write their audit row inside the transaction of the
 * change, on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at a throwaway
 * database that `prisma migrate deploy` has built — its name must contain "test").
 *
 * Through the real ops router: each change leaves exactly one row of its own action and no generic
 * `ops.write` row; a call that changes nothing leaves none; and when Postgres refuses the audit row,
 * the change rolls back with it (no payment, ledger, payout, purchase or points change, and no
 * transfer is attempted).
 *
 * The refusal is a CHECK constraint this file adds for its own run only (it refuses the rows of one
 * per-run admin) and drops afterwards. The chain is the in-memory fake (test/helpers/fakeAttestChain.js)
 * and the payout sender is a stub that records its calls: nothing is sent anywhere. Fixture rows use
 * a per-run id prefix and are deleted afterwards.
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ops-money-audit-db-test-key';
delete process.env.DISBURSEMENT_PAUSED;

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
replaceModule(path.join(__dirname, '../../src/utils/commerceAttestChain.js'), {
  ...realChain,
  attestHashOnChain: (hash) => realChain.attestHashOnChain(hash, {
    provider: chain.provider, wallet: chain.wallet(), attester: chain.attester, log: { warn() {} },
  }),
});

// The payout sender: records each transfer it is asked for and answers a confirmed hash. A test
// can make it slow (`sender.delayMs`, so two calls overlap) or fail once (`sender.failNext`).
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
    return { txHash: ethers.hexlify(ethers.randomBytes(32)), replayed: false };
  },
});

const prisma = require('../../src/utils/prisma');
// Modules that build their own client at load get the shared one, so after() closes it.
const clientFile = require.resolve('@prisma/client');
require.cache[clientFile].exports = {
  ...require.cache[clientFile].exports,
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const opsRouter = require('../../src/routes/opsAdminRoutes');
const demandService = require('../../src/services/demandService');
const { purchasePublishedPack } = require('../../src/services/packPurchase');
const { tokenAddress, chainId } = require('../../src/services/disbursement/policy');
const { recordClassForOrigin } = require('../../src/services/disbursement/classify');

const app = express();
app.use(express.json());
app.use('/api/ops', opsRouter);

const RUN = `ma${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const REFUSE_CONSTRAINT = `${RUN}_refuse_audit`;

let admin;
let refused;
const auth = {};

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

async function staff(name) {
  const row = await user(name);
  await prisma.userRoleGrant.create({ data: { userId: row.id, role: 'ddc_admin', grantedBy: 'script', reason: 'db test admin' } });
  return row;
}

const opsToken = (row) => `Bearer ${jwt.sign({ type: 'ops_admin', kind: 'user', sub: row.id }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;

const post = (route, authorization, body = {}) =>
  request(app).post(`/api/ops${route}`).set('Authorization', authorization).send(body);

/** The generic row starts after the answer; give it time to land before counting rows. */
const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

const rowsFor = (targetId) => prisma.opsAuditLog.findMany({ where: { targetId }, orderBy: { createdAt: 'asc' } });
const genericRows = () => prisma.opsAuditLog.count({ where: { action: 'ops.write', actorUserId: { in: [admin.id, refused.id] } } });

async function kyc(userId) {
  return prisma.legalEntity.create({
    data: {
      userId,
      companyName: `${userId} Ltd`,
      brNumber: 'BR-0001',
      beneficialOwner: 'Test Owner',
      address: '1 Test Street',
      country: 'SG',
      email: `kyc-${userId}@example.test`,
      kycStatus: 'submitted',
    },
  });
}

async function deposit(userId, amount, status = 'COMPLETED') {
  return prisma.organizationTransaction.create({
    data: { userId, amount, type: 'DEPOSIT', status, description: `${RUN} deposit` },
  });
}

async function pack(name, merchantId, price = 30) {
  return prisma.dataNFT.create({
    data: {
      id: id(name),
      name: id(name),
      price,
      isPublished: true,
      merchantId,
      dataSource: 'upload',
      dataRecords: { recordCount: 2, records: [{ row: 1 }, { row: 2 }] },
    },
  });
}

async function cleanup() {
  const users = (await prisma.user.findMany({ where: { id: { startsWith: RUN } }, select: { id: true } })).map((u) => u.id);
  await prisma.disbursementItem.deleteMany({ where: { payoutId: { contains: RUN } } });
  await prisma.disbursementBatch.deleteMany({ where: { externalBatchId: { contains: RUN } } });
  const redemptions = (await prisma.pointsRedemption.findMany({ where: { email: { startsWith: RUN } }, select: { id: true } })).map((r) => r.id);
  if (redemptions.length) {
    const payoutIds = redemptions.map((rid) => `redemption:${rid}`);
    await prisma.disbursementItem.deleteMany({ where: { payoutId: { in: payoutIds } } });
    await prisma.disbursementBatch.deleteMany({ where: { externalBatchId: { in: payoutIds } } });
    await prisma.pointsRedemption.deleteMany({ where: { id: { in: redemptions } } });
  }
  await prisma.campaign.deleteMany({ where: { slug: { startsWith: RUN } } });
  if (users.length) {
    const orders = (await prisma.purchaseOrder.findMany({
      where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] },
      select: { id: true },
    })).map((o) => o.id);
    await prisma.dataDemand.deleteMany({ where: { buyerId: { in: users } } });
    await prisma.payment.deleteMany({ where: { OR: [{ payerId: { in: users } }, { payeeId: { in: users } }] } });
    await prisma.invoice.deleteMany({ where: { orderId: { in: orders } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: orders } } });
    await prisma.organizationTransaction.deleteMany({ where: { userId: { in: users } } });
    await prisma.dataNFTPurchase.deleteMany({ where: { buyerId: { in: users } } });
    await prisma.dataNFT.deleteMany({ where: { merchantId: { in: users } } });
    await prisma.legalEntity.deleteMany({ where: { userId: { in: users } } });
    await prisma.point.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}

before(async () => {
  admin = await staff('admin');
  refused = await staff('refuse');
  auth.admin = opsToken(admin);
  auth.refused = opsToken(refused);
  // Postgres refuses every audit row of the `refuse` admin (and only those): its changes must roll back.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "${REFUSE_CONSTRAINT}" CHECK ("actorLabel" NOT LIKE '${RUN}-refuse%') NOT VALID`,
  );
});

after(async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "OpsAuditLog" DROP CONSTRAINT IF EXISTS "${REFUSE_CONSTRAINT}"`);
  await prisma.$executeRawUnsafe('DELETE FROM "OpsAuditLog" WHERE "actorLabel" LIKE $1', `${RUN}%`);
  await cleanup();
  await prisma.$disconnect();
});

describe('payments', () => {
  let payer;
  let payee;
  before(async () => {
    payer = await user('payer', { organization: true });
    payee = await user('payee', { organization: true });
  });

  async function topUp(name, amount = 40) {
    const ledger = await deposit(payer.id, amount, 'PENDING');
    return prisma.payment.create({
      data: {
        id: id(name),
        paymentNumber: id(name).toUpperCase(),
        payerId: payer.id,
        payeeId: payee.id,
        amount,
        currency: 'USD',
        method: 'top_up',
        status: 'pending',
        matchStatus: 'unmatched',
        organizationTransactionId: ledger.id,
      },
    });
  }

  it('confirm: the payment, its ledger row and one payment.confirm row commit together; a repeat changes nothing', async () => {
    const payment = await topUp('pay-confirm');
    const res = await post(`/payments/${payment.id}/confirm`, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'confirmed');
    assert.equal((await prisma.organizationTransaction.findUnique({ where: { id: payment.organizationTransactionId } })).status, 'COMPLETED');

    const again = await post(`/payments/${payment.id}/confirm`, auth.admin);
    assert.equal(again.status, 200);
    await settle();
    const rows = await rowsFor(payment.id);
    assert.deepEqual(rows.map((row) => row.action), ['payment.confirm']);
    assert.equal(rows[0].actorUserId, admin.id);
    assert.equal(rows[0].targetType, 'payment');
    assert.equal(rows[0].detail.statusBefore, 'pending');
    assert.equal(rows[0].detail.statusAfter, 'confirmed');
    assert.equal(rows[0].detail.amount, 40);
    assert.equal(await genericRows(), 0, 'no generic ops.write row for a money route');
  });

  it('confirm: two at once make one change and one row', async () => {
    const payment = await topUp('pay-race');
    const results = await Promise.all([
      post(`/payments/${payment.id}/confirm`, auth.admin),
      post(`/payments/${payment.id}/confirm`, auth.admin),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    await settle();
    assert.equal((await rowsFor(payment.id)).length, 1);
    const ledger = await prisma.organizationTransaction.findUnique({ where: { id: payment.organizationTransactionId } });
    assert.equal(ledger.status, 'COMPLETED');
  });

  it('confirm: when the audit row is refused, the payment and its ledger row stay as they were', async () => {
    const payment = await topUp('pay-confirm-refused');
    const res = await post(`/payments/${payment.id}/confirm`, auth.refused);
    assert.equal(res.status, 500);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'pending');
    assert.equal((await prisma.organizationTransaction.findUnique({ where: { id: payment.organizationTransactionId } })).status, 'PENDING');
    await settle();
    assert.equal((await rowsFor(payment.id)).length, 0);
  });

  it('reject: a confirmed payment is refused (409) and its completed ledger row stays COMPLETED', async () => {
    const payment = await topUp('pay-reject-confirmed');
    assert.equal((await post(`/payments/${payment.id}/confirm`, auth.admin)).status, 200);
    const res = await post(`/payments/${payment.id}/reject`, auth.admin, { notes: 'too late' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'PAYMENT_ALREADY_CONFIRMED');
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'confirmed');
    assert.equal((await prisma.organizationTransaction.findUnique({ where: { id: payment.organizationTransactionId } })).status, 'COMPLETED');
    await settle();
    assert.deepEqual((await rowsFor(payment.id)).map((row) => row.action), ['payment.confirm']);
    assert.equal(await genericRows(), 0);
  });

  it('confirm and reject at once: a confirmed payment never ends with a FAILED ledger row', async () => {
    for (let round = 0; round < 4; round += 1) {
      const payment = await topUp(`pay-confirm-reject-${round}`);
      const [confirmed, rejected] = await Promise.all([
        post(`/payments/${payment.id}/confirm`, auth.admin),
        post(`/payments/${payment.id}/reject`, auth.admin, { notes: 'slip does not match' }),
      ]);
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.ok([200, 409].includes(rejected.status), JSON.stringify(rejected.body));
      const row = await prisma.payment.findUnique({ where: { id: payment.id } });
      const ledger = await prisma.organizationTransaction.findUnique({ where: { id: payment.organizationTransactionId } });
      assert.equal(row.status, 'confirmed', `round ${round}`);
      assert.equal(ledger.status, 'COMPLETED', `round ${round}`);
    }
  });

  it('reject: one payment.reject row with the note as its reason; a refused row leaves the payment pending', async () => {
    const payment = await topUp('pay-reject');
    const res = await post(`/payments/${payment.id}/reject`, auth.admin, { notes: 'slip does not match' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await prisma.organizationTransaction.findUnique({ where: { id: payment.organizationTransactionId } })).status, 'FAILED');
    await settle();
    const rows = await rowsFor(payment.id);
    assert.deepEqual(rows.map((row) => [row.action, row.reason, row.detail.statusAfter]), [['payment.reject', 'slip does not match', 'rejected']]);

    const other = await topUp('pay-reject-refused');
    const refusedRes = await post(`/payments/${other.id}/reject`, auth.refused, { notes: 'slip does not match' });
    assert.equal(refusedRes.status, 500);
    assert.equal((await prisma.payment.findUnique({ where: { id: other.id } })).status, 'pending');
    assert.equal((await prisma.organizationTransaction.findUnique({ where: { id: other.organizationTransactionId } })).status, 'PENDING');
    assert.equal((await rowsFor(other.id)).length, 0);
  });
});

describe('merchant credit', () => {
  it('one credit: one ledger row and one merchant.credit row; a refused row credits nothing', async () => {
    const merchant = await user('credit-merchant', { organization: true });
    const res = await post(`/merchants/${merchant.id}/credit`, auth.admin, { amount: 25, note: 'goodwill credit' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.balance, 25);
    await settle();
    const rows = await rowsFor(merchant.id);
    assert.deepEqual(rows.map((row) => [row.action, row.targetType, row.reason]), [['merchant.credit', 'user', 'goodwill credit']]);
    assert.equal(rows[0].detail.organizationTransactionId, res.body.data.transaction.id);
    assert.equal(rows[0].detail.amount, 25);

    const refusedRes = await post(`/merchants/${merchant.id}/credit`, auth.refused, { amount: 25, note: 'goodwill credit' });
    assert.equal(refusedRes.status, 500);
    assert.equal(await prisma.organizationTransaction.count({ where: { userId: merchant.id } }), 1);
    assert.equal((await rowsFor(merchant.id)).length, 1);
    assert.equal(await genericRows(), 0);
  });
});

describe('order attestation', () => {
  /** A paid order with one payment (`status`), and no attestation yet. */
  async function orderWithPayment(name, status = 'pending') {
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
        status,
        paidAt: status === 'confirmed' ? new Date() : null,
      },
    });
    return { order, payment };
  }

  it('repeat confirm on an order that is not attested: nothing is attested, sent or recorded', async () => {
    const { order, payment } = await orderWithPayment('repeat-unattested', 'confirmed');
    const sent = chain.sent.length;
    const res = await post(`/payments/${payment.id}/confirm`, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.equal(after.attestationHash, null);
    assert.equal(after.attestationTxHash, null);
    assert.equal(after.attestedAt, null);
    assert.equal(after.updatedAt.getTime(), order.updatedAt.getTime(), 'the order row was not written');
    assert.equal(chain.sent.length, sent, 'no chain transaction');
    await settle();
    assert.equal((await rowsFor(payment.id)).length, 0);
    assert.equal((await rowsFor(order.id)).length, 0);
    assert.equal(await genericRows(), 0);
  });

  it('the confirm that changes the payment attests its order with its own order.attest row, same actor; a repeat adds nothing', async () => {
    const { order, payment } = await orderWithPayment('confirm-attests');
    const sent = chain.sent.length;
    const res = await post(`/payments/${payment.id}/confirm`, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const attested = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(attested.attestationHash);
    assert.ok(attested.attestationTxHash);
    assert.equal(chain.sent.length, sent + 1);
    await settle();
    const paymentRows = await rowsFor(payment.id);
    const orderRows = await rowsFor(order.id);
    assert.deepEqual(paymentRows.map((row) => row.action), ['payment.confirm']);
    assert.deepEqual(orderRows.map((row) => [row.action, row.targetType, row.actorUserId, row.detail.chainSend]), [['order.attest', 'order', admin.id, true]]);
    assert.equal(orderRows[0].detail.attestationHash, attested.attestationHash);
    assert.equal(orderRows[0].requestId, paymentRows[0].requestId, 'one request, two rows');

    const again = await post(`/payments/${payment.id}/confirm`, auth.admin);
    assert.equal(again.status, 200);
    assert.equal(chain.sent.length, sent + 1);
    await settle();
    assert.equal((await rowsFor(payment.id)).length, 1);
    assert.equal((await rowsFor(order.id)).length, 1);
    assert.equal(await genericRows(), 0);
  });

  it('one attest: the stored attestation and one order.attest row; a refused row leaves the order as it was', async () => {
    const buyer = await user('attest-buyer', { organization: true });
    const seller = await user('attest-seller', { organization: true });
    await kyc(buyer.id);
    await kyc(seller.id);
    await deposit(buyer.id, 100);
    const item = await pack('attest-pack', seller.id, 30);
    const bought = await purchasePublishedPack({ buyerId: buyer.id, dataNFTId: item.id });
    const orderId = bought.order.id;

    const res = await post(`/orders/${orderId}/attest`, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await settle();
    const rows = await rowsFor(orderId);
    assert.deepEqual(rows.map((row) => [row.action, row.targetType]), [['order.attest', 'order']]);
    assert.ok(rows[0].detail.attestationHash);

    const stored = await prisma.purchaseOrder.findUnique({ where: { id: orderId } });
    const refusedRes = await post(`/orders/${orderId}/attest`, auth.refused);
    assert.equal(refusedRes.status, 500);
    const after = await prisma.purchaseOrder.findUnique({ where: { id: orderId } });
    assert.equal(after.attestedAt.getTime(), stored.attestedAt.getTime(), 'the refused attest stored nothing');
    assert.equal((await rowsFor(orderId)).length, 1);
  });

  it('the audit row is written before the chain call: a refused row sends no chain transaction', async () => {
    const { order } = await orderWithPayment('attest-refused-first', 'confirmed');
    const sent = chain.sent.length;
    const refusedRes = await post(`/orders/${order.id}/attest`, auth.refused);
    assert.equal(refusedRes.status, 500);
    assert.equal(chain.sent.length, sent, 'nothing was sent on chain');
    const after = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.equal(after.attestationHash, null);
    assert.equal(after.attestationTxHash, null);
    assert.equal((await rowsFor(order.id)).length, 0);

    const res = await post(`/orders/${order.id}/attest`, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(chain.sent.length, sent + 1);
    const rows = await rowsFor(order.id);
    assert.deepEqual(rows.map((row) => [row.action, row.detail.chainSend, row.detail.attestationTxHash]), [['order.attest', true, null]]);
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    assert.ok(saved.attestationTxHash, 'the hash the chain call returned is stored on the order');
    assert.ok(rows[0].createdAt <= saved.updatedAt);
  });
});

describe('payouts', () => {
  const wallet = () => ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)));

  async function payout(name, amount = 5) {
    return prisma.disbursementItem.create({
      data: {
        payoutId: id(name),
        origin: 'internal_reward',
        recordClass: recordClassForOrigin('internal_reward'),
        walletAddress: wallet(),
        amount,
        asset: 'USDT',
        chainId: chainId(),
        tokenAddress: tokenAddress(),
        reason: 'db test',
        status: 'accepted',
      },
    });
  }

  it('process: the claim and one disbursement.process row commit before the one transfer; a repeat sends nothing', async () => {
    const item = await payout('process');
    const before = transfers.length;
    const res = await post(`/disbursements/items/${item.id}/process`, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(transfers.length, before + 1);
    const saved = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.equal(saved.status, 'confirmed');
    assert.ok(saved.txHash);

    const again = await post(`/disbursements/items/${item.id}/process`, auth.admin);
    assert.equal(again.status, 200);
    assert.equal(transfers.length, before + 1, 'a processed payout is not sent again');
    await settle();
    const rows = await rowsFor(item.id);
    assert.deepEqual(rows.map((row) => [row.action, row.detail.step, row.detail.statusBefore, row.detail.statusAfter]), [
      ['disbursement.process', 'send', 'accepted', 'processing'],
    ]);
    assert.equal(rows[0].detail.amount, 5);
    assert.equal(rows[0].detail.walletAddress, saved.walletAddress);
    assert.equal(await genericRows(), 0);
  });

  it('process: when the audit row is refused, the payout is not claimed and no transfer is attempted', async () => {
    const item = await payout('process-refused');
    const before = transfers.length;
    const res = await post(`/disbursements/items/${item.id}/process`, auth.refused);
    assert.equal(res.status, 500);
    assert.equal(transfers.length, before);
    const saved = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.equal(saved.status, 'accepted');
    assert.equal(saved.txHash, null);
    assert.equal((await rowsFor(item.id)).length, 0);
  });

  it('process: a payout held by policy is held with one row', async () => {
    const item = await payout('process-held', 1e9);
    const before = transfers.length;
    const res = await post(`/disbursements/items/${item.id}/process`, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(transfers.length, before);
    assert.equal((await prisma.disbursementItem.findUnique({ where: { id: item.id } })).status, 'held');
    const rows = await rowsFor(item.id);
    assert.deepEqual(rows.map((row) => [row.action, row.detail.step, row.detail.holdCode]), [['disbursement.process', 'hold', 'per_item_limit']]);
  });

  async function submittedPayout(name, amount = 4) {
    return prisma.disbursementItem.create({
      data: {
        payoutId: id(name),
        origin: 'internal_reward',
        recordClass: recordClassForOrigin('internal_reward'),
        walletAddress: wallet(),
        amount,
        asset: 'USDT',
        chainId: chainId(),
        tokenAddress: tokenAddress(),
        reason: 'db test',
        status: 'submitted',
        txHash: ethers.hexlify(ethers.randomBytes(32)),
        submittedAt: new Date(),
      },
    });
  }

  it('process: two calls at once on a submitted payout re-check it once (one send, one row)', async () => {
    const item = await submittedPayout('recheck-race');
    const before = transfers.length;
    sender.delayMs = 300;
    let results;
    try {
      results = await Promise.all([
        post(`/disbursements/items/${item.id}/process`, auth.admin),
        post(`/disbursements/items/${item.id}/process`, auth.admin),
      ]);
    } finally {
      sender.delayMs = 0;
    }
    assert.equal(transfers.length, before + 1, 'only one caller reached the sender');
    assert.equal(transfers[transfers.length - 1].existingTxHash, item.txHash);
    const statuses = results.map((r) => r.status).sort();
    assert.ok(statuses[0] === 200 && [200, 409].includes(statuses[1]), JSON.stringify(results.map((r) => r.body)));
    const saved = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.equal(saved.status, 'confirmed');
    await settle();
    const rows = await rowsFor(item.id);
    assert.deepEqual(rows.map((row) => [row.action, row.detail.step, row.detail.statusBefore, row.detail.statusAfter]), [
      ['disbursement.process', 'recheck', 'submitted', 'processing'],
    ]);
  });

  it('process: a re-check that fails releases the payout as submitted, and the next call re-checks it', async () => {
    const item = await submittedPayout('recheck-fails');
    const before = transfers.length;
    sender.failNext = Object.assign(new Error('rpc unavailable'), { statusCode: 503, code: 'rpc_unavailable' });
    const failed = await post(`/disbursements/items/${item.id}/process`, auth.admin);
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    const released = await prisma.disbursementItem.findUnique({ where: { id: item.id } });
    assert.equal(released.status, 'submitted');
    assert.equal(released.txHash, item.txHash);
    const ok = await post(`/disbursements/items/${item.id}/process`, auth.admin);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(transfers.length, before + 2);
    assert.equal((await prisma.disbursementItem.findUnique({ where: { id: item.id } })).status, 'confirmed');
    assert.deepEqual((await rowsFor(item.id)).map((row) => row.detail.step), ['recheck', 'recheck']);
  });

  async function redemption(name) {
    return prisma.pointsRedemption.create({
      data: { email: `${id(name)}@example.test`, emailNormalized: `${id(name)}@example.test`, points: 300, amount: 3, asset: 'USDT' },
    });
  }

  it('disburse: the new payout and one disbursement.disburse row commit together, then one transfer', async () => {
    const row = await redemption('disburse');
    const to = wallet();
    const before = transfers.length;
    const res = await post(`/disbursements/redemptions/${row.id}/disburse`, auth.admin, { walletAddress: to });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(transfers.length, before + 1);
    await settle();
    const rows = await rowsFor(row.id);
    assert.deepEqual(rows.map((r) => [r.action, r.targetType, r.detail.step]), [['disbursement.disburse', 'points_redemption', 'create']]);
    assert.equal(rows[0].detail.walletAddress, to);
    assert.equal(rows[0].detail.amount, 3);
    const item = await prisma.disbursementItem.findUnique({ where: { redemptionId: row.id } });
    assert.equal(item.status, 'confirmed');
    assert.equal((await rowsFor(item.id)).length, 0, 'the transfer belongs to the disburse row: one row per call');
    assert.equal((await prisma.pointsRedemption.findUnique({ where: { id: row.id } })).status, 'paid');
  });

  it('disburse: when the audit row is refused, no payout is created and nothing is sent', async () => {
    const row = await redemption('disburse-refused');
    const before = transfers.length;
    const res = await post(`/disbursements/redemptions/${row.id}/disburse`, auth.refused, { walletAddress: wallet() });
    assert.equal(res.status, 500);
    assert.equal(transfers.length, before);
    assert.equal(await prisma.disbursementItem.count({ where: { redemptionId: row.id } }), 0);
    assert.equal(await prisma.disbursementBatch.count({ where: { externalBatchId: `redemption:${row.id}` } }), 0);
    assert.equal((await rowsFor(row.id)).length, 0);
  });
});

describe('data request fulfilment', () => {
  let seller;
  let chosen;
  before(async () => {
    seller = await user('demand-seller', { organization: true });
    await kyc(seller.id);
    chosen = await pack('demand-pack', seller.id, 30);
  });

  async function buyerWithRequest(name) {
    const buyer = await user(name, { organization: true });
    await kyc(buyer.id);
    await deposit(buyer.id, 100);
    const demand = await demandService.createDemand(buyer.id, {
      category: 'mobility', region: 'SG', recordCount: 2, description: 'Two anonymised rows', bidUsd: 40,
    });
    return { buyer, demand };
  }

  it('fulfil: the purchase, the request, its event and one demand.fulfill row commit together; a repeat buys nothing', async () => {
    const { buyer, demand } = await buyerWithRequest('demand-buyer');
    const res = await post(`/demands/${demand.id}/fulfill`, auth.admin, { dataNFTId: chosen.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await prisma.dataDemand.findUnique({ where: { id: demand.id } });
    assert.equal(row.status, 'fulfilled');
    assert.ok(row.purchaseId && row.orderId);

    const again = await post(`/demands/${demand.id}/fulfill`, auth.admin, { dataNFTId: chosen.id });
    assert.equal(again.status, 400);
    assert.equal(await prisma.dataNFTPurchase.count({ where: { buyerId: buyer.id } }), 1);
    await settle();
    const rows = await rowsFor(demand.id);
    assert.deepEqual(rows.map((r) => [r.action, r.targetType]), [['demand.fulfill', 'demand']]);
    assert.equal(rows[0].detail.purchaseId, row.purchaseId);
    assert.equal(rows[0].detail.orderId, row.orderId);
    assert.equal(rows[0].detail.amount, 30);
  });

  it('fulfil: when the audit row is refused, nothing is bought and the request stays open', async () => {
    const { buyer, demand } = await buyerWithRequest('demand-buyer-refused');
    const res = await post(`/demands/${demand.id}/fulfill`, auth.refused, { dataNFTId: chosen.id });
    assert.equal(res.status, 500);
    assert.equal((await prisma.dataDemand.findUnique({ where: { id: demand.id } })).status, 'submitted');
    assert.equal(await prisma.dataNFTPurchase.count({ where: { buyerId: buyer.id } }), 0);
    assert.equal(await prisma.organizationTransaction.count({ where: { userId: buyer.id, type: 'WITHDRAW' } }), 0);
    assert.equal(await prisma.purchaseOrder.count({ where: { buyerId: buyer.id } }), 0);
    assert.equal((await rowsFor(demand.id)).length, 0);
  });
});

describe('raffle draw', () => {
  async function raffle(name, holderName) {
    const holder = await user(holderName);
    const now = Date.now();
    const campaign = await prisma.campaign.create({
      data: {
        slug: id(name),
        internalName: id(name),
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
        config: { prizes: [{ kind: 'POINTS', points: 50, count: 1, labelEn: 'Fifty points', labelZh: 'Fifty points' }] },
      },
    });
    await prisma.campaignRaffleTicket.create({ data: { campaignId: campaign.id, userId: holder.id, tickets: 1 } });
    return { campaign, holder };
  }

  it('draw: three draws at once never hand out more seats than the prizes have', async () => {
    const now = Date.now();
    const campaign = await prisma.campaign.create({
      data: {
        slug: id('raffle-race'),
        internalName: id('raffle-race'),
        titleEn: 'Raffle', titleZh: 'Raffle', blurbEn: 'Raffle', blurbZh: 'Raffle',
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
    for (let n = 0; n < 6; n += 1) {
      const holder = await user(`raffle-race-holder-${n}`);
      await prisma.campaignRaffleTicket.create({ data: { campaignId: campaign.id, userId: holder.id, tickets: 1 } });
    }
    const results = await Promise.all([1, 2, 3].map(() => post(`/campaigns/${campaign.id}/raffle/draw`, auth.admin)));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200], JSON.stringify(results.map((r) => r.body)));
    const wins = await prisma.campaignRaffleWin.findMany({ where: { campaignId: campaign.id } });
    assert.equal(wins.length, 2, 'two seats, two wins');
    assert.equal(new Set(wins.map((w) => w.userId)).size, 2, 'no one wins the same prize twice');
    assert.equal(await prisma.point.count({ where: { sourceId: { in: wins.map((w) => w.id) } } }), 2);
    await settle();
    const rows = await rowsFor(campaign.id);
    assert.equal(rows.reduce((sum, row) => sum + row.detail.wins, 0), 2);
  });

  it('draw: the win, its points and one raffle.draw row commit together; a refused row grants nothing', async () => {
    const { campaign, holder } = await raffle('raffle', 'raffle-holder');
    const res = await post(`/campaigns/${campaign.id}/raffle/draw`, auth.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await prisma.user.findUnique({ where: { id: holder.id } })).totalPoints, 50);
    await settle();
    const rows = await rowsFor(campaign.id);
    assert.deepEqual(rows.map((r) => [r.action, r.targetType, r.detail.wins, r.detail.pointsAwarded]), [['raffle.draw', 'campaign', 1, 50]]);

    const other = await raffle('raffle-refused', 'raffle-holder-refused');
    const refusedRes = await post(`/campaigns/${other.campaign.id}/raffle/draw`, auth.refused);
    assert.equal(refusedRes.status, 500);
    assert.equal((await prisma.user.findUnique({ where: { id: other.holder.id } })).totalPoints, 0);
    assert.equal(await prisma.campaignRaffleWin.count({ where: { campaignId: other.campaign.id } }), 0);
    assert.equal(await prisma.point.count({ where: { userId: other.holder.id } }), 0);
    assert.equal(await prisma.campaignEvent.count({ where: { campaignId: other.campaign.id } }), 0);
    assert.equal((await rowsFor(other.campaign.id)).length, 0);
    assert.equal(await genericRows(), 0);
  });
});
