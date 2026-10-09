/**
 * src/services/demandService.js: the buyer data-request ("Data Requests") state machine as it runs in
 * production. In-memory Prisma (test/helpers/demandPrisma.js); fulfilment runs the real
 * src/services/packPurchase.js with the commerce order and the chain attestation stubbed.
 *
 * States: submitted -> quoted -> accepted -> assembling -> fulfilled, plus cancelled (buyer, from
 * submitted or quoted) and declined (ops, from any open state). Ownership: every buyer call is scoped
 * to the caller's buyerId and answers 404 for anyone else's request.
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

const orders = [];
const attested = [];
commerceService.createOrderFromPurchase = async (db, args) => {
  const n = orders.length + 1;
  const order = {
    id: `order-${n}`,
    orderNumber: `PO-TEST-${n}`,
    status: 'paid',
    buyerId: args.buyerId,
    sellerId: args.sellerId,
    purchaseId: args.purchase.id,
    total: args.totalAmount,
    attestationPayload: { internal: true },
  };
  orders.push({ db, args, order });
  return { order, invoice: { id: `invoice-${n}`, total: args.totalAmount }, payment: { id: `payment-${n}` } };
};
commerceAttest.attestPaidOrderSafe = async (orderId) => {
  attested.push(orderId);
  return null;
};

const demandService = require('../../src/services/demandService');

const VALID = Object.freeze({
  category: 'mobility',
  region: 'SG',
  recordCount: 500,
  description: 'Weekly commute traces, anonymised',
  bidUsd: 40,
});

let buyer;
let otherBuyer;
let seller;

beforeEach(async () => {
  resetDemandStore(prisma);
  orders.length = 0;
  attested.length = 0;
  buyer = await seedMerchant(prisma);
  otherBuyer = await seedMerchant(prisma);
  seller = await seedMerchant(prisma);
});

async function rejects(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode, `statusCode for ${code}: ${error.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

function events(demandId) {
  return prisma.demandEvent.rows
    .filter((event) => event.demandId === demandId)
    .map((event) => `${event.actor}:${event.action}:${event.fromStatus}->${event.toStatus}`);
}

async function demandIn(status, over = {}) {
  const demand = await demandService.createDemand(buyer.id, { ...VALID });
  if (status === 'submitted') return demand;
  const row = prisma.dataDemand.rows.find((r) => r.id === demand.id);
  Object.assign(row, { status, ...over });
  return { ...demand, status };
}

describe('validateCreate', () => {
  it('accepts a complete request and normalises it', () => {
    const out = demandService.validateCreate({ ...VALID, region: '  ', similarPackId: ' p1 ', deadline: '2026-12-31' });
    assert.equal(out.category, 'mobility');
    assert.equal(out.region, null);
    assert.equal(out.similarPackId, 'p1');
    assert.equal(out.recordCount, 500);
    assert.equal(out.bidUsd, 40);
    assert.ok(out.deadline instanceof Date);
  });

  for (const [label, patch, code] of [
    ['no category', { category: ' ' }, 'invalid_category'],
    ['zero records', { recordCount: 0 }, 'invalid_count'],
    ['fractional records', { recordCount: 2.5 }, 'invalid_count'],
    ['a non-positive bid', { bidUsd: 0 }, 'invalid_bid'],
    ['a non-numeric bid', { bidUsd: 'lots' }, 'invalid_bid'],
    ['a short description', { description: 'short' }, 'invalid_description'],
    ['an invalid deadline', { deadline: 'not a date' }, 'invalid_deadline'],
  ]) {
    it(`rejects ${label} with 400 ${code}`, () => {
      assert.throws(() => demandService.validateCreate({ ...VALID, ...patch }), (error) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, code);
        return true;
      });
    });
  }
});

describe('buyer: create, list, get', () => {
  it('creates a submitted request with a submit event, scoped to the caller', async () => {
    const demand = await demandService.createDemand(buyer.id, { ...VALID });
    assert.equal(demand.status, 'submitted');
    assert.equal(demand.buyerId, buyer.id);
    assert.deepEqual(demand.buyer, { id: buyer.id, email: buyer.email, name: buyer.name });
    assert.equal(demand.pack, null);
    assert.deepEqual(demand.events.map((e) => [e.actor, e.action, e.fromStatus, e.toStatus]), [['merchant', 'submit', null, 'submitted']]);
    assert.deepEqual(events(demand.id), ['merchant:submit:null->submitted']);
  });

  it('refuses a merchant without complete company KYC (403 merchant_kyc_required) and stores nothing', async () => {
    const noKyc = await seedMerchant(prisma, { kyc: false });
    await rejects(demandService.createDemand(noKyc.id, { ...VALID }), 403, 'merchant_kyc_required');
    assert.equal(prisma.dataDemand.rows.length, 0);
  });

  it('refuses a merchant whose KYC was rejected', async () => {
    const rejected = await seedMerchant(prisma);
    prisma.legalEntity.rows.find((r) => r.userId === rejected.id).kycStatus = 'rejected';
    await rejects(demandService.createDemand(rejected.id, { ...VALID }), 403, 'merchant_kyc_required');
  });

  it('lists only the caller\'s requests, newest first', async () => {
    const first = await demandService.createDemand(buyer.id, { ...VALID });
    const second = await demandService.createDemand(buyer.id, { ...VALID, category: 'retail' });
    await demandService.createDemand(otherBuyer.id, { ...VALID });
    const mine = await demandService.listMine(buyer.id);
    assert.deepEqual(mine.map((d) => d.id), [second.id, first.id]);
  });

  it('answers 404 for another buyer\'s request (get, cancel, accept)', async () => {
    const theirs = await demandService.createDemand(otherBuyer.id, { ...VALID });
    await rejects(demandService.getMine(buyer.id, theirs.id), 404, 'demand_not_found');
    await rejects(demandService.cancelMine(buyer.id, theirs.id), 404, 'demand_not_found');
    prisma.dataDemand.rows.find((r) => r.id === theirs.id).status = 'quoted';
    await rejects(demandService.acceptQuote(buyer.id, theirs.id), 404, 'demand_not_found');
    assert.equal(prisma.dataDemand.rows.find((r) => r.id === theirs.id).status, 'quoted');
  });
});

describe('buyer: cancel and accept', () => {
  for (const status of ['submitted', 'quoted']) {
    it(`cancels from ${status}`, async () => {
      const demand = await demandIn(status);
      const out = await demandService.cancelMine(buyer.id, demand.id);
      assert.equal(out.status, 'cancelled');
      assert.deepEqual(events(demand.id).slice(-1), [`merchant:cancel:${status}->cancelled`]);
    });
  }

  for (const status of ['accepted', 'assembling', 'fulfilled', 'declined', 'cancelled']) {
    it(`does not cancel from ${status} (400 not_cancellable)`, async () => {
      const demand = await demandIn(status);
      await rejects(demandService.cancelMine(buyer.id, demand.id), 400, 'not_cancellable');
      assert.equal(prisma.dataDemand.rows.find((r) => r.id === demand.id).status, status);
    });
  }

  it('accepts an open quote', async () => {
    const demand = await demandIn('quoted', { quoteExpiresAt: new Date(Date.now() + 3600_000) });
    const out = await demandService.acceptQuote(buyer.id, demand.id);
    assert.equal(out.status, 'accepted');
    assert.deepEqual(events(demand.id).slice(-1), ['merchant:accept:quoted->accepted']);
  });

  it('refuses an expired quote (400 quote_expired)', async () => {
    const demand = await demandIn('quoted', { quoteExpiresAt: new Date(Date.now() - 1000) });
    await rejects(demandService.acceptQuote(buyer.id, demand.id), 400, 'quote_expired');
  });

  for (const status of ['submitted', 'accepted', 'assembling', 'fulfilled', 'declined', 'cancelled']) {
    it(`refuses to accept from ${status} (400 not_quoted)`, async () => {
      const demand = await demandIn(status);
      await rejects(demandService.acceptQuote(buyer.id, demand.id), 400, 'not_quoted');
    });
  }
});

describe('ops: list, get, quote, decline, assemble', () => {
  it('lists with a status filter, pagination and the open count', async () => {
    const a = await demandIn('submitted');
    const b = await demandIn('quoted');
    await demandIn('cancelled');
    const all = await demandService.listOps({});
    assert.equal(all.pagination.total, 3);
    assert.equal(all.openCount, 2);
    const quoted = await demandService.listOps({ status: 'quoted' });
    assert.deepEqual(quoted.items.map((d) => d.id), [b.id]);
    const page2 = await demandService.listOps({ page: 2, limit: 1 });
    assert.equal(page2.items.length, 1);
    assert.deepEqual(page2.pagination, { total: 3, page: 2, limit: 1 });
    assert.ok([a.id, b.id].includes(page2.items[0].id));
    const capped = await demandService.listOps({ limit: 1000 });
    assert.equal(capped.pagination.limit, 100);
  });

  it('gets any request by id; 404 for an unknown one', async () => {
    const demand = await demandIn('submitted');
    assert.equal((await demandService.getOps(demand.id)).id, demand.id);
    await rejects(demandService.getOps('missing'), 404, 'demand_not_found');
  });

  it('quotes a submitted request (price and count default to the bid), records the ops actor', async () => {
    const demand = await demandIn('submitted');
    const out = await demandService.quoteDemand(demand.id, 'ops-alice', { note: ' 3 days ' });
    assert.equal(out.status, 'quoted');
    assert.equal(out.quotedPriceUsd, VALID.bidUsd);
    assert.equal(out.quotedCount, VALID.recordCount);
    assert.equal(out.quoteNote, '3 days');
    const event = prisma.demandEvent.rows.filter((e) => e.demandId === demand.id).pop();
    assert.deepEqual([event.actor, event.actorId, event.action, event.note], ['ops', 'ops-alice', 'quote', '3 days']);
  });

  it('re-quotes a quoted request', async () => {
    const demand = await demandIn('quoted');
    const out = await demandService.quoteDemand(demand.id, 'ops', { quotedPriceUsd: 35, quotedCount: 400, expiresAt: '2026-11-01' });
    assert.equal(out.quotedPriceUsd, 35);
    assert.equal(out.quotedCount, 400);
    assert.ok(out.quoteExpiresAt instanceof Date);
  });

  for (const [label, body, code] of [
    ['a zero price', { quotedPriceUsd: 0 }, 'invalid_quote'],
    ['a zero count', { quotedCount: 0 }, 'invalid_quote_count'],
    ['an invalid expiry', { expiresAt: 'soon' }, 'invalid_expiry'],
  ]) {
    it(`rejects a quote with ${label} (400 ${code})`, async () => {
      const demand = await demandIn('submitted');
      await rejects(demandService.quoteDemand(demand.id, 'ops', body), 400, code);
      assert.equal(prisma.dataDemand.rows.find((r) => r.id === demand.id).status, 'submitted');
    });
  }

  for (const status of ['accepted', 'assembling', 'fulfilled', 'declined', 'cancelled']) {
    it(`does not quote from ${status} (400 not_quotable)`, async () => {
      const demand = await demandIn(status);
      await rejects(demandService.quoteDemand(demand.id, 'ops', {}), 400, 'not_quotable');
    });
  }

  for (const status of ['submitted', 'quoted', 'accepted', 'assembling']) {
    it(`declines an open request (${status}) with a reason`, async () => {
      const demand = await demandIn(status);
      const out = await demandService.declineDemand(demand.id, 'ops', ' not available ');
      assert.equal(out.status, 'declined');
      assert.equal(out.declineReason, 'not available');
    });
  }

  it('needs a decline reason of at least 3 characters (400 decline_reason)', async () => {
    const demand = await demandIn('submitted');
    await rejects(demandService.declineDemand(demand.id, 'ops', ' no '), 400, 'decline_reason');
    await rejects(demandService.declineDemand(demand.id, 'ops', undefined), 400, 'decline_reason');
  });

  for (const status of ['fulfilled', 'declined', 'cancelled']) {
    it(`does not decline a closed request (${status}): 400 not_open`, async () => {
      const demand = await demandIn(status);
      await rejects(demandService.declineDemand(demand.id, 'ops', 'too late'), 400, 'not_open');
    });
  }

  for (const status of ['submitted', 'quoted', 'accepted', 'assembling']) {
    it(`moves ${status} to assembling`, async () => {
      const demand = await demandIn(status);
      const out = await demandService.markAssembling(demand.id, 'ops', 'pulling records');
      assert.equal(out.status, 'assembling');
    });
  }

  for (const status of ['fulfilled', 'declined', 'cancelled']) {
    it(`does not assemble from ${status} (400 not_assemblable)`, async () => {
      const demand = await demandIn(status);
      await rejects(demandService.markAssembling(demand.id, 'ops'), 400, 'not_assemblable');
    });
  }
});

describe('ops: fulfil through the production purchase path', () => {
  it('buys the chosen pack for the buyer and closes the request', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 30 });
    await seedBalance(prisma, buyer.id, 100);
    const demand = await demandIn('accepted', { quotedPriceUsd: 35 });

    const out = await demandService.fulfillDemand(demand.id, 'ops-bob', { dataNFTId: pack.id });

    assert.equal(out.demand.status, 'fulfilled');
    assert.equal(out.demand.dataNFTId, pack.id);
    assert.equal(out.demand.purchaseId, out.purchase.id);
    assert.equal(out.demand.orderId, 'order-1');
    assert.equal(out.demand.pack.id, pack.id);
    assert.equal(out.order.id, 'order-1');
    assert.equal(out.order.attestationPayload, undefined, 'the order goes out without its attestation payload');
    assert.deepEqual(events(demand.id).slice(-1), ['ops:fulfill:accepted->fulfilled']);
    assert.equal(prisma.demandEvent.rows.filter((e) => e.demandId === demand.id).pop().note, pack.id);

    // The purchase: one licence, buyer debited, seller credited, both tagged with the request.
    const purchases = prisma.dataNFTPurchase.rows.filter((p) => p.buyerId === buyer.id);
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].quantity, 1);
    const ledger = prisma.organizationTransaction.rows.filter((t) => t.metadata?.demandId === demand.id);
    assert.deepEqual(ledger.map((t) => [t.userId, t.type, t.amount]).sort(), [[buyer.id, 'WITHDRAW', 30], [seller.id, 'DEPOSIT', 30]].sort());
    assert.equal(orders.length, 1);
    assert.equal(orders[0].args.paidFromBalance, true);
    assert.deepEqual(attested, ['order-1']);
  });

  it('uses the similar pack when none is chosen', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 10 });
    await seedBalance(prisma, buyer.id, 10);
    const demand = await demandService.createDemand(buyer.id, { ...VALID, similarPackId: pack.id });
    const out = await demandService.fulfillDemand(demand.id, 'ops', {});
    assert.equal(out.demand.dataNFTId, pack.id);
  });

  it('needs a pack (400 pack_required) and an existing one (404 pack_not_found)', async () => {
    const demand = await demandIn('accepted');
    await rejects(demandService.fulfillDemand(demand.id, 'ops', {}), 400, 'pack_required');
    await rejects(demandService.fulfillDemand(demand.id, 'ops', { dataNFTId: 'missing' }), 404, 'pack_not_found');
  });

  it('refuses a pack above the quoted ceiling, or above the bid when unquoted (400 over_bid)', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 36 });
    await seedBalance(prisma, buyer.id, 100);
    const quoted = await demandIn('accepted', { quotedPriceUsd: 35 });
    await rejects(demandService.fulfillDemand(quoted.id, 'ops', { dataNFTId: pack.id }), 400, 'over_bid');
    const unquoted = await demandIn('submitted');
    const pricey = await seedPack(prisma, { merchantId: seller.id, price: VALID.bidUsd + 1 });
    await rejects(demandService.fulfillDemand(unquoted.id, 'ops', { dataNFTId: pricey.id }), 400, 'over_bid');
    assert.equal(prisma.dataNFTPurchase.rows.length, 0, 'nothing was bought');
  });

  it('passes purchase refusals through and leaves the request open', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 30 });
    await seedBalance(prisma, buyer.id, 5);
    const demand = await demandIn('accepted');
    await rejects(demandService.fulfillDemand(demand.id, 'ops', { dataNFTId: pack.id }), 400, 'insufficient_balance');
    assert.equal(prisma.dataDemand.rows.find((r) => r.id === demand.id).status, 'accepted');
    assert.equal(prisma.dataNFTPurchase.rows.length, 0);
  });

  for (const status of ['fulfilled', 'declined', 'cancelled']) {
    it(`does not fulfil from ${status} (400 not_fulfillable)`, async () => {
      const pack = await seedPack(prisma, { merchantId: seller.id, price: 1 });
      const demand = await demandIn(status);
      await rejects(demandService.fulfillDemand(demand.id, 'ops', { dataNFTId: pack.id }), 400, 'not_fulfillable');
    });
  }
});

describe('presentDemand and failToHttp', () => {
  it('exposes only id, email and name of the buyer', async () => {
    const row = { id: 'd1', status: 'submitted', buyer: { id: 'u1', email: 'u1@example.test', name: null, passwordHash: 'x', walletAddress: 'y' }, events: [] };
    assert.deepEqual(demandService.presentDemand(row).buyer, { id: 'u1', email: 'u1@example.test', name: null });
  });

  function fakeRes() {
    return {
      statusCode: 0,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }

  it('maps a client error to its status and code', () => {
    const res = demandService.failToHttp(fakeRes(), Object.assign(new Error('Request not found.'), { statusCode: 404, code: 'demand_not_found' }));
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { status: 'fail', code: 'demand_not_found', error: 'Request not found.', message: 'Request not found.' });
  });

  it('answers 500 with a generic message for anything else (no internals)', () => {
    const original = console.error;
    console.error = () => {};
    try {
      const secret = crypto.randomBytes(8).toString('hex');
      const res = demandService.failToHttp(fakeRes(), new Error(`connection to ${secret} refused`));
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { status: 'error', message: 'Server error' });
    } finally {
      console.error = original;
    }
  });
});

describe('a regular (non-organization) account', () => {
  it('cannot be the buyer of a fulfilled request: the purchase path refuses it (403 org_buyer_required)', async () => {
    const person = await seedUser(prisma);
    await prisma.legalEntity.create({ data: { userId: person.id, companyName: 'Person Co', brNumber: 'BR-2', beneficialOwner: 'Owner', address: '2 Test Street', country: 'SG', email: 'person@example.test' } });
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 1 });
    await seedBalance(prisma, person.id, 10);
    const demand = await demandService.createDemand(person.id, { ...VALID });
    await rejects(demandService.fulfillDemand(demand.id, 'ops', { dataNFTId: pack.id }), 403, 'org_buyer_required');
  });
});
