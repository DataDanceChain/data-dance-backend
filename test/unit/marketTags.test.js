/**
 * GET /api/nft-market/tags (the market's tag filter) and the market route order, through the REAL
 * application (src/app). In-memory Prisma (test/helpers/demandPrisma.js).
 *
 * The tag list holds only tags that label at least one PUBLISHED pack, by name. The routes are
 * declared most-specific first, so /tags, /my-purchases and /my-sales are not taken by /:id (before
 * production's change, /:id came first and answered /my-purchases and /my-sales with 404).
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installDemandPrisma, resetDemandStore, seedMerchant, seedPack } = require('../helpers/demandPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installDemandPrisma();

const JWT_SECRET = 'ddc-market-tags-secret';
Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET,
  SSO_SESSION_SECRET: 'ddc-market-tags-sso-secret',
});

const app = require('../../src/app');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const as = (user) => ({ Authorization: `Bearer ${jwt.sign({ id: user.id, ver: 2 }, JWT_SECRET, { expiresIn: '5m' })}` });

let merchant;
let buyer;
const tagCalls = [];
const realTagFindMany = prisma.tag.findMany;
prisma.tag.findMany = async (args) => {
  tagCalls.push(args);
  return realTagFindMany(args);
};

async function tag(name) {
  return prisma.tag.create({ data: { name } });
}

beforeEach(async () => {
  resetDemandStore(prisma);
  tagCalls.length = 0;
  merchant = await seedMerchant(prisma);
  buyer = await seedMerchant(prisma);
});

describe('GET /api/nft-market/tags', () => {
  it('needs a user session', async () => {
    const res = await request(server).get('/api/nft-market/tags');
    assert.equal(res.status, 401);
    assert.equal(tagCalls.length, 0);
  });

  it('lists the tags of published packs only, by name, as { id, name }', async () => {
    const travel = await tag('travel');
    const health = await tag('health');
    const draftOnly = await tag('draft-only');
    await tag('unused');
    await seedPack(prisma, { merchantId: merchant.id, tags: [travel.id, health.id] });
    await seedPack(prisma, { merchantId: merchant.id, tags: [travel.id] });
    await seedPack(prisma, { merchantId: merchant.id, isPublished: false, tags: [draftOnly.id] });

    const res = await request(server).get('/api/nft-market/tags').set(as(buyer));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, {
      status: 'success',
      data: [{ id: health.id, name: 'health' }, { id: travel.id, name: 'travel' }],
    });
    assert.deepEqual(tagCalls, [{
      where: { dataNFTs: { some: { isPublished: true } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }]);
  });

  it('is an empty list when nothing is published', async () => {
    const lonely = await tag('lonely');
    await seedPack(prisma, { merchantId: merchant.id, isPublished: false, tags: [lonely.id] });
    const res = await request(server).get('/api/nft-market/tags').set(as(buyer));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  });
});

describe('market route order', () => {
  it('/my-purchases and /my-sales reach their own handlers, not /:id', async () => {
    const pack = await seedPack(prisma, { merchantId: merchant.id, price: 12 });
    await prisma.dataNFTPurchase.create({ data: { dataNFTId: pack.id, buyerId: buyer.id } });

    const purchases = await request(server).get('/api/nft-market/my-purchases').set(as(buyer));
    assert.equal(purchases.status, 200, JSON.stringify(purchases.body));
    assert.deepEqual(purchases.body.data.map((p) => [p.nftId, p.price]), [[pack.id, 12]]);

    const sales = await request(server).get('/api/nft-market/my-sales').set(as(merchant));
    assert.equal(sales.status, 200, JSON.stringify(sales.body));
    assert.deepEqual(sales.body.data.map((s) => [s.nftId, s.sales, s.revenue]), [[pack.id, 1, 12]]);
  });

  it('/tags is not read as a pack id', async () => {
    const res = await request(server).get('/api/nft-market/tags').set(as(buyer));
    assert.equal(res.status, 200);
    assert.equal(tagCalls.length, 1);
  });
});
