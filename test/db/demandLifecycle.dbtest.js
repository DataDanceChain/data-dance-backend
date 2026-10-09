/**
 * One buyer data request through its whole life on REAL Postgres (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway database that `prisma migrate deploy` has built — its name
 * must contain "test"). The chain is the in-memory fake (test/helpers/fakeAttestChain.js); nothing is
 * sent anywhere.
 *
 * What only the database can prove: the tables, columns, defaults, indexes and foreign keys that
 * 20260919120000_add_data_demand creates carry the production service from submission to fulfilment;
 * fulfilment buys the pack through the real purchase path (licence, ledger, commerce order, receipt
 * attestation) and links the request to the purchase and the order; the foreign keys behave as
 * production's SQL declares them (events cascade with their request, a pack deletion clears the link,
 * a buyer with requests cannot be deleted); the market tag query returns tags of published packs only.
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

// Every attestation goes through the real attestHashOnChain against the in-memory chain.
const realChain = require('../../src/utils/commerceAttestChain');
const { FakeChain } = require('../helpers/fakeAttestChain');

const chain = new FakeChain();
const chainFile = require.resolve(path.join(__dirname, '../../src/utils/commerceAttestChain.js'));
require.cache[chainFile] = {
  id: chainFile,
  filename: chainFile,
  loaded: true,
  children: [],
  exports: {
    ...realChain,
    attestHashOnChain: (hash) => realChain.attestHashOnChain(hash, {
      provider: chain.provider, wallet: chain.wallet(), attester: chain.attester, log: { warn() {} },
    }),
  },
};

const prisma = require('../../src/utils/prisma');
// nftMarketController builds its own client at load; hand it the shared one so after() closes it.
const clientFile = require.resolve('@prisma/client');
require.cache[clientFile].exports = {
  ...require.cache[clientFile].exports,
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};
const demandService = require('../../src/services/demandService');

const RUN = `dm${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;

async function user(name, { organization = true } = {}) {
  return prisma.user.create({
    data: {
      id: id(name),
      email: `${id(name)}@example.test`,
      name: id(name),
      referralCode: id(name).toUpperCase(),
      isOrganization: organization,
      userType: organization ? 'organization' : 'regular',
    },
  });
}

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

async function pack(name, merchantId, { price = 30, isPublished = true, tags = [] } = {}) {
  return prisma.dataNFT.create({
    data: {
      id: id(name),
      name: id(name),
      price,
      isPublished,
      merchantId,
      dataSource: 'upload',
      dataRecords: { recordCount: 2, records: [{ row: 1 }, { row: 2 }] },
      ...(tags.length ? { tags: { connect: tags.map((tagId) => ({ id: tagId })) } } : {}),
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
  await prisma.dataDemand.deleteMany({ where: { buyerId: { in: users } } });
  await prisma.payment.deleteMany({ where: { OR: [{ payerId: { in: users } }, { payeeId: { in: users } }] } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: orders } } });
  await prisma.organizationTransaction.deleteMany({ where: { userId: { in: users } } });
  await prisma.dataNFTPurchase.deleteMany({ where: { buyerId: { in: users } } });
  await prisma.dataNFT.deleteMany({ where: { merchantId: { in: users } } });
  await prisma.tag.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.legalEntity.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}

describe('a buyer data request on a real database', () => {
  let buyer;
  let seller;
  let chosen;

  before(async () => {
    await cleanup();
    buyer = await user('buyer');
    seller = await user('seller');
    await kyc(buyer.id);
    await kyc(seller.id);
    chosen = await pack('pack', seller.id, { price: 30 });
    await prisma.organizationTransaction.create({
      data: { userId: buyer.id, amount: 100, type: 'DEPOSIT', status: 'COMPLETED', description: `${RUN} top-up` },
    });
  });

  after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('runs submit -> quote -> accept -> assemble -> fulfil and links the purchase and the order', async () => {
    const created = await demandService.createDemand(buyer.id, {
      category: 'mobility', region: 'SG', recordCount: 2, description: 'Two anonymised rows', bidUsd: 40,
    });
    const row = await prisma.dataDemand.findUnique({ where: { id: created.id } });
    assert.equal(row.status, 'submitted');
    assert.ok(row.updatedAt instanceof Date);
    assert.match(row.id, /^[0-9a-f-]{36}$/, 'ids are uuids (@default(uuid()))');

    assert.deepEqual((await demandService.listMine(buyer.id)).map((d) => d.id), [created.id]);
    await demandService.quoteDemand(created.id, 'ops-db', { quotedPriceUsd: 35, quotedCount: 2, note: 'ready tomorrow' });
    await demandService.acceptQuote(buyer.id, created.id);
    await demandService.markAssembling(created.id, 'ops-db', 'pulling rows');
    const done = await demandService.fulfillDemand(created.id, 'ops-db', { dataNFTId: chosen.id });

    const final = await prisma.dataDemand.findUnique({ where: { id: created.id }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    assert.equal(final.status, 'fulfilled');
    assert.equal(final.dataNFTId, chosen.id);
    assert.equal(final.quotedPriceUsd, 35);
    assert.equal(final.quoteNote, 'ready tomorrow');
    assert.deepEqual(
      final.events.map((e) => `${e.actor}:${e.action}:${e.fromStatus}->${e.toStatus}`),
      [
        'merchant:submit:null->submitted',
        'ops:quote:submitted->quoted',
        'merchant:accept:quoted->accepted',
        'ops:assemble:accepted->assembling',
        'ops:fulfill:assembling->fulfilled',
      ],
    );

    const purchase = await prisma.dataNFTPurchase.findUnique({ where: { id: final.purchaseId } });
    assert.equal(purchase.buyerId, buyer.id);
    assert.equal(purchase.dataNFTId, chosen.id);

    const order = await prisma.purchaseOrder.findUnique({ where: { id: final.orderId } });
    assert.equal(order.purchaseId, purchase.id);
    assert.equal(order.buyerId, buyer.id);
    assert.equal(order.sellerId, seller.id);
    assert.equal(order.total, 30);
    assert.ok(order.attestationTxHash, 'the licence receipt was attested (fake chain)');
    assert.equal(done.order.id, order.id);
    assert.equal(done.order.attestationPayload, undefined);

    const ledger = await prisma.organizationTransaction.findMany({
      where: { metadata: { path: ['demandId'], equals: created.id } },
      orderBy: { type: 'asc' },
    });
    assert.deepEqual(ledger.map((t) => [t.userId, t.type, t.amount]), [[seller.id, 'DEPOSIT', 30], [buyer.id, 'WITHDRAW', 30]]);

    const ops = await demandService.listOps({});
    assert.ok(ops.items.some((d) => d.id === created.id && d.status === 'fulfilled'));
  });

  it('enforces production\'s foreign keys: events cascade, a pack deletion clears the link, a buyer with requests stays', async () => {
    const spare = await pack('spare', seller.id, { price: 1 });
    const demand = await demandService.createDemand(buyer.id, {
      category: 'retail', recordCount: 1, description: 'Foreign key check', bidUsd: 5,
    });
    await prisma.dataDemand.update({ where: { id: demand.id }, data: { dataNFTId: spare.id } });

    await prisma.dataNFT.delete({ where: { id: spare.id } });
    assert.equal((await prisma.dataDemand.findUnique({ where: { id: demand.id } })).dataNFTId, null, 'ON DELETE SET NULL');

    await assert.rejects(
      prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id = $1', buyer.id),
      /DataDemand_buyerId_fkey|foreign key/i,
      'ON DELETE RESTRICT on the buyer',
    );

    assert.equal(await prisma.demandEvent.count({ where: { demandId: demand.id } }), 1);
    await prisma.dataDemand.delete({ where: { id: demand.id } });
    assert.equal(await prisma.demandEvent.count({ where: { demandId: demand.id } }), 0, 'ON DELETE CASCADE');
  });

  it('the market tag query returns the tags of published packs only', async () => {
    const shown = await prisma.tag.create({ data: { id: id('tag-shown'), name: `${RUN}-shown` } });
    const hidden = await prisma.tag.create({ data: { id: id('tag-hidden'), name: `${RUN}-hidden` } });
    await pack('tagged-published', seller.id, { tags: [shown.id] });
    await pack('tagged-draft', seller.id, { isPublished: false, tags: [hidden.id] });

    const { getMarketTags } = require('../../src/controllers/nftMarketController');
    const res = await new Promise((resolve) => {
      getMarketTags({}, {
        status(code) { this.code = code; return this; },
        json(body) { resolve({ status: this.code, body }); },
      });
    });
    assert.equal(res.status, 200);
    const names = res.body.data.map((t) => t.name).filter((name) => name.startsWith(RUN));
    assert.deepEqual(names, [`${RUN}-shown`]);
  });
});
