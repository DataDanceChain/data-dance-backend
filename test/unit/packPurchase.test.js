/**
 * src/services/packPurchase.js (purchasePublishedPack), the purchase path production moved out of
 * dataNFTController so that buyer data-request fulfilment can reuse it, and the controller's mapping of
 * its result and errors to HTTP. In-memory Prisma (test/helpers/demandPrisma.js); the commerce order
 * and the chain attestation are stubbed, the licence-consent check is the real one.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  installDemandPrisma, resetDemandStore, seedMerchant, seedUser, seedPack, seedBalance,
} = require('../helpers/demandPrisma');

const prisma = installDemandPrisma();

const commerceService = require('../../src/services/commerceService');
const commerceAttest = require('../../src/services/commerceAttest');

const orderCalls = [];
const attestCalls = [];
let attestResult = null;
commerceService.createOrderFromPurchase = async (db, args) => {
  orderCalls.push({ db, args });
  const n = orderCalls.length;
  return {
    order: {
      id: `order-${n}`,
      orderNumber: `PO-TEST-${n}`,
      status: 'paid',
      attestationHash: null,
      attestationTxHash: null,
      attestationPayload: { receipt: 'internal' },
    },
    invoice: { id: `invoice-${n}`, total: args.totalAmount },
    payment: { id: `payment-${n}`, amount: args.totalAmount },
  };
};
commerceAttest.attestPaidOrderSafe = async (orderId) => {
  attestCalls.push(orderId);
  return attestResult;
};

const { purchasePublishedPack, SUBJECT_CONSENT_ERROR } = require('../../src/services/packPurchase');
const { purchaseDataNFT } = require('../../src/controllers/dataNFTController');

let buyer;
let seller;

beforeEach(async () => {
  resetDemandStore(prisma);
  orderCalls.length = 0;
  attestCalls.length = 0;
  attestResult = null;
  buyer = await seedMerchant(prisma);
  seller = await seedMerchant(prisma);
});

async function rejects(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode, `${code}: ${error.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

const ledger = () => prisma.organizationTransaction.rows.filter((row) => row.metadata);

describe('purchasePublishedPack: refusals (nothing is written)', () => {
  it('404 pack_not_found', async () => {
    await rejects(purchasePublishedPack({ buyerId: buyer.id, dataNFTId: 'missing' }), 404, 'pack_not_found');
  });

  it('400 pack_not_published', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, isPublished: false });
    await seedBalance(prisma, buyer.id, 100);
    await rejects(purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id }), 400, 'pack_not_published');
  });

  it('403 subject_consent_required for an upload pack without records', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, records: 0 });
    await seedBalance(prisma, buyer.id, 100);
    await assert.rejects(purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id }), (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'subject_consent_required');
      assert.equal(error.message, SUBJECT_CONSENT_ERROR);
      return true;
    });
  });

  it('403 subject_consent_required for an activity pack whose people have not consented', async () => {
    const subject = await seedUser(prisma);
    const pack = await seedPack(prisma, {
      merchantId: seller.id,
      dataSource: 'activity',
      dataRecords: { records: [{ userId: subject.id, steps: 1 }] },
    });
    await seedBalance(prisma, buyer.id, 100);
    await rejects(purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id }), 403, 'subject_consent_required');
  });

  it('403 own_pack', async () => {
    const pack = await seedPack(prisma, { merchantId: buyer.id });
    await seedBalance(prisma, buyer.id, 100);
    await rejects(purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id }), 403, 'own_pack');
  });

  it('403 org_buyer_required for a regular account', async () => {
    const person = await seedUser(prisma);
    const pack = await seedPack(prisma, { merchantId: seller.id });
    await seedBalance(prisma, person.id, 100);
    await rejects(purchasePublishedPack({ buyerId: person.id, dataNFTId: pack.id }), 403, 'org_buyer_required');
  });

  it('400 insufficient_balance: completed deposits minus completed withdrawals must cover price x quantity', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 10 });
    await seedBalance(prisma, buyer.id, 25);
    await prisma.organizationTransaction.create({ data: { userId: buyer.id, amount: 100, type: 'DEPOSIT', status: 'PENDING' } });
    await prisma.organizationTransaction.create({ data: { userId: buyer.id, amount: 6, type: 'WITHDRAW', status: 'COMPLETED' } });
    await rejects(purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id, quantity: 2 }), 400, 'insufficient_balance');
  });

  it('writes nothing when it refuses', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 10 });
    await rejects(purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id }), 400, 'insufficient_balance');
    assert.equal(prisma.dataNFTPurchase.rows.length, 0);
    assert.equal(ledger().length, 0);
    assert.equal(orderCalls.length, 0);
    assert.equal(attestCalls.length, 0);
  });
});

describe('purchasePublishedPack: a purchase', () => {
  it('records the licence, moves the money, creates the order and attests it', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 12.5 });
    await seedBalance(prisma, buyer.id, 100);
    const out = await purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id, quantity: '2', metadata: { demandId: 'demand-1' } });

    assert.equal(out.quantity, 2);
    assert.equal(out.totalAmount, 25);
    assert.equal(out.packPrice, 12.5);
    assert.equal(out.purchaseCount, 1);
    assert.equal(out.purchase.dataNFTId, pack.id);
    assert.equal(out.purchase.buyerId, buyer.id);
    assert.equal(out.purchase.quantity, 2);
    assert.equal(out.purchase.dataNFT.id, pack.id, 'the purchase comes back with its pack');

    const rows = ledger();
    const credit = rows.find((row) => row.userId === seller.id);
    const debit = rows.find((row) => row.userId === buyer.id);
    assert.deepEqual([credit.type, credit.status, credit.amount], ['DEPOSIT', 'COMPLETED', 25]);
    assert.deepEqual([debit.type, debit.status, debit.amount], ['WITHDRAW', 'COMPLETED', 25]);
    assert.deepEqual(credit.metadata, { dataNFTId: pack.id, buyerId: buyer.id, purchaseCount: 1, quantity: 2, demandId: 'demand-1' });
    assert.deepEqual(debit.metadata, { dataNFTId: pack.id, merchantId: seller.id, purchaseCount: 1, quantity: 2, demandId: 'demand-1' });
    assert.match(debit.description, /^Purchase DataNFT: .* \(Purchase #1, quantity: 2\)$/);

    assert.equal(orderCalls.length, 1);
    const { args } = orderCalls[0];
    assert.equal(args.buyerId, buyer.id);
    assert.equal(args.sellerId, seller.id);
    assert.equal(args.totalAmount, 25);
    assert.equal(args.quantity, 2);
    assert.equal(args.paidFromBalance, true);
    assert.equal(args.organizationTransactionId, debit.id);
    assert.equal(args.purchase.id, out.purchase.id);

    assert.deepEqual(attestCalls, ['order-1']);
    assert.equal(out.order.id, 'order-1');
    assert.equal(out.order.attestationPayload, undefined, 'the receipt payload stays server-side');
    assert.equal(out.attestation.attested, false);
    assert.equal(out.invoice.id, 'invoice-1');
    assert.equal(out.payment.id, 'payment-1');
  });

  it('a quantity that is missing, zero, negative or not a number counts as 1', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 1 });
    await seedBalance(prisma, buyer.id, 100);
    for (const quantity of [undefined, 0, -3, 'abc']) {
      const out = await purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id, quantity });
      assert.equal(out.quantity, 1, `quantity ${String(quantity)}`);
      assert.equal(out.totalAmount, 1);
    }
  });

  it('counts the buyer\'s earlier purchases of the same pack', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 1 });
    await seedBalance(prisma, buyer.id, 10);
    await purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id });
    const second = await purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id });
    assert.equal(second.purchaseCount, 2);
  });

  it('reports a confirmed attestation from the attest step', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 1 });
    await seedBalance(prisma, buyer.id, 10);
    const hash = crypto.randomBytes(32).toString('hex');
    const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
    attestResult = { attestationHash: hash, attestationTxHash: txHash, attestedAt: new Date() };
    const out = await purchasePublishedPack({ buyerId: buyer.id, dataNFTId: pack.id });
    assert.equal(out.attestation.attestationHash, hash);
    assert.equal(out.attestation.attestationTxHash, txHash);
    assert.equal(out.order.attestationTxHash, txHash);
  });
});

describe('dataNFTController.purchaseDataNFT over packPurchase', () => {
  function call(user, id, body = {}) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      };
      purchaseDataNFT({ user, params: { id }, body }, res);
    });
  }

  it('answers 201 with the purchase and its order, invoice, payment and attestation', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 4 });
    await seedBalance(prisma, buyer.id, 10);
    const res = await call(buyer, pack.id, { quantity: 2 });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'success');
    assert.equal(res.body.dataNFTId, pack.id);
    assert.equal(res.body.quantity, 2);
    assert.equal(res.body.purchaseCount, 1);
    assert.equal(res.body.order.id, 'order-1');
    assert.equal(res.body.order.attestationPayload, undefined);
    assert.equal(res.body.invoice.id, 'invoice-1');
    assert.equal(res.body.payment.id, 'payment-1');
    assert.equal(typeof res.body.attestation.attested, 'boolean');
  });

  for (const [label, setup, status, code] of [
    ['an unknown pack', async () => 'missing', 404, 'pack_not_found'],
    ['an unpublished pack', async () => (await seedPack(prisma, { merchantId: seller.id, isPublished: false })).id, 400, 'pack_not_published'],
    ['the buyer\'s own pack', async () => (await seedPack(prisma, { merchantId: buyer.id })).id, 403, 'own_pack'],
    ['a balance that is too low', async () => (await seedPack(prisma, { merchantId: seller.id, price: 1000 })).id, 400, 'insufficient_balance'],
  ]) {
    it(`maps ${label} to ${status} with code ${code}`, async () => {
      const id = await setup();
      const res = await call(buyer, id);
      assert.equal(res.status, status);
      assert.equal(res.body.status, 'fail');
      assert.equal(res.body.code, code);
      assert.equal(res.body.error, res.body.message);
    });
  }

  it('answers 500 with a fixed message, without internals, when something unexpected fails', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 1 });
    await seedBalance(prisma, buyer.id, 10);
    const original = prisma.dataNFTPurchase.count;
    const originalError = console.error;
    prisma.dataNFTPurchase.count = async () => { throw new Error('connection reset by peer'); };
    console.error = () => {};
    try {
      const res = await call(buyer, pack.id);
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: 'Failed to purchase DataNFT' });
    } finally {
      prisma.dataNFTPurchase.count = original;
      console.error = originalError;
    }
  });
});
