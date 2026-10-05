/**
 * The buyer data-request endpoints through the REAL application (src/app), so the mount order and every
 * middleware in front of them is what is under test: /api/demands (organization accounts, own requests
 * only) and /api/ops/demands (ops sessions only; the demo ops role may read but not change).
 * In-memory Prisma (test/helpers/demandPrisma.js); the commerce order and the chain attestation behind
 * fulfilment are stubbed.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const {
  installDemandPrisma, resetDemandStore, seedMerchant, seedUser, seedPack, seedBalance,
} = require('../helpers/demandPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installDemandPrisma();

const JWT_SECRET = 'ddc-demand-routes-secret';
Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  // passWebServiceController builds an APNs provider at load time; identifiers only.
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET,
  SSO_SESSION_SECRET: 'ddc-demand-routes-sso-secret',
});

const commerceService = require('../../src/services/commerceService');
const commerceAttest = require('../../src/services/commerceAttest');

let orderSeq = 0;
commerceService.createOrderFromPurchase = async (db, args) => {
  orderSeq += 1;
  return {
    order: { id: `order-${orderSeq}`, orderNumber: `PO-TEST-${orderSeq}`, status: 'paid', purchaseId: args.purchase.id, total: args.totalAmount },
    invoice: { id: `invoice-${orderSeq}`, total: args.totalAmount },
    payment: { id: `payment-${orderSeq}` },
  };
};
commerceAttest.attestPaidOrderSafe = async () => null;

// auth.isOrganization logs the whole user row on every request; keep the test output readable.
const originalLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('req.user in isOrganization')) return;
  originalLog(...args);
};

const app = require('../../src/app');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => {
  console.log = originalLog;
  return new Promise((resolve) => server.close(resolve));
});

const userToken = (user) => jwt.sign({ id: user.id, ver: 2 }, JWT_SECRET, { expiresIn: '5m' });
const opsToken = (role = 'admin', sub = 'ops-alice') => jwt.sign({ type: 'ops_admin', sub, role }, JWT_SECRET, { expiresIn: '5m' });
const as = (token) => ({ Authorization: `Bearer ${token}` });

const VALID = { category: 'mobility', region: 'SG', recordCount: 500, description: 'Weekly commute traces, anonymised', bidUsd: 40 };

let buyer;
let otherBuyer;
let seller;
let person;

beforeEach(async () => {
  resetDemandStore(prisma);
  buyer = await seedMerchant(prisma);
  otherBuyer = await seedMerchant(prisma);
  seller = await seedMerchant(prisma);
  person = await seedUser(prisma);
});

async function create(user = buyer, body = VALID) {
  const res = await request(server).post('/api/demands').set(as(userToken(user))).send(body);
  assert.equal(res.status, 201, `create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const BUYER_ROUTES = [
  ['get', '/api/demands'],
  ['post', '/api/demands'],
  ['get', '/api/demands/some-id'],
  ['post', '/api/demands/some-id/cancel'],
  ['post', '/api/demands/some-id/accept'],
];

const OPS_ROUTES = [
  ['get', '/api/ops/demands'],
  ['get', '/api/ops/demands/some-id'],
  ['post', '/api/ops/demands/some-id/quote'],
  ['post', '/api/ops/demands/some-id/decline'],
  ['post', '/api/ops/demands/some-id/assemble'],
  ['post', '/api/ops/demands/some-id/fulfill'],
];

describe('/api/demands: who may call it', () => {
  it('needs a user session (401 without one)', async () => {
    for (const [method, path] of BUYER_ROUTES) {
      const res = await request(server)[method](path).send({});
      assert.equal(res.status, 401, `${method.toUpperCase()} ${path} -> ${res.status}`);
    }
  });

  it('does not accept an ops session (401)', async () => {
    for (const [method, path] of BUYER_ROUTES) {
      const res = await request(server)[method](path).set(as(opsToken())).send({});
      assert.equal(res.status, 401, `${method.toUpperCase()} ${path} -> ${res.status}`);
    }
  });

  it('is for organization accounts only (403 for a regular account)', async () => {
    for (const [method, path] of BUYER_ROUTES) {
      const res = await request(server)[method](path).set(as(userToken(person))).send(VALID);
      assert.equal(res.status, 403, `${method.toUpperCase()} ${path} -> ${res.status}`);
    }
    assert.equal(prisma.dataDemand.rows.length, 0);
  });

  it('refuses a disabled account (403 ACCOUNT_DISABLED)', async () => {
    prisma.user.rows.find((u) => u.id === buyer.id).disabledAt = new Date();
    const res = await request(server).get('/api/demands').set(as(userToken(buyer)));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ACCOUNT_DISABLED');
  });

  it('needs complete company KYC to create (403 merchant_kyc_required)', async () => {
    const noKyc = await seedMerchant(prisma, { kyc: false });
    const res = await request(server).post('/api/demands').set(as(userToken(noKyc))).send(VALID);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'merchant_kyc_required');
  });

  it('validates the request body (400 with a code)', async () => {
    const res = await request(server).post('/api/demands').set(as(userToken(buyer))).send({ ...VALID, bidUsd: -1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_bid');
  });
});

describe('/api/demands: a buyer sees and changes only their own requests', () => {
  it('create, list and get', async () => {
    const created = await create();
    assert.equal(created.status, 'submitted');
    const list = await request(server).get('/api/demands').set(as(userToken(buyer)));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((d) => d.id), [created.id]);
    const one = await request(server).get(`/api/demands/${created.id}`).set(as(userToken(buyer)));
    assert.equal(one.status, 200);
    assert.equal(one.body.data.id, created.id);
  });

  it('another organization gets 404 for get, cancel and accept, and cannot see it in its list', async () => {
    const created = await create();
    const token = userToken(otherBuyer);
    for (const [method, path] of [['get', `/api/demands/${created.id}`], ['post', `/api/demands/${created.id}/cancel`], ['post', `/api/demands/${created.id}/accept`]]) {
      const res = await request(server)[method](path).set(as(token));
      assert.equal(res.status, 404, `${method.toUpperCase()} ${path} -> ${res.status}`);
      assert.equal(res.body.code, 'demand_not_found');
    }
    const list = await request(server).get('/api/demands').set(as(token));
    assert.deepEqual(list.body.data, []);
    assert.equal(prisma.dataDemand.rows[0].status, 'submitted');
  });
});

describe('/api/ops/demands: ops sessions only', () => {
  it('needs an ops session (401 without one)', async () => {
    for (const [method, path] of OPS_ROUTES) {
      const res = await request(server)[method](path).send({});
      assert.equal(res.status, 401, `${method.toUpperCase()} ${path} -> ${res.status}`);
    }
  });

  it('refuses a user session, even an organization one (403 Invalid ops token)', async () => {
    for (const [method, path] of OPS_ROUTES) {
      const res = await request(server)[method](path).set(as(userToken(buyer))).send({});
      assert.equal(res.status, 403, `${method.toUpperCase()} ${path} -> ${res.status}`);
    }
  });

  it('the demo role can read but not change anything (403 on every POST)', async () => {
    const created = await create();
    const demo = opsToken('demo', 'demo-viewer');
    const list = await request(server).get('/api/ops/demands').set(as(demo));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.openCount, 1);
    const one = await request(server).get(`/api/ops/demands/${created.id}`).set(as(demo));
    assert.equal(one.status, 200);
    for (const action of ['quote', 'decline', 'assemble', 'fulfill']) {
      const res = await request(server).post(`/api/ops/demands/${created.id}/${action}`).set(as(demo)).send({ reason: 'nope', quotedPriceUsd: 1 });
      assert.equal(res.status, 403, `${action} -> ${res.status}`);
    }
    assert.equal(prisma.dataDemand.rows[0].status, 'submitted');
    assert.equal(prisma.demandEvent.rows.length, 1);
  });

  it('answers 404 for an unknown request', async () => {
    const res = await request(server).get('/api/ops/demands/missing').set(as(opsToken()));
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'demand_not_found');
  });
});

describe('one request from submission to fulfilment, over HTTP', () => {
  it('submit -> quote -> accept -> assemble -> fulfil, and nothing moves backwards afterwards', async () => {
    const pack = await seedPack(prisma, { merchantId: seller.id, price: 30 });
    await seedBalance(prisma, buyer.id, 100);
    const buyerAuth = as(userToken(buyer));
    const ops = as(opsToken('admin', 'ops-alice'));

    const created = await create();
    const quoted = await request(server).post(`/api/ops/demands/${created.id}/quote`).set(ops)
      .send({ quotedPriceUsd: 35, quotedCount: 450, note: 'two days', expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.data.status, 'quoted');

    const accepted = await request(server).post(`/api/demands/${created.id}/accept`).set(buyerAuth);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.status, 'accepted');

    const assembling = await request(server).post(`/api/ops/demands/${created.id}/assemble`).set(ops).send({ note: 'pulling records' });
    assert.equal(assembling.status, 200);
    assert.equal(assembling.body.data.status, 'assembling');

    const fulfilled = await request(server).post(`/api/ops/demands/${created.id}/fulfill`).set(ops).send({ dataNFTId: pack.id });
    assert.equal(fulfilled.status, 200, JSON.stringify(fulfilled.body));
    assert.equal(fulfilled.body.data.demand.status, 'fulfilled');
    assert.equal(fulfilled.body.data.demand.dataNFTId, pack.id);
    assert.ok(fulfilled.body.data.purchase.id);
    assert.equal(fulfilled.body.data.order.id, 'order-1');

    const seen = await request(server).get(`/api/demands/${created.id}`).set(buyerAuth);
    assert.equal(seen.body.data.status, 'fulfilled');
    assert.equal(seen.body.data.pack.id, pack.id);
    assert.deepEqual(
      seen.body.data.events.map((e) => `${e.actor}:${e.action}:${e.fromStatus}->${e.toStatus}`),
      [
        'merchant:submit:null->submitted',
        'ops:quote:submitted->quoted',
        'merchant:accept:quoted->accepted',
        'ops:assemble:accepted->assembling',
        'ops:fulfill:assembling->fulfilled',
      ],
    );
    assert.deepEqual(prisma.demandEvent.rows.filter((e) => e.actor === 'ops').map((e) => e.actorId), ['ops-alice', 'ops-alice', 'ops-alice']);

    const again = [
      [buyerAuth, `/api/demands/${created.id}/accept`, 'not_quoted'],
      [buyerAuth, `/api/demands/${created.id}/cancel`, 'not_cancellable'],
      [ops, `/api/ops/demands/${created.id}/quote`, 'not_quotable'],
      [ops, `/api/ops/demands/${created.id}/decline`, 'not_open'],
      [ops, `/api/ops/demands/${created.id}/assemble`, 'not_assemblable'],
      [ops, `/api/ops/demands/${created.id}/fulfill`, 'not_fulfillable'],
    ];
    for (const [auth, path, code] of again) {
      const res = await request(server).post(path).set(auth).send({ dataNFTId: pack.id, reason: 'too late' });
      assert.equal(res.status, 400, `${path} -> ${res.status}`);
      assert.equal(res.body.code, code);
    }
    assert.equal(prisma.dataNFTPurchase.rows.length, 1, 'exactly one purchase');
  });

  it('a declined request needs a reason and can no longer be cancelled by the buyer', async () => {
    const created = await create();
    const ops = as(opsToken());
    const noReason = await request(server).post(`/api/ops/demands/${created.id}/decline`).set(ops).send({});
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'decline_reason');
    const declined = await request(server).post(`/api/ops/demands/${created.id}/decline`).set(ops).send({ note: 'no matching data' });
    assert.equal(declined.status, 200);
    assert.equal(declined.body.data.status, 'declined');
    assert.equal(declined.body.data.declineReason, 'no matching data');
    const cancel = await request(server).post(`/api/demands/${created.id}/cancel`).set(as(userToken(buyer)));
    assert.equal(cancel.status, 400);
    assert.equal(cancel.body.code, 'not_cancellable');
  });

  it('the buyer can cancel before acceptance; ops can then no longer quote', async () => {
    const created = await create();
    const cancel = await request(server).post(`/api/demands/${created.id}/cancel`).set(as(userToken(buyer)));
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.data.status, 'cancelled');
    const quote = await request(server).post(`/api/ops/demands/${created.id}/quote`).set(as(opsToken())).send({ quotedPriceUsd: 10 });
    assert.equal(quote.status, 400);
    assert.equal(quote.body.code, 'not_quotable');
  });
});
