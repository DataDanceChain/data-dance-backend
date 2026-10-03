/**
 * Decision 43 A — the public e-mail + password sign-up (POST /api/auth/register) is throttled on
 * every attempt (per IP, per e-mail) and every call leaves exactly one log line with no personal
 * data, so whoever has the server logs can see whether anything still uses it before it is closed.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

process.env.LOG_LEVEL = 'error';

// Stand-in controller: the real one needs a database. `x-test-status` picks the response so the
// tests can show that SUCCESSFUL sign-ups are now counted too.
const controllerPath = require.resolve('../../src/controllers/authController');
let controllerCalls = 0;
require.cache[controllerPath] = {
  id: controllerPath,
  filename: controllerPath,
  loaded: true,
  exports: {
    register: (req, res) => {
      controllerCalls += 1;
      const status = Number(req.get('x-test-status') || 201);
      res.status(status).json({ status: status === 201 ? 'success' : 'fail' });
    },
    login: (req, res) => res.status(401).json({ status: 'fail' }),
  },
};

const authRoutes = require('../../src/routes/authRoutes');
const { clearRateLimitStore, keyGenerators, rateLimiters } = require('../../src/middlewares/rateLimitMiddleware');
const usage = require('../../src/middlewares/registerUsageLog');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

const app = buildApp();
let captured = [];
const originalInfo = usage.logger.info;

function register(email, { ip = '203.0.113.10', status = 201, headers = {} } = {}) {
  let req = request(app)
    .post('/api/auth/register')
    .set('X-Forwarded-For', ip)
    .set('x-test-status', String(status));
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send({ email, password: 'Sup3r-secret-pass', name: 'Jane Person', referralCode: 'DDC-AB23CD' });
}

beforeEach(() => {
  clearRateLimitStore();
  controllerCalls = 0;
  captured = [];
  usage.logger.info = (message, meta) => captured.push({ message, meta });
});

process.on('exit', () => {
  usage.logger.info = originalInfo;
});

describe('POST /api/auth/register — throttled on every attempt (decision 43 A)', () => {
  it('exports the two new limiters', () => {
    assert.equal(typeof rateLimiters.registerIp, 'function');
    assert.equal(typeof rateLimiters.registerEmail, 'function');
  });

  it('caps SUCCESSFUL sign-ups per IP: the 11th within the hour is 429 and never reaches the controller', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await register(`person${i}@example.com`);
      assert.equal(res.status, 201, `sign-up ${i + 1} should pass`);
    }
    const blocked = await register('person10@example.com');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 60, 'blocked for the rest of the hour, not a minute');
    assert.equal(blocked.body.status, 'error');
    assert.equal(controllerCalls, 10);

    const elsewhere = await register('person11@example.com', { ip: '198.51.100.7' });
    assert.equal(elsewhere.status, 201, 'another network has its own budget');
  });

  it('caps attempts on one e-mail across many IPs, case and spaces ignored', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await register(i % 2 ? ' Target@Example.com ' : 'target@example.com', { ip: `198.51.100.${i + 1}`, status: 400 });
      assert.equal(res.status, 400);
    }
    const blocked = await register('TARGET@example.com', { ip: '198.51.100.99' });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /e-mail address/);
    const other = await register('someone-else@example.com', { ip: '198.51.100.99' });
    assert.equal(other.status, 201, 'a different address from the same IP is unaffected');
  });

  it('the failure-only `auth` limiter still applies on top', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await register(`fail${i}@example.com`, { status: 400 })).status, 400);
    }
    assert.equal((await register('fail5@example.com', { status: 400 })).status, 429);
  });

  it('never keys the store on the raw address', () => {
    const key = keyGenerators.bodyEmailHash({ body: { email: 'Jane@Example.com' }, ip: '203.0.113.1' });
    assert.match(key, /^email:[0-9a-f]{64}$/);
    assert.equal(key.includes('jane'), false);
    assert.equal(key, keyGenerators.bodyEmailHash({ body: { email: ' jane@example.com ' }, ip: '198.51.100.1' }));
    assert.equal(keyGenerators.bodyEmailHash({ body: {}, ip: '203.0.113.1' }), 'ip:203.0.113.1');
    assert.equal(keyGenerators.bodyEmailHash({ body: { email: 42 }, ip: '203.0.113.1' }), 'ip:203.0.113.1');
  });
});

describe('POST /api/auth/register — one usage log line per call, no personal data', () => {
  it('logs domain, calling host, client tag and outcome — and nothing that identifies the person', async () => {
    const res = await register('Jane.Person@Business.Example.com', {
      headers: {
        Origin: 'https://business.datadance.ai',
        Referer: 'https://business.datadance.ai/signup?email=jane.person%40business.example.com',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(captured.length, 1);
    const { meta } = captured[0];
    assert.equal(meta.event, 'auth_register_call');
    assert.equal(meta.emailDomain, 'business.example.com');
    assert.equal(meta.origin, 'business.datadance.ai');
    assert.equal(meta.refererHost, 'business.datadance.ai', 'host only: the query string is dropped');
    assert.equal(meta.client, 'Mozilla/5.0');
    assert.equal(meta.status, 201);
    assert.equal(meta.outcome, 'created');
    assert.equal(meta.hasReferralCode, true);
    assert.equal(meta.isOrganization, false);
    const line = JSON.stringify(captured[0]).toLowerCase();
    for (const pii of ['jane', 'person@', 'sup3r', 'ab23cd', '203.0.113.10']) {
      assert.equal(line.includes(pii), false, `log line must not contain ${pii}`);
    }
  });

  it('a rate-limited call is still exactly one line, with outcome rate_limited', async () => {
    for (let i = 0; i < 10; i += 1) await register(`p${i}@example.com`);
    captured = [];
    const res = await register('p10@example.com', { headers: { 'User-Agent': 'axios/1.9.0' } });
    assert.equal(res.status, 429);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].meta.outcome, 'rate_limited');
    assert.equal(captured[0].meta.status, 429);
    assert.equal(captured[0].meta.client, 'axios/1.9.0');
    assert.equal(captured[0].meta.origin, null, 'a server-side caller sends no Origin');
  });

  it('one line per call across outcomes', async () => {
    await register('a@example.com', { status: 400 });
    await register('b@example.com', { status: 500 });
    await register('c@example.com');
    assert.deepEqual(captured.map((c) => c.meta.outcome), ['rejected', 'error', 'created']);
  });

  it('reduces odd input to a fixed label instead of echoing it', () => {
    assert.equal(usage.emailDomain(undefined), 'none');
    assert.equal(usage.emailDomain(''), 'none');
    assert.equal(usage.emailDomain('no-at-sign'), 'invalid');
    assert.equal(usage.emailDomain('x@'), 'invalid');
    assert.equal(usage.emailDomain('x@localhost'), 'invalid');
    assert.equal(usage.emailDomain('x@exa mple.com'), 'invalid');
    assert.equal(usage.emailDomain('x@<script>.com'), 'invalid');
    assert.equal(usage.emailDomain('a@b@Gmail.COM'), 'gmail.com');
    assert.equal(usage.headerHost('not a url'), 'invalid');
    assert.equal(usage.headerHost(undefined), null);
    assert.equal(usage.clientTag('curl/8.7.1'), 'curl/8.7.1');
    assert.equal(usage.clientTag(undefined), null);
  });
});
