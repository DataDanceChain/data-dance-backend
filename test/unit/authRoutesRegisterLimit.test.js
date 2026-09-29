/**
 * The success-only register limiter on the legacy POST /api/auth/register (design §3.9, F5; BE8).
 * The real src/routes/authRoutes.js router is mounted with a stand-in controller, so what is
 * tested is the actual mount: its order against the legacy `auth` limiter, and that with
 * DDC_AUTH_ENABLED off the route answers exactly as the route did before (`rateLimiters.auth`,
 * then the controller) — same statuses, bodies and limiter headers for the same traffic.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { listenLoopback } = require('../helpers/loopbackServer');

process.env.LOG_LEVEL = 'error';

// Stand-in controller: answers the status named by X-Status (default 201) and counts calls.
const calls = { register: 0, login: 0 };
const answer = (name) => (req, res) => {
  calls[name] += 1;
  const status = Number(req.get('x-status') || (name === 'register' ? 201 : 200));
  res.status(status).json(status < 400 ? { status: 'success', data: { who: name } } : { status: 'fail', message: 'nope' });
};
const controllerPath = path.join(__dirname, '../../src/controllers/authController.js');
require.cache[controllerPath] = {
  id: controllerPath,
  filename: controllerPath,
  loaded: true,
  exports: { register: answer('register'), login: answer('login') },
};

const authRoutes = require('../../src/routes/authRoutes');
const { rateLimiters, clearRateLimitStore, nativeRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

const servers = [];
async function serve(router) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', router);
  const server = await listenLoopback(app);
  servers.push(server);
  return server;
}

/** The route exactly as it was before BE8: the legacy limiter, then the controller. */
function previousRouter() {
  const router = express.Router();
  router.post('/register', rateLimiters.auth, answer('register'));
  router.post('/login', rateLimiters.auth, answer('login'));
  return router;
}

function post(server, route, ip, status) {
  const r = request(server).post(`/api/auth/${route}`).set('X-Forwarded-For', ip).send({ email: 'a@example.com', password: 'x' });
  return status ? r.set('x-status', String(status)) : r;
}

/** What a client can observe of one response (the reset timestamp moves with the clock). */
function observable(res) {
  return {
    status: res.status,
    body: res.body,
    limit: res.headers['x-ratelimit-limit'],
    remaining: res.headers['x-ratelimit-remaining'],
    hasReset: 'x-ratelimit-reset' in res.headers,
    retryAfter: res.headers['retry-after'],
  };
}

const savedEnabled = process.env.DDC_AUTH_ENABLED;
beforeEach(() => {
  clearRateLimitStore();
  calls.register = 0;
  calls.login = 0;
  delete process.env.DDC_AUTH_ENABLED;
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  if (savedEnabled === undefined) delete process.env.DDC_AUTH_ENABLED;
  else process.env.DDC_AUTH_ENABLED = savedEnabled;
});

describe('POST /api/auth/register with DDC_AUTH_ENABLED off (default)', () => {
  // Successes well past the native cap, then failures until the legacy limiter blocks.
  const traffic = [...Array(8).fill(201), 400, 400, 201, 400, 400, 400, 201, 201];

  async function run(server, ip) {
    const seen = [];
    for (const status of traffic) seen.push(observable(await post(server, 'register', ip, status)));
    return seen;
  }

  it('answers exactly as the previous route did, response for response', async () => {
    const before = await run(await serve(previousRouter()), '192.0.2.40');
    const beforeCalls = calls.register;
    clearRateLimitStore();
    calls.register = 0;
    const now = await run(await serve(authRoutes), '192.0.2.40');
    assert.deepEqual(now, before);
    assert.equal(calls.register, beforeCalls);
    assert.equal(now.filter((r) => r.status === 201).length >= 8, true, 'more than five successes per hour are allowed while off');
    assert.equal(now.at(-1).status, 429, 'the legacy auth limiter still blocks after five failures');
    assert.deepEqual(Object.keys(now.at(-1).body).sort(), ['message', 'retryAfter', 'status'], 'legacy 429 body, no code');
  });

  it('adds no limiter bucket of its own', async () => {
    const server = await serve(authRoutes);
    for (let i = 0; i < 7; i++) assert.equal((await post(server, 'register', '192.0.2.41')).status, 201);
    assert.equal(nativeRateLimitStore.size, 0);
  });
});

describe('POST /api/auth/register with DDC_AUTH_ENABLED=true', () => {
  beforeEach(() => {
    process.env.DDC_AUTH_ENABLED = 'true';
  });

  it('allows five successful registrations per hour per address; the sixth is refused before the controller', async () => {
    const server = await serve(authRoutes);
    for (let i = 0; i < 5; i++) assert.equal((await post(server, 'register', '192.0.2.50')).status, 201);
    const blocked = await post(server, 'register', '192.0.2.50');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'RATE_LIMITED');
    assert.equal(blocked.body.status, 'error', 'legacy endpoint, legacy 429 shape');
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.equal(calls.register, 5, 'the refused registration never reached the controller');
    assert.equal((await post(server, 'register', '192.0.2.51')).status, 201, 'another address is unaffected');
  });

  it('counts only successes: failed registrations never use the budget', async () => {
    const server = await serve(authRoutes);
    // Four failures stay under the legacy auth limiter (five failures per 15 minutes).
    for (let i = 0; i < 4; i++) assert.equal((await post(server, 'register', '192.0.2.52', 400)).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await post(server, 'register', '192.0.2.52')).status, 201);
    assert.equal((await post(server, 'register', '192.0.2.52')).status, 429);
  });

  it('IPv6 addresses in one /64 share the budget', async () => {
    const server = await serve(authRoutes);
    for (let i = 1; i <= 5; i++) assert.equal((await post(server, 'register', `2001:db8:7:1::${i}`)).status, 201);
    assert.equal((await post(server, 'register', '2001:db8:7:1::99')).status, 429);
    assert.equal((await post(server, 'register', '2001:db8:7:2::1')).status, 201, 'the next /64 is separate');
  });

  it('its own 429s do not spend the legacy failure budget shared with password login', async () => {
    const server = await serve(authRoutes);
    for (let i = 0; i < 5; i++) await post(server, 'register', '192.0.2.53');
    for (let i = 0; i < 10; i++) assert.equal((await post(server, 'register', '192.0.2.53')).status, 429);
    // The legacy `auth` limiter allows five failures per 15 minutes per IP across login and register.
    for (let i = 0; i < 5; i++) assert.equal((await post(server, 'login', '192.0.2.53', 401)).status, 401, `failed login ${i + 1}`);
    assert.equal((await post(server, 'login', '192.0.2.53')).status, 429, 'the sixth failure-window request is the legacy block');
  });

  it('a legacy-limiter block never counts as a registration', async () => {
    const server = await serve(authRoutes);
    for (let i = 0; i < 5; i++) await post(server, 'login', '192.0.2.54', 401);
    assert.equal((await post(server, 'register', '192.0.2.54')).status, 429, 'blocked by the legacy limiter');
    const bucket = [...nativeRateLimitStore.entries()].find(([k]) => k.startsWith('registerSuccessIp:'));
    assert.ok(bucket, 'the native limiter ran first and opened a bucket');
    assert.equal(bucket[1].requests.length, 0, 'the slot was given back');
  });

  it('successful responses carry the legacy limiter headers, as before', async () => {
    const server = await serve(authRoutes);
    const res = await post(server, 'register', '192.0.2.55');
    assert.equal(res.status, 201);
    const resetMs = Date.parse(res.headers['x-ratelimit-reset']) - Date.now();
    assert.ok(resetMs > 14 * 60 * 1000 && resetMs <= 15 * 60 * 1000 + 1000, `legacy 15-minute window, got ${resetMs} ms`);
  });
});
