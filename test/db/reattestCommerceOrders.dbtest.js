/**
 * scripts/reattestCommerceOrders.js on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL
 * pointing at a throwaway database that `prisma migrate deploy` has built — its name must contain
 * "test"). The chain is the in-memory fake; nothing is sent anywhere.
 *
 * What only the database can prove: the selection query (attestationTxHash IS NOT NULL, select,
 * orderBy createdAt) works on both PurchaseOrder and DisbursementItem; --apply changes only
 * attestationTxHash; the compare-and-set update refuses a row that changed underneath it; a second
 * run selects nothing. Fixture rows use a per-run id prefix and are deleted afterwards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const prisma = require('../../src/utils/prisma');
const script = require('../../scripts/reattestCommerceOrders');
const { attestHashOnChain } = require('../../src/utils/commerceAttestChain');
const { FakeChain, randomAddress, randomHash, contentHash } = require('../helpers/fakeAttestChain');

const RUN = `ra${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const chain = new FakeChain();
const signer = randomAddress();
// Explicit, strictly increasing creation times so the script's createdAt order is deterministic.
let tick = 0;
const nextCreatedAt = () => new Date(Date.UTC(2026, 9, 1) + (tick += 1) * 1000);

async function order(name, { attestationHash = contentHash(), attestationTxHash = null } = {}) {
  return prisma.purchaseOrder.create({
    data: {
      id: id(name),
      orderNumber: id(name).toUpperCase(),
      buyerId: id('buyer'),
      sellerId: id('seller'),
      subtotal: 12.5,
      total: 12.5,
      attestationHash,
      attestationTxHash,
      attestationPayload: { type: 'datadance.procurement.metadata.v1', orderNumber: id(name) },
      attestedAt: new Date('2026-10-02T18:31:52Z'),
      createdAt: nextCreatedAt(),
    },
  });
}

async function payout(name, { attestationHash = contentHash(), attestationTxHash = null } = {}) {
  return prisma.disbursementItem.create({
    data: {
      id: id(name),
      payoutId: id(name),
      origin: 'internal_reward',
      recordClass: 'internal_reward',
      email: `${id(name)}@example.test`,
      walletAddress: randomAddress(),
      amount: 3,
      tokenAddress: randomAddress(),
      status: 'confirmed',
      attestationHash,
      attestationTxHash,
      attestedAt: new Date('2026-09-05T05:38:40Z'),
      createdAt: nextCreatedAt(),
    },
  });
}

const mine = (rows) => rows.filter((r) => String(r.id).startsWith(RUN)).map((r) => r.id).sort();
const strip = ({ attestationTxHash, updatedAt, ...rest }) => rest;

describe('reattestCommerceOrders on Postgres', () => {
  const rows = {};

  before(async () => {
    for (const who of ['buyer', 'seller']) {
      await prisma.user.create({ data: { id: id(who), email: `${id(who)}@example.test`, referralCode: id(who).toUpperCase() } });
    }
    let h = contentHash();
    rows.poValid = await order('po-valid', { attestationHash: h, attestationTxHash: chain.mineAttest({ hash: h, sender: signer }) });
    h = contentHash();
    rows.poNoCode = await order('po-nocode', { attestationHash: h, attestationTxHash: chain.mineAttest({ hash: h, sender: signer, to: randomAddress() }) });
    rows.poNotAttested = await order('po-none');
    rows.poMalformed = await order('po-malformed', { attestationTxHash: 'pasted-by-hand' });
    h = contentHash();
    rows.diNoCode = await payout('di-nocode', { attestationHash: h, attestationTxHash: chain.mineAttest({ hash: h, sender: signer, to: randomAddress() }) });
    h = contentHash();
    rows.diValid = await payout('di-valid', { attestationHash: h, attestationTxHash: chain.mineAttest({ hash: h, sender: signer }) });
    rows.diCas = await payout('di-cas', { attestationTxHash: randomHash() });
  });

  after(async () => {
    await prisma.disbursementItem.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  it('plan selects exactly the unproven rows of both tables and writes nothing', async () => {
    const before = await prisma.purchaseOrder.findMany({ where: { id: { startsWith: RUN } }, orderBy: { id: 'asc' } });
    const plan = await script.planReattest({ prisma, provider: chain.provider, attester: chain.attester, sender: signer });
    assert.deepEqual(mine(plan.needs), [rows.diCas.id, rows.diNoCode.id, rows.poMalformed.id, rows.poNoCode.id].sort());
    assert.deepEqual(mine(plan.blocked), []);
    const after = await prisma.purchaseOrder.findMany({ where: { id: { startsWith: RUN } }, orderBy: { id: 'asc' } });
    assert.deepEqual(after, before);
  });

  it('apply refuses a row that changed underneath it (compare-and-set) and leaves it as the other writer set it', async () => {
    const concurrent = randomHash();
    const attest = async (hash, deps) => {
      if (hash === rows.diCas.attestationHash) {
        await prisma.disbursementItem.update({ where: { id: rows.diCas.id }, data: { attestationTxHash: concurrent } });
      }
      return attestHashOnChain(hash, { ...deps, log: { warn() {} } });
    };
    const lines = [];
    await assert.rejects(
      script.applyReattest({
        prisma, provider: chain.provider, wallet: chain.wallet(signer), attester: chain.attester, attest, out: (l) => lines.push(l),
      }),
      /was not updated/,
    );
    const now = await prisma.disbursementItem.findUnique({ where: { id: rows.diCas.id } });
    assert.equal(now.attestationTxHash, concurrent);
    // Rows ordered before it (purchase orders first, then payouts by createdAt) were repaired and
    // recorded; the run stopped at the CAS failure, with the new tx hash still in the audit lines.
    const step = (name) => lines.filter((l) => l.includes(`"step":"${name}"`)).map((l) => JSON.parse(l).id);
    assert.deepEqual(step('attested'), [rows.poNoCode.id, rows.poMalformed.id, rows.diNoCode.id, rows.diCas.id]);
    assert.deepEqual(step('recorded'), [rows.poNoCode.id, rows.poMalformed.id, rows.diNoCode.id]);
  });

  it('a re-run repairs the rest, changing only attestationTxHash; a third run selects nothing', async () => {
    const snapshot = {
      po: await prisma.purchaseOrder.findMany({ where: { id: { startsWith: RUN } }, orderBy: { id: 'asc' } }),
      di: await prisma.disbursementItem.findMany({ where: { id: { startsWith: RUN } }, orderBy: { id: 'asc' } }),
    };
    const lines = [];
    await script.applyReattest({
      prisma, provider: chain.provider, wallet: chain.wallet(signer), attester: chain.attester, out: (l) => lines.push(l),
    });
    const after = {
      po: await prisma.purchaseOrder.findMany({ where: { id: { startsWith: RUN } }, orderBy: { id: 'asc' } }),
      di: await prisma.disbursementItem.findMany({ where: { id: { startsWith: RUN } }, orderBy: { id: 'asc' } }),
    };
    for (const key of ['po', 'di']) {
      snapshot[key].forEach((b, i) => assert.deepEqual(strip(after[key][i]), strip(b), `${b.id}: only attestationTxHash may change`));
    }
    const changed = [...after.po, ...after.di]
      .filter((a) => [...snapshot.po, ...snapshot.di].find((b) => b.id === a.id).attestationTxHash !== a.attestationTxHash)
      .map((a) => a.id)
      .sort();
    assert.deepEqual(changed, [rows.diCas.id], 'only the row left over by the CAS refusal');

    const recorded = lines.filter((l) => l.includes('"step":"recorded"')).map((l) => JSON.parse(l));
    for (const entry of recorded) {
      const b = [...snapshot.po, ...snapshot.di].find((r) => r.id === entry.id);
      assert.equal(entry.oldTxHash, b.attestationTxHash);
    }

    const plan = await script.planReattest({ prisma, provider: chain.provider, attester: chain.attester, sender: signer });
    assert.deepEqual(mine(plan.needs), []);
    const sent = chain.sent.length;
    const again = await script.applyReattest({
      prisma, provider: chain.provider, wallet: chain.wallet(signer), attester: chain.attester, out: () => {},
    });
    assert.equal(again.reattested, 0);
    assert.equal(chain.sent.length, sent);
    const untouched = await prisma.purchaseOrder.findUnique({ where: { id: rows.poNotAttested.id } });
    assert.equal(untouched.attestationTxHash, null);
  });
});
