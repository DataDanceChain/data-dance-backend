/**
 * The flows that call attestHashOnChain store a tx hash only when the receipt proves the
 * attestation, and never throw because of the chain: licence orders (commerceAttest), procurement
 * orders (procurementService.attestOrder) and disbursement items (disbursement processItem).
 * In-memory Prisma, fake chain; the real attestHashOnChain runs with injected provider and wallet.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

const realChain = require('../../src/utils/commerceAttestChain');
const {
  FakeChain, randomAddress, randomHash, contentHash, makeReceipt, attestedLog,
} = require('../helpers/fakeAttestChain');

// Route every attestHashOnChain call through the real implementation with fake chain deps.
let deps = null;
const chainFile = require.resolve(path.join(__dirname, '../../src/utils/commerceAttestChain.js'));
require.cache[chainFile] = {
  id: chainFile,
  filename: chainFile,
  loaded: true,
  children: [],
  exports: {
    ...realChain,
    attestHashOnChain: (hash) => realChain.attestHashOnChain(hash, { ...deps, log: { warn() {} } }),
    verifySubmittedAttestation: (txHash, hash) => realChain.verifySubmittedAttestation(txHash, hash, deps),
  },
};

const commerceAttest = require('../../src/services/commerceAttest');
const procurementService = require('../../src/services/procurementService');
const commerceController = require('../../src/controllers/commerceController');
const opsCommerceController = require('../../src/controllers/opsCommerceController');
const disbursement = require('../../src/services/disbursement/service');

const SELLER = 'seller-1';
const BUYER = 'buyer-1';

function useChain(chain) {
  deps = { provider: chain.provider, wallet: chain.wallet(), attester: chain.attester };
  return chain;
}

function seedOrder(over = {}) {
  const row = {
    id: `order-${Math.random().toString(36).slice(2)}`,
    orderNumber: `PO-T-${Math.random().toString(36).slice(2, 8)}`,
    buyerId: BUYER,
    sellerId: SELLER,
    status: 'confirmed',
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
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
  prisma.purchaseOrder.rows.push(row);
  return row;
}

function seedPayout(over = {}) {
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
    status: 'confirmed',
    txHash: `0x${'ab'.repeat(32)}`,
    confirmedAt: new Date('2026-10-01T00:00:00Z'),
    attestationHash: null,
    attestationTxHash: null,
    attestedAt: null,
    failureReason: null,
    redemptionId: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
  prisma.disbursementItem.rows.push(row);
  return row;
}

const stored = (model, id) => prisma[model].rows.find((r) => r.id === id);

describe('licence orders (commerceAttest)', () => {
  beforeEach(() => prisma.reset());

  it('stores the tx hash when the receipt proves the attestation', async () => {
    const chain = useChain(new FakeChain());
    const order = seedOrder({ purchaseId: 'purchase-1' });
    const result = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(result.chainPending, false);
    assert.equal(result.attestationStatus, 'on_chain');
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, result.attestationTxHash);
    assert.ok(chain.receipts.has(result.attestationTxHash.toLowerCase()));
  });

  it('stores no tx hash when the attester has no code, and reports the reason', async () => {
    useChain(new FakeChain({ withCode: false }));
    const order = seedOrder({ purchaseId: 'purchase-2' });
    const result = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(result.chainPending, true);
    assert.match(result.chainReason, /no contract code/);
    assert.equal(result.attestationStatus, 'recorded');
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, null);
    assert.match(stored('purchaseOrder', order.id).attestationHash, /^[0-9a-f]{64}$/);
  });

  it('stores no tx hash when the mined call emitted no Attested log', async () => {
    const chain = new FakeChain();
    useChain(chain);
    // The wallet "sends" to an address that has no code: mined, status 1, zero logs.
    const elsewhere = randomAddress();
    deps.wallet = chain.wallet(randomAddress(), (tx) => {
      const txHash = chain.mineAttest({ hash: tx.hash, sender: tx.from, to: elsewhere });
      return { txHash, receipt: chain.receipts.get(txHash.toLowerCase()) };
    });
    const order = seedOrder({ purchaseId: 'purchase-3' });
    const result = await commerceAttest.attestPaidOrder(order.id);
    assert.equal(result.chainPending, true);
    assert.match(result.chainReason, /no logs/);
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, null);
  });

  it('attestPaidOrderSafe does not throw when the RPC is down', async () => {
    const chain = useChain(new FakeChain());
    chain.failures.getBlockNumber = new Error('connect ECONNREFUSED');
    const order = seedOrder({ purchaseId: 'purchase-4' });
    const result = await commerceAttest.attestPaidOrderSafe(order.id);
    assert.ok(result, 'the purchase flow gets a result, not an exception');
    assert.equal(result.chainPending, true);
    assert.equal(stored('purchaseOrder', order.id).attestationTxHash, null);
  });
});

describe('procurement orders (procurementService.attestOrder)', () => {
  beforeEach(() => prisma.reset());

  it('stores the tx hash only with a proving receipt', async () => {
    useChain(new FakeChain());
    const good = seedOrder();
    const ok = await procurementService.attestOrder({ id: SELLER }, good.id);
    assert.match(String(ok.attestationTxHash), /^0x[0-9a-f]{64}$/);

    useChain(new FakeChain({ withCode: false }));
    const bad = seedOrder();
    const pending = await procurementService.attestOrder({ id: SELLER }, bad.id);
    assert.equal(pending.attestationTxHash, null);
    assert.equal(pending.attestationStatus, 'recorded');
    assert.equal(stored('purchaseOrder', bad.id).attestationTxHash, null);
  });
});

describe('disbursement items (processItem)', () => {
  beforeEach(() => prisma.reset());

  it('keeps attestationTxHash empty and records the reason when the attestation is not proven', async () => {
    useChain(new FakeChain({ withCode: false }));
    const item = seedPayout();
    const result = await disbursement.processItem(item.id);
    assert.equal(result.attestationTxHash, null);
    assert.match(String(result.failureReason), /no contract code/);
    assert.equal(stored('disbursementItem', item.id).status, 'confirmed', 'the payout itself is untouched');
  });

  it('stores the tx hash when the receipt proves the attestation', async () => {
    useChain(new FakeChain());
    const item = seedPayout();
    const result = await disbursement.processItem(item.id);
    assert.match(String(result.attestationTxHash), /^0x[0-9a-f]{64}$/);
    assert.equal(result.failureReason, null);
  });
});

/*
 * POST /commerce/orders/:id/attest and POST /ops/orders/:id/attest accept a caller-supplied
 * txHash. It is stored only when the chain proves it: status 1 and an Attested log from the
 * configured attester for exactly the order's attestationHash (any sender). Otherwise 422 (or 503
 * when the chain cannot be asked) and nothing is stored.
 */
const PATHS = {
  licence: {
    seed: () => seedOrder({ purchaseId: `purchase-${Math.random().toString(36).slice(2)}` }),
    attest: (orderId, txHash) => commerceAttest.attestPaidOrder(orderId, { txHash }),
  },
  'licence via /commerce route (procurementService)': {
    seed: () => seedOrder({ purchaseId: `purchase-${Math.random().toString(36).slice(2)}` }),
    attest: (orderId, txHash) => procurementService.attestOrder({ id: SELLER }, orderId, { txHash }),
  },
  procurement: {
    seed: () => seedOrder(),
    attest: (orderId, txHash) => procurementService.attestOrder({ id: BUYER }, orderId, { txHash }),
  },
};

/** Records the order's attestationHash with no tx (attester without code), then returns it. */
async function primed(p) {
  useChain(new FakeChain({ withCode: false }));
  const order = p.seed();
  await p.attest(order.id);
  const row = stored('purchaseOrder', order.id);
  assert.match(row.attestationHash, /^[0-9a-f]{64}$/);
  assert.equal(row.attestationTxHash, null);
  const chain = useChain(new FakeChain());
  return { order, chain, hash: row.attestationHash, before: structuredClone(row) };
}

async function assertRejected(p, orderId, txHash, before, statusCode, code) {
  await assert.rejects(p.attest(orderId, txHash), (error) => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    assert.match(error.message, /nothing was saved|txHash must be/);
    return true;
  });
  assert.deepEqual(stored('purchaseOrder', orderId), before, 'nothing stored');
}

for (const [label, p] of Object.entries(PATHS)) {
  describe(`submitted txHash is verified before it is stored: ${label}`, () => {
    beforeEach(() => prisma.reset());

    it('stores a proving tx sent from the org\'s own wallet and records the sender', async () => {
      const { order, chain, hash } = await primed(p);
      const orgWallet = randomAddress();
      const txHash = chain.mineAttest({ hash, sender: orgWallet });
      const result = await p.attest(order.id, ` ${txHash} `);
      assert.equal(result.attestationTxHash, txHash);
      assert.equal(result.attestationStatus, 'on_chain');
      assert.equal(result.attestationSender, orgWallet);
      assert.equal(stored('purchaseOrder', order.id).attestationTxHash, txHash);
      assert.equal(chain.sent.length, 0, 'a submitted hash never triggers a backend send');
    });

    it('422 ATTESTATION_TX_NOT_FOUND for a hash the chain does not know', async () => {
      const { order, before } = await primed(p);
      await assertRejected(p, order.id, `0x${'ab'.repeat(32)}`, before, 422, 'ATTESTATION_TX_NOT_FOUND');
    });

    it('422 ATTESTATION_TX_FAILED for a reverted transaction, even with a matching log', async () => {
      const { order, chain, hash, before } = await primed(p);
      const sender = randomAddress();
      const txHash = randomHash();
      chain.mine(makeReceipt({
        txHash, from: sender, to: chain.attester, status: 0,
        logs: [attestedLog({ attester: chain.attester, hash, sender, txHash })],
      }));
      await assertRejected(p, order.id, txHash, before, 422, 'ATTESTATION_TX_FAILED');
    });

    it('422 ATTESTATION_TX_NOT_ATTESTED for a call to an address without code (no logs)', async () => {
      const { order, chain, hash, before } = await primed(p);
      const txHash = chain.mineAttest({ hash, sender: randomAddress(), to: randomAddress() });
      await assertRejected(p, order.id, txHash, before, 422, 'ATTESTATION_TX_NOT_ATTESTED');
    });

    it('422 ATTESTATION_TX_NOT_ATTESTED for a valid attestation of a different hash', async () => {
      const { order, chain, before } = await primed(p);
      const txHash = chain.mineAttest({ hash: contentHash(), sender: randomAddress() });
      await assertRejected(p, order.id, txHash, before, 422, 'ATTESTATION_TX_NOT_ATTESTED');
    });

    it('422 ATTESTATION_TX_NOT_ATTESTED for an Attested log from another contract', async () => {
      const { order, chain, hash, before } = await primed(p);
      const sender = randomAddress();
      const other = randomAddress();
      const txHash = randomHash();
      chain.mine(makeReceipt({
        txHash, from: sender, to: other, status: 1,
        logs: [attestedLog({ attester: other, hash, sender, txHash })],
      }));
      await assertRejected(p, order.id, txHash, before, 422, 'ATTESTATION_TX_NOT_ATTESTED');
    });

    it('422 ATTESTATION_TX_MALFORMED for a value that is not a tx hash', async () => {
      const { order, before } = await primed(p);
      await assertRejected(p, order.id, 'pasted-by-hand', before, 422, 'ATTESTATION_TX_MALFORMED');
    });

    it('503 ATTESTATION_CHAIN_UNAVAILABLE when the chain cannot be asked', async () => {
      const { order, chain, hash, before } = await primed(p);
      const txHash = chain.mineAttest({ hash, sender: randomAddress() });
      chain.failures.getTransactionReceipt = new Error('connect ECONNREFUSED');
      await assertRejected(p, order.id, txHash, before, 503, 'ATTESTATION_CHAIN_UNAVAILABLE');
    });

    it('503 when the RPC returns a receipt for another transaction', async () => {
      const { order, chain, hash, before } = await primed(p);
      const asked = randomHash();
      const real = randomHash();
      const sender = randomAddress();
      chain.receipts.set(asked.toLowerCase(), makeReceipt({
        txHash: real, from: sender, to: chain.attester, status: 1,
        logs: [attestedLog({ attester: chain.attester, hash, sender, txHash: real })],
      }));
      await assertRejected(p, order.id, asked, before, 503, 'ATTESTATION_CHAIN_UNAVAILABLE');
    });

    it('an empty or missing txHash keeps the backend attestation path', async () => {
      for (const txHash of [undefined, null, '', '  ']) {
        prisma.reset();
        const chain = useChain(new FakeChain());
        const order = p.seed();
        const result = await p.attest(order.id, txHash);
        assert.equal(result.attestationStatus, 'on_chain');
        assert.equal(chain.sent.length, 1);
        assert.equal(result.attestationSender, undefined);
      }
    });
  });
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

describe('attest routes: HTTP shape of the new failures', () => {
  beforeEach(() => prisma.reset());

  it('POST /commerce/orders/:id/attest answers 422 { status:"fail", code, message }', async () => {
    const { order } = await primed(PATHS.procurement);
    const res = fakeRes();
    await commerceController.attestOrder({ user: { id: BUYER }, params: { id: order.id }, body: { txHash: randomHash() } }, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.status, 'fail');
    assert.equal(res.body.code, 'ATTESTATION_TX_NOT_FOUND');
    assert.match(res.body.message, /not found/);
  });

  it('POST /commerce/orders/:id/attest answers 503 { status:"error", code } when the chain is down', async () => {
    const { order, chain } = await primed(PATHS.procurement);
    chain.failures.getTransactionReceipt = new Error('timeout');
    const res = fakeRes();
    await commerceController.attestOrder({ user: { id: BUYER }, params: { id: order.id }, body: { txHash: randomHash() } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.code, 'ATTESTATION_CHAIN_UNAVAILABLE');
  });

  it('POST /commerce/orders/:id/attest still answers 200 with the stored hash when it verifies', async () => {
    const { order, chain, hash } = await primed(PATHS.procurement);
    const txHash = chain.mineAttest({ hash, sender: randomAddress() });
    const res = fakeRes();
    await commerceController.attestOrder({ user: { id: BUYER }, params: { id: order.id }, body: { txHash } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'success');
    assert.equal(res.body.data.attestationTxHash, txHash);
  });

  it('POST /ops/orders/:id/attest answers 422 with a code and stores nothing', async () => {
    const { order, chain, before } = await primed(PATHS.licence);
    const txHash = chain.mineAttest({ hash: contentHash(), sender: randomAddress() });
    const res = fakeRes();
    await opsCommerceController.attestOrder({ opsAdmin: { username: 'ops1', role: 'admin' }, params: { id: order.id }, body: { txHash } }, res);
    assert.equal(res.statusCode, 422);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'status']);
    assert.equal(res.body.status, 'fail');
    assert.equal(res.body.code, 'ATTESTATION_TX_NOT_ATTESTED');
    assert.deepEqual(stored('purchaseOrder', order.id), before);
  });

  it('POST /ops/orders/:id/attest answers 503 when the chain is down', async () => {
    const { order, chain } = await primed(PATHS.licence);
    chain.failures.getTransactionReceipt = new Error('timeout');
    const res = fakeRes();
    await opsCommerceController.attestOrder({ opsAdmin: { username: 'ops1', role: 'admin' }, params: { id: order.id }, body: { txHash: randomHash() } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.code, 'ATTESTATION_CHAIN_UNAVAILABLE');
  });

  it('POST /ops/orders/:id/attest keeps its 404 shape (no code field)', async () => {
    useChain(new FakeChain());
    const res = fakeRes();
    await opsCommerceController.attestOrder({ opsAdmin: { username: 'ops1' }, params: { id: 'missing' }, body: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { status: 'fail', message: 'Order not found' });
  });
});
