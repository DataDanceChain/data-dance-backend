/**
 * The guards that keep payment decisions, merchant credits and procurement order attestations from
 * running twice, on the in-memory Prisma stand-in (the races themselves run on real Postgres in
 * test/db/noDoubleProcessingCommerce.dbtest.js):
 *   - a payment decision locks the invoice before it reads the payment, moves the payment only from
 *     'pending', and a decision another call made first after this call's read answers a repeat
 *     (nothing changed) or a 409, and moves neither the balance entry nor the invoice; a balance
 *     entry moves only from PENDING;
 *   - a merchant credit's Idempotency-Key is checked (8 to 128 of letters, digits . _ : -); a key a
 *     concurrent credit took (the database refuses the second row) answers that credit, or 409 when
 *     the amount or note differs;
 *   - a procurement order's chain attestation is claimed first: a live claim refuses the call (409)
 *     and sends nothing, a stale one is taken over, the claim is released when the result is stored
 *     or the chain call throws, and kept when storing fails after the chain call.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

const { installMockPrisma, matches } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

// attestHashOnChain runs the real implementation with fake chain deps, or `chainOverride` when set.
const realChain = require('../../src/utils/commerceAttestChain');
const { FakeChain } = require('../helpers/fakeAttestChain');

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

const commerceService = require('../../src/services/commerceService');
const procurementService = require('../../src/services/procurementService');
const opsCommerceController = require('../../src/controllers/opsCommerceController');

const stored = (model, id) => prisma[model].rows.find((r) => r.id === id);
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);

function useChain(chain) {
  deps = { provider: chain.provider, wallet: chain.wallet(), attester: chain.attester };
  return chain;
}

/**
 * Tables the stand-in lacks (invoices, balance entries), added on the prisma object for these
 * tests: reads by `where`, `create`, `update`, `updateMany`; `include` is not supported.
 */
function addTable(name) {
  const rows = (prisma.store[name] = prisma.store[name] || []);
  prisma[name] = {
    rows,
    findUnique: async ({ where }) => {
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    findMany: async ({ where } = {}) => rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    create: async ({ data }) => {
      if (name === 'organizationTransaction' && data.idempotencyKey
        && rows.some((r) => r.userId === data.userId && r.idempotencyKey === data.idempotencyKey)) {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`userId`,`idempotencyKey`)'), { code: 'P2002' });
      }
      const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`mock: ${name} record not found`);
      return { ...Object.assign(row, data) };
    },
    updateMany: async ({ where, data }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
}

describe('payment decisions', () => {
  let realPaymentFind;
  let realRaw;
  let calls;

  beforeEach(() => {
    prisma.reset();
    addTable('invoice');
    addTable('organizationTransaction');
    calls = [];
    // The stand-in's payment table has no relations: `include` answers the invoice (the only one
    // a decision reads) and leaves the others out.
    realPaymentFind = prisma.payment.findUnique;
    prisma.payment.findUnique = async ({ where, include, select }) => {
      calls.push(`read payment${include ? ' with invoice' : ''}${select ? ' ref' : ''}`);
      const row = await realPaymentFind({ where });
      if (row && include && include.invoice) {
        row.invoice = prisma.invoice.rows.find((inv) => inv.id === row.invoiceId) || null;
      }
      return row;
    };
    realRaw = prisma.$executeRaw;
    prisma.$executeRaw = async (strings, ...values) => {
      calls.push(`raw ${strings.join('?').trim()} [${values.join(',')}]`);
      return 1;
    };
  });

  afterEach(() => {
    prisma.payment.findUnique = realPaymentFind;
    prisma.$executeRaw = realRaw;
    delete prisma.invoice;
    delete prisma.organizationTransaction;
  });

  function seed({ status = 'pending', ledgerStatus = 'PENDING', withInvoice = false } = {}) {
    const order = { id: `order-${crypto.randomUUID()}`, status: 'invoiced', buyerId: 'buyer-1', sellerId: 'seller-1', total: 30 };
    prisma.purchaseOrder.rows.push(order);
    const invoice = withInvoice
      ? { id: `inv-${crypto.randomUUID()}`, orderId: order.id, status: 'issued', total: 30, paidAt: null }
      : null;
    if (invoice) prisma.invoice.rows.push(invoice);
    const ledger = { id: `ledger-${crypto.randomUUID()}`, userId: 'buyer-1', status: ledgerStatus, type: 'DEPOSIT', amount: 30, metadata: {} };
    prisma.organizationTransaction.rows.push(ledger);
    const payment = {
      id: `pay-${crypto.randomUUID()}`,
      orderId: order.id,
      invoiceId: invoice ? invoice.id : null,
      payerId: 'buyer-1',
      payeeId: 'seller-1',
      amount: 30,
      method: 'bank_transfer',
      status,
      matchStatus: 'unmatched',
      paidAt: null,
      notes: null,
      organizationTransactionId: ledger.id,
    };
    prisma.payment.rows.push(payment);
    // refreshInvoiceSettlement reads the invoice with its payments and order.
    const realInvoiceFind = prisma.invoice.findUnique;
    prisma.invoice.findUnique = async (args) => {
      const row = await realInvoiceFind(args);
      if (row && args.include) {
        row.payments = prisma.payment.rows.filter((p) => p.invoiceId === row.id).map((p) => ({ ...p }));
        row.order = { ...stored('purchaseOrder', row.orderId) };
      }
      return row;
    };
    return { order, invoice, ledger, payment };
  }

  /** Another call decides the payment (`status`) just before this call's conditional update. */
  function decidedMeanwhile(paymentId, status) {
    const real = prisma.payment.updateMany;
    prisma.payment.updateMany = async (args) => {
      prisma.payment.updateMany = real;
      stored('payment', paymentId).status = status;
      return real(args);
    };
  }

  it('locks the invoice inside the transaction before it reads the payment it decides', async () => {
    const { payment, invoice } = seed({ withInvoice: true });
    const realTx = prisma.$transaction;
    prisma.$transaction = async (fn) => {
      calls.push('begin');
      const result = await realTx.call(prisma, fn);
      calls.push('commit');
      return result;
    };
    try {
      const { changed } = await commerceService.confirmPaymentByOps(payment.id, 'ops-1');
      assert.equal(changed, true);
    } finally {
      prisma.$transaction = realTx;
    }
    assert.deepEqual(calls.slice(0, 4), [
      'begin',
      'read payment ref',
      `raw SELECT 1 FROM "Invoice" WHERE id = ? FOR UPDATE [${invoice.id}]`,
      'read payment with invoice',
    ]);
    assert.ok(calls.indexOf('commit') > 3);
    assert.equal(stored('invoice', invoice.id).status, 'paid');
  });

  it('a reject that loses to a confirm made after its read answers 409 PAYMENT_ALREADY_CONFIRMED and moves neither the entry nor the invoice', async () => {
    const { payment, ledger, invoice } = seed({ withInvoice: true });
    decidedMeanwhile(payment.id, 'confirmed');
    await assert.rejects(commerceService.rejectPaymentByOps(payment.id, 'too late', 'ops-1'), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'PAYMENT_ALREADY_CONFIRMED');
      return true;
    });
    assert.equal(stored('payment', payment.id).notes, null);
    assert.equal(stored('organizationTransaction', ledger.id).status, 'PENDING');
    assert.deepEqual(stored('organizationTransaction', ledger.id).metadata, {});
    assert.equal(stored('invoice', invoice.id).status, 'issued');
  });

  it('a confirm that loses to a reject made after its read answers 409 payment_not_pending and moves nothing', async () => {
    const { payment, ledger } = seed();
    decidedMeanwhile(payment.id, 'rejected');
    await assert.rejects(commerceService.confirmPaymentByOps(payment.id, 'ops-1'), { statusCode: 409, code: 'payment_not_pending' });
    assert.equal(stored('payment', payment.id).paidAt, null);
    assert.equal(stored('organizationTransaction', ledger.id).status, 'PENDING');
  });

  it('a confirm that loses to another confirm answers the payment unchanged (changed: false); a lost reject to a reject the same', async () => {
    const first = seed();
    decidedMeanwhile(first.payment.id, 'confirmed');
    const { changed } = await commerceService.confirmPaymentByOps(first.payment.id, 'ops-1');
    assert.equal(changed, false);
    assert.equal(stored('organizationTransaction', first.ledger.id).status, 'PENDING', 'the winner moves the entry, not this call');

    const second = seed();
    decidedMeanwhile(second.payment.id, 'rejected');
    await commerceService.rejectPaymentByOps(second.payment.id, 'mine', 'ops-1');
    assert.equal(stored('payment', second.payment.id).notes, null);
    assert.deepEqual(stored('organizationTransaction', second.ledger.id).metadata, {});
  });

  it('the balance entry moves only from PENDING', async () => {
    const { payment, ledger } = seed({ ledgerStatus: 'COMPLETED' });
    await commerceService.rejectPaymentByOps(payment.id, 'slip does not match', 'ops-1');
    assert.equal(stored('payment', payment.id).status, 'rejected');
    assert.equal(stored('organizationTransaction', ledger.id).status, 'COMPLETED', 'a completed entry is never failed');
  });

  it('the payee path answers the same outcomes: a repeat confirm is unchanged, a reject of a confirmed payment is 409', async () => {
    const { payment } = seed();
    const seller = { id: 'seller-1' };
    const first = await commerceService.confirmPayment(seller, payment.id);
    assert.equal(first.changed, true);
    assert.equal(stored('payment', payment.id).status, 'confirmed');
    const again = await commerceService.confirmPayment(seller, payment.id);
    assert.equal(again.changed, false);
    await assert.rejects(commerceService.rejectPayment(seller, payment.id, 'no'), { statusCode: 409, code: 'PAYMENT_ALREADY_CONFIRMED' });
    assert.equal(stored('payment', payment.id).status, 'confirmed');
  });

  it('the ops route answers a refused decision with its code', async () => {
    const { payment } = seed({ status: 'confirmed' });
    const res = fakeRes();
    await opsCommerceController.rejectPayment({ opsAdmin: { username: 'ops-1' }, params: { id: payment.id }, body: {} }, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, {
      status: 'fail',
      code: 'PAYMENT_ALREADY_CONFIRMED',
      message: 'This payment is already confirmed and cannot be rejected.',
    });
  });
});

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

describe('merchant credit Idempotency-Key', () => {
  const merchant = { id: 'merchant-1', isOrganization: true };

  beforeEach(() => {
    prisma.reset();
    addTable('organizationTransaction');
    prisma.user.rows.push({ ...merchant });
  });

  afterEach(() => {
    delete prisma.organizationTransaction;
  });

  // The audit rows the credit writes in its transaction (#55's req.auditChange, mounted by the
  // ops router on this route).
  let audits;
  beforeEach(() => { audits = []; });

  function creditReq(body, key) {
    return {
      params: { userId: merchant.id },
      body,
      opsAdmin: { kind: 'shared', username: 'shared', role: 'shared' },
      auditChange: async (tx, entry) => { audits.push(entry); return { id: `audit-${audits.length}` }; },
      get: (name) => (name.toLowerCase() === 'idempotency-key' ? key : undefined),
    };
  }

  async function credit(body, key) {
    const res = fakeRes();
    await opsCommerceController.creditMerchant(creditReq(body, key), res);
    return res;
  }

  it('accepts 8 to 128 letters, digits, dots, colons, dashes and underscores (trimmed); anything else is 400 and credits nothing', async () => {
    for (const key of ['abcd1234', 'a.b_c:d-e', ` ${'k'.repeat(128)} `, crypto.randomUUID()]) {
      const res = await credit({ amount: 1, note: 'goodwill credit' }, key);
      assert.equal(res.statusCode, 200, `${key}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.transaction.idempotencyKey, key.trim());
    }
    for (const key of ['abc1234', 'k'.repeat(129), 'with space', 'slash/key1', 'quote"key1', '   ']) {
      const res = await credit({ amount: 1, note: 'goodwill credit' }, key);
      assert.equal(res.statusCode, 400, key);
      assert.equal(res.body.code, 'INVALID_IDEMPOTENCY_KEY');
    }
    assert.equal(prisma.organizationTransaction.rows.length, 4);
    assert.deepEqual(
      audits.map((entry) => entry.detail.organizationTransactionId),
      prisma.organizationTransaction.rows.map((row) => row.id),
      'one audit row per credit, none for a refused key',
    );
  });

  it('no key (absent or empty) writes a row without one, every time', async () => {
    for (const key of [undefined, '', undefined, '']) {
      const res = await credit({ amount: 2, note: 'goodwill credit' }, key);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.replayed, undefined);
    }
    assert.deepEqual(prisma.organizationTransaction.rows.map((r) => r.idempotencyKey), [null, null, null, null]);
  });

  it('a key a concurrent credit took after this call\'s lookup (the database refuses the row) answers that credit, replayed', async () => {
    const key = 'concurrent-key-1';
    const realFind = prisma.organizationTransaction.findUnique;
    let lookups = 0;
    prisma.organizationTransaction.findUnique = async (args) => {
      lookups += 1;
      const row = await realFind(args);
      // The other request writes its row right after this call's first lookup.
      if (lookups === 1) {
        prisma.organizationTransaction.rows.push({
          id: 'theirs', userId: merchant.id, amount: 5, description: 'goodwill credit', type: 'DEPOSIT', status: 'COMPLETED', idempotencyKey: key,
        });
      }
      return row;
    };
    const res = await credit({ amount: 5, note: 'goodwill credit' }, key);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.replayed, true);
    assert.equal(res.body.data.transaction.id, 'theirs');
    assert.equal(lookups, 2, 'looked up again after the database refused the row');
    assert.equal(prisma.organizationTransaction.rows.length, 1);
    assert.equal(audits.length, 0, 'a replay writes no audit row');
  });

  it('the same race with another amount answers 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const key = 'concurrent-key-2';
    const realFind = prisma.organizationTransaction.findUnique;
    let lookups = 0;
    prisma.organizationTransaction.findUnique = async (args) => {
      lookups += 1;
      const row = await realFind(args);
      if (lookups === 1) {
        prisma.organizationTransaction.rows.push({
          id: 'theirs', userId: merchant.id, amount: 6, description: 'goodwill credit', type: 'DEPOSIT', status: 'COMPLETED', idempotencyKey: key,
        });
      }
      return row;
    };
    const res = await credit({ amount: 5, note: 'goodwill credit' }, key);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(prisma.organizationTransaction.rows.length, 1);
  });

  it('any other failure to write is passed on (500), also a unique violation with no row holding the key', async () => {
    prisma.organizationTransaction.create = async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    };
    const res = await credit({ amount: 5, note: 'goodwill credit' }, 'orphan-key-1');
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { status: 'error', message: 'Server error' });
  });
});

describe('procurement order attestation claim', () => {
  const BUYER = { id: 'buyer-1' };

  beforeEach(() => {
    prisma.reset();
    chainOverride = null;
  });

  function seedOrder(over = {}) {
    const row = {
      id: `order-${crypto.randomUUID()}`,
      orderNumber: `PO-T-${Math.random().toString(36).slice(2, 8)}`,
      buyerId: BUYER.id,
      sellerId: 'seller-1',
      status: 'paid',
      currency: 'USD',
      subtotal: 10,
      taxAmount: 0,
      total: 10,
      serviceFeeAmount: 0,
      dataNFTId: null,
      purchaseId: null,
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

  const attest = (orderId) => procurementService.attestOrder(BUYER, orderId);

  for (const minutes of [1, 14]) {
    it(`a claim ${minutes} minute(s) old refuses the call (409 ATTESTATION_IN_FLIGHT) and sends and writes nothing`, async () => {
      const chain = useChain(new FakeChain());
      const claimedAt = minutesAgo(minutes);
      const order = seedOrder({ attestationClaimedAt: claimedAt });
      await assert.rejects(attest(order.id), (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'ATTESTATION_IN_FLIGHT');
        return true;
      });
      assert.equal(chain.sent.length, 0);
      const row = stored('purchaseOrder', order.id);
      assert.equal(row.attestationHash, null);
      assert.equal(row.attestationPayload, null);
      assert.equal(row.attestationClaimedAt.getTime(), claimedAt.getTime());
    });
  }

  it('a claim older than 15 minutes is taken over; the attestation is sent once and the claim released', async () => {
    const chain = useChain(new FakeChain());
    const order = seedOrder({ attestationClaimedAt: minutesAgo(16) });
    const result = await attest(order.id);
    assert.equal(chain.sent.length, 1);
    assert.match(String(result.attestationTxHash), /^0x[0-9a-f]{64}$/);
    const row = stored('purchaseOrder', order.id);
    assert.equal(row.attestationTxHash, result.attestationTxHash);
    assert.equal(row.attestationPayload.type, 'datadance.procurement.metadata.v1');
    assert.equal(row.attestationClaimedAt, null);
  });

  it('claims before the chain call; a chain call that throws releases the claim, stores nothing and passes the error on', async () => {
    const order = seedOrder();
    chainOverride = async () => {
      assert.ok(stored('purchaseOrder', order.id).attestationClaimedAt instanceof Date, 'claimed before the chain call');
      throw new Error('signer unavailable');
    };
    await assert.rejects(attest(order.id), /signer unavailable/);
    const row = stored('purchaseOrder', order.id);
    assert.equal(row.attestationClaimedAt, null);
    assert.equal(row.attestationHash, null);
    assert.equal(row.attestationTxHash, null);
  });

  it('an order another call attested between this call\'s read and its claim is not sent again', async () => {
    const chain = useChain(new FakeChain());
    const order = seedOrder();
    const realUpdateMany = prisma.purchaseOrder.updateMany;
    prisma.purchaseOrder.updateMany = async (args) => {
      // The other call stores its tx hash just before this call's claim.
      prisma.purchaseOrder.updateMany = realUpdateMany;
      stored('purchaseOrder', order.id).attestationTxHash = `0x${'12'.repeat(32)}`;
      return realUpdateMany(args);
    };
    await assert.rejects(attest(order.id), { code: 'ATTESTATION_IN_FLIGHT' });
    assert.equal(chain.sent.length, 0);
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, `0x${'12'.repeat(32)}`);
    assert.equal(stored('purchaseOrder', order.id).attestationClaimedAt, null);
  });

  it('a tx hash another path stores during the chain call is kept, and the claim released', async () => {
    const order = seedOrder();
    const theirs = `0x${'34'.repeat(32)}`;
    chainOverride = async () => {
      stored('purchaseOrder', order.id).attestationTxHash = theirs;
      return { ok: true, txHash: `0x${'56'.repeat(32)}` };
    };
    const result = await attest(order.id);
    assert.equal(result.attestationTxHash, theirs);
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, theirs);
    assert.equal(stored('purchaseOrder', order.id).attestationClaimedAt, null);
  });

  it('a store that fails after the chain call keeps the claim, so no call sends again until it is stale', async () => {
    const chain = useChain(new FakeChain());
    const order = seedOrder();
    const realUpdateMany = prisma.purchaseOrder.updateMany;
    prisma.purchaseOrder.updateMany = async (args) => {
      if (args.data && args.data.attestationHash !== undefined) throw new Error('connection lost while storing');
      return realUpdateMany(args);
    };
    try {
      await assert.rejects(attest(order.id), /connection lost/);
    } finally {
      prisma.purchaseOrder.updateMany = realUpdateMany;
    }
    assert.equal(chain.sent.length, 1);
    assert.ok(stored('purchaseOrder', order.id).attestationClaimedAt instanceof Date, 'the claim stays');
    await assert.rejects(attest(order.id), { code: 'ATTESTATION_IN_FLIGHT' });
    assert.equal(chain.sent.length, 1, 'nothing is sent again');
  });

  it('a failed chain call on an order holding a value that is not a tx hash clears it, and the next call sends', async () => {
    const order = seedOrder({ attestationTxHash: 'a1b2c3d4' });
    chainOverride = async () => ({ ok: false, reason: 'rpc unavailable' });
    const failed = await attest(order.id);
    assert.equal(failed.attestationTxHash, null);
    assert.equal(stored('purchaseOrder', order.id).attestationClaimedAt, null);
    chainOverride = null;
    const chain = useChain(new FakeChain());
    const retried = await attest(order.id);
    assert.equal(chain.sent.length, 1);
    assert.match(String(retried.attestationTxHash), /^0x[0-9a-f]{64}$/);
  });

  it('a chain answer that is not a tx hash is not stored as one: the claim is released and the next call sends', async () => {
    const order = seedOrder();
    chainOverride = async () => ({ ok: true, txHash: 'not-a-tx-hash' });
    const first = await attest(order.id);
    assert.equal(first.attestationTxHash, null);
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, null);
    assert.equal(stored('purchaseOrder', order.id).attestationClaimedAt, null);
    chainOverride = null;
    const chain = useChain(new FakeChain());
    const retried = await attest(order.id);
    assert.equal(chain.sent.length, 1);
    assert.match(String(retried.attestationTxHash), /^0x[0-9a-f]{64}$/);
  });

  it('an order with a stored attestation tx hash is not claimed and not sent', async () => {
    const chain = useChain(new FakeChain());
    const claimedAt = minutesAgo(1);
    const order = seedOrder({ attestationTxHash: `0x${'ef'.repeat(32)}`, attestationClaimedAt: claimedAt });
    const result = await attest(order.id);
    assert.equal(chain.sent.length, 0);
    assert.equal(result.attestationTxHash, `0x${'ef'.repeat(32)}`);
    assert.equal(stored('purchaseOrder', order.id).attestationClaimedAt.getTime(), claimedAt.getTime());
  });
});
