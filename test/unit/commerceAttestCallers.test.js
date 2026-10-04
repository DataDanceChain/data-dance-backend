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
const { FakeChain, randomAddress } = require('../helpers/fakeAttestChain');

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
  },
};

const commerceAttest = require('../../src/services/commerceAttest');
const procurementService = require('../../src/services/procurementService');
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
