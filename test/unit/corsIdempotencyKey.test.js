/**
 * The REAL application (src/app.js) lets a browser send the Idempotency-Key header that the ops
 * site's merchant credit (POST /api/ops/merchants/:userId/credit) may carry: a CORS preflight from
 * an allowed origin that asks for it is answered with it in Access-Control-Allow-Headers.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  // passWebServiceController builds an APNs provider at load time; identifiers only.
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  JWT_SECRET: 'cors-idempotency-key-test-secret',
});
delete process.env.FRONTEND_URL;
delete process.env.NODE_ENV;

const app = require('../../src/app');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

describe('CORS: the Idempotency-Key header', () => {
  it('a preflight for the merchant credit that asks for Idempotency-Key is allowed to send it', async () => {
    const res = await request(server)
      .options('/api/ops/merchants/merchant-1/credit')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    const allowed = String(res.headers['access-control-allow-headers'] || '').split(',').map((h) => h.trim().toLowerCase());
    assert.ok(allowed.includes('idempotency-key'), `allowed: ${allowed.join(', ')}`);
    assert.ok(allowed.includes('authorization') && allowed.includes('content-type'));
  });
});
