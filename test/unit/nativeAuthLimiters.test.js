/**
 * Native-login rate limiting (design §3.9, F5, F10): /64 buckets with a 4× /48 bucket on top for
 * IPv6, an LRU-capped store, the native 429 envelope, the success-only register limiter that is
 * inert while DDC_AUTH_ENABLED is off, and the legacy limiters left exactly as they were.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { listenLoopback } = require('../helpers/loopbackServer');

process.env.LOG_LEVEL = 'error';

const {
  createRateLimiter,
  createNativeLimiter,
  rateLimiters,
  keyGenerators,
  clearRateLimitStore,
  BoundedStore,
  NATIVE_STORE_MAX_KEYS,
  setNativeOtpTightened,
} = require('../../src/middlewares/rateLimitMiddleware');

const NATIVE_LIMITERS = ['nativeEmailStartBurst', 'nativeEmailStartHourly', 'nativeEmailVerify', 'nativeIdp', 'nativeXStart', 'nativeComplete', 'nativeIdentities', 'registerSuccessIp'];

const servers = [];

/**
 * A loopback-bound server (test/helpers/loopbackServer.js) whose req.ip is the X-Forwarded-For
 * value (trust proxy on one hop), answering the status named by X-Status.
 */
async function appWith(...handlers) {
  const app = express();
  app.set('trust proxy', 1);
  app.post('/t', ...handlers, (req, res) => res.status(Number(req.get('x-status') || 200)).json({ ok: true }));
  const server = await listenLoopback(app);
  servers.push(server);
  return server;
}

function from(server, ip, status) {
  const r = request(server).post('/t').set('X-Forwarded-For', ip);
  return status ? r.set('x-status', String(status)) : r;
}

const saved = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => clearRateLimitStore());
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
});

describe('native limiter catalogue', () => {
  it('exports every limiter the native router and authRoutes reference', () => {
    for (const name of NATIVE_LIMITERS) assert.equal(typeof rateLimiters[name], 'function', `rateLimiters.${name} missing`);
  });
});

describe('createNativeLimiter', () => {
  it('shares one bucket across a /64 and answers the native 429 envelope', async () => {
    const app = await appWith(createNativeLimiter({ name: 't-n64', windowMs: 60_000, max: 2, message: 'slow down' }));
    assert.equal((await from(app, '2001:db8:1:2::1')).status, 200);
    assert.equal((await from(app, '2001:db8:1:2:ffff::9')).status, 200, 'same /64');
    const blocked = await from(app, '2001:db8:1:2::abcd');
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, { status: 'fail', code: 'RATE_LIMITED', message: 'slow down', data: { retryAfterSec: Number(blocked.headers['retry-after']) } });
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    assert.equal((await from(app, '2001:db8:1:3::1')).status, 200, 'another /64 has its own bucket');
  });

  it('caps a /48 at 4× the /64 limit', async () => {
    const app = await appWith(createNativeLimiter({ name: 't-n48', windowMs: 60_000, max: 1, message: 'm' }));
    const statuses = [];
    for (let i = 1; i <= 5; i++) statuses.push((await from(app, `2001:db8:7:${i}::1`)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 429], 'the fifth /64 in one /48 is refused');
    assert.equal((await from(app, '2001:db8:8:1::1')).status, 200, 'another /48 is free');
  });

  it('IPv4 (and IPv4-mapped) clients are limited per address, with no /48 bucket', async () => {
    const app = await appWith(createNativeLimiter({ name: 't-n4', windowMs: 60_000, max: 1, message: 'm' }));
    assert.equal((await from(app, '203.0.113.5')).status, 200);
    assert.equal((await from(app, '203.0.113.5')).status, 429);
    assert.equal((await from(app, '203.0.113.6')).status, 200);
    assert.equal(keyGenerators.ip64({ ip: '::ffff:203.0.113.5' }), '203.0.113.5');
  });

  it('halves the e-mail start limits while the OTP soft budget is crossed', async () => {
    setEnv({ DDC_AUTH_OTP_PER_IP_HOUR: '4' });
    const app = await appWith(rateLimiters.nativeEmailStartHourly);
    setNativeOtpTightened(true);
    assert.equal((await from(app, '198.51.100.1')).status, 200);
    assert.equal((await from(app, '198.51.100.1')).status, 200);
    assert.equal((await from(app, '198.51.100.1')).status, 429, '4/h halved to 2/h');
    setNativeOtpTightened(false);
    assert.equal((await from(app, '198.51.100.2')).status, 200);
  });
});

describe('BoundedStore (LRU, F10)', () => {
  it('keeps at most maxKeys entries and evicts the least recently used', () => {
    const store = new BoundedStore(3);
    store.set('a', 1).set('b', 2).set('c', 3);
    assert.equal(store.get('a'), 1, 'touch a');
    store.set('d', 4);
    assert.deepEqual([...store.keys()], ['c', 'a', 'd']);
    assert.equal(store.has('b'), false);
    assert.equal(store.get('missing'), undefined);
  });

  it('the native store is capped at 50k keys', () => {
    assert.equal(NATIVE_STORE_MAX_KEYS, 50000);
  });

  it('a native limiter under key rotation never grows the store past its cap', async () => {
    const store = new BoundedStore(5);
    const limiter = createRateLimiter({ name: 't-cap', windowMs: 60_000, max: 1, store, keyGenerator: keyGenerators.ip64 });
    const app = await appWith(limiter);
    for (let i = 0; i < 12; i++) await from(app, `2001:db8:${i}::1`);
    assert.equal(store.size, 5);
  });
});

describe('registerSuccessIp (F5)', () => {
  it('is a pass-through while DDC_AUTH_ENABLED is off: no counting, no headers', async () => {
    setEnv({ DDC_AUTH_ENABLED: undefined });
    const app = await appWith(rateLimiters.registerSuccessIp);
    for (let i = 0; i < 8; i++) {
      const res = await from(app, '192.0.2.10', 201);
      assert.equal(res.status, 201);
      assert.equal(res.headers['x-ratelimit-limit'], undefined, 'no limiter headers while off');
    }
  });

  it('with the flag on, counts only successful registrations: the 6th success in an hour is refused', async () => {
    setEnv({ DDC_AUTH_ENABLED: 'true' });
    const app = await appWith(rateLimiters.registerSuccessIp);
    for (let i = 0; i < 10; i++) assert.equal((await from(app, '192.0.2.20', 400)).status, 400, 'failures never count');
    for (let i = 0; i < 5; i++) assert.equal((await from(app, '192.0.2.20', 201)).status, 201);
    const blocked = await from(app, '192.0.2.20', 201);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'RATE_LIMITED');
    assert.equal(blocked.body.status, 'error', 'legacy endpoint keeps the legacy 429 shape');
    assert.equal((await from(app, '192.0.2.21', 201)).status, 201, 'per client address');
  });
});

describe('legacy limiters are untouched', () => {
  it('a legacy limiter keeps the legacy 429 body and the shared store', async () => {
    const app = await appWith(createRateLimiter({ name: 't-legacy', windowMs: 60_000, max: 1, message: 'old' }));
    assert.equal((await from(app, '2001:db8:1:2::1')).status, 200);
    assert.equal((await from(app, '2001:db8:1:2::2')).status, 200, 'legacy limiters still key on the full address');
    await from(app, '2001:db8:1:2::1');
    const blocked = await from(app, '2001:db8:1:2::1');
    assert.equal(blocked.status, 429);
    assert.deepEqual(Object.keys(blocked.body).sort(), ['message', 'retryAfter', 'status']);
  });

  it('skipSuccessfulRequests still counts failures only', async () => {
    const app = await appWith(createRateLimiter({ name: 't-skip', windowMs: 60_000, max: 1, skipSuccessfulRequests: true, keyGenerator: keyGenerators.ip }));
    for (let i = 0; i < 3; i++) assert.equal((await from(app, '192.0.2.30')).status, 200);
    assert.equal((await from(app, '192.0.2.30', 401)).status, 401);
    assert.equal((await from(app, '192.0.2.30')).status, 429);
  });
});
