const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

process.env.LOG_LEVEL = 'error';

const {
  createRateLimiter,
  rateLimiters,
  keyGenerators,
  clearRateLimitStore,
} = require('../../src/middlewares/rateLimitMiddleware');

const EXPECTED_LIMITERS = [
  'upload', 'general', 'auth', 'public', 'verify',
  'web3authLogin', 'oauthRegister', 'oauthAuthorize', 'oauthToken', 'oauthTokenClient', 'oauthRevoke', 'oauthRevokeClient',
  'consent', 'partner', 'opsLogin', 'ssoTicket', 'ssoExchange',
];

function ok(req, res) {
  res.json({ ok: true, ip: req.ip });
}

function buildApp({ trustProxy = 1 } = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  return app;
}

beforeEach(() => clearRateLimitStore());

describe('rateLimiters catalogue', () => {
  it('exports every limiter the routes and the OAuth agent reference by name', () => {
    for (const name of EXPECTED_LIMITERS) {
      assert.equal(typeof rateLimiters[name], 'function', `rateLimiters.${name} missing`);
    }
  });
});

describe('createRateLimiter buckets', () => {
  it('blocks the (max+1)th request with 429, Retry-After and the default body', async () => {
    const app = buildApp();
    app.get('/a', createRateLimiter({ name: 't-basic', max: 2, windowMs: 60_000, message: 'slow' }), ok);

    const first = await request(app).get('/a');
    assert.equal(first.status, 200);
    assert.equal(first.headers['x-ratelimit-limit'], '2');
    assert.equal(first.headers['x-ratelimit-remaining'], '1');
    assert.equal((await request(app).get('/a')).status, 200);

    const blocked = await request(app).get('/a');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1, `Retry-After was ${blocked.headers['retry-after']}`);
    assert.ok(Number(blocked.headers['retry-after']) <= 60);
    assert.equal(blocked.body.status, 'error');
    assert.equal(blocked.body.message, 'slow');
    assert.equal(blocked.body.retryAfter, Number(blocked.headers['retry-after']));

    // still blocked, still carries Retry-After
    const again = await request(app).get('/a');
    assert.equal(again.status, 429);
    assert.ok(Number(again.headers['retry-after']) >= 1);
  });

  it('keeps separate buckets per limiter for the same client', async () => {
    const app = buildApp();
    app.get('/a', createRateLimiter({ name: 't-a', max: 1, windowMs: 60_000 }), ok);
    app.get('/b', createRateLimiter({ name: 't-b', max: 1, windowMs: 60_000 }), ok);

    assert.equal((await request(app).get('/a')).status, 200);
    assert.equal((await request(app).get('/a')).status, 429);
    assert.equal((await request(app).get('/b')).status, 200, 'limiter b must not share a bucket with a');
  });

  it('keeps separate buckets per key within one limiter', async () => {
    const app = buildApp();
    app.get('/k', createRateLimiter({ name: 't-key', max: 1, windowMs: 60_000, keyGenerator: (req) => req.get('x-k') }), ok);

    assert.equal((await request(app).get('/k').set('x-k', 'one')).status, 200);
    assert.equal((await request(app).get('/k').set('x-k', 'one')).status, 429);
    assert.equal((await request(app).get('/k').set('x-k', 'two')).status, 200);
  });

  it('frees the bucket once the window has passed', async () => {
    let clock = 1_000_000;
    const app = buildApp();
    app.get('/w', createRateLimiter({ name: 't-window', max: 1, windowMs: 1_000, now: () => clock }), ok);

    assert.equal((await request(app).get('/w')).status, 200);
    const blocked = await request(app).get('/w');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '1');
    clock += 1_001;
    assert.equal((await request(app).get('/w')).status, 200);
  });
});

describe('OAuth-style responses', () => {
  it('answers { error: "slow_down", error_description } under /oauth', async () => {
    const app = buildApp();
    const limiter = createRateLimiter({ name: 't-oauth', max: 1, windowMs: 60_000, message: 'too fast' });
    app.post('/oauth/token', limiter, ok);
    app.post('/api/other', limiter, ok);

    assert.equal((await request(app).post('/oauth/token')).status, 200);
    const blocked = await request(app).post('/oauth/token');
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers['retry-after']);
    assert.deepEqual(blocked.body, { error: 'slow_down', error_description: 'too fast' });

    // same limiter, same client, non-oauth path: existing shape
    const other = await request(app).post('/api/other');
    assert.equal(other.status, 429);
    assert.equal(other.body.status, 'error');
    assert.equal(other.body.message, 'too fast');
  });

  it('honours the mount prefix (originalUrl) when mounted on a router', async () => {
    const app = buildApp();
    const router = express.Router();
    router.post('/register', createRateLimiter({ name: 't-oauth-router', max: 1, windowMs: 60_000 }), ok);
    app.use('/oauth', router);

    assert.equal((await request(app).post('/oauth/register')).status, 200);
    const blocked = await request(app).post('/oauth/register');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, 'slow_down');
  });

  it('partner limiter always uses the RFC shape', async () => {
    const app = buildApp();
    app.get('/partner/tge/me', createRateLimiter({ name: 't-partner', max: 1, windowMs: 60_000, errorFormat: 'oauth', keyGenerator: keyGenerators.bearerTokenHash }), ok);
    await request(app).get('/partner/tge/me').set('Authorization', 'Bearer ddc_tge_one');
    const blocked = await request(app).get('/partner/tge/me').set('Authorization', 'Bearer ddc_tge_one');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, 'slow_down');
    assert.ok(blocked.headers['retry-after']);
  });
});

describe('IP keying behind a proxy', () => {
  it('uses X-Forwarded-For when trust proxy is on', async () => {
    const app = buildApp({ trustProxy: 1 });
    app.get('/ip', createRateLimiter({ name: 't-xff-on', max: 1, windowMs: 60_000, keyGenerator: keyGenerators.ip }), ok);

    const a = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.1');
    assert.equal(a.status, 200);
    assert.equal(a.body.ip, '203.0.113.1');
    assert.equal((await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.1')).status, 429);
    assert.equal((await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.2')).status, 200);
  });

  it('ignores X-Forwarded-For when trust proxy is off', async () => {
    const app = buildApp({ trustProxy: false });
    app.get('/ip', createRateLimiter({ name: 't-xff-off', max: 1, windowMs: 60_000, keyGenerator: keyGenerators.ip }), ok);

    assert.equal((await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.1')).status, 200);
    // a different spoofed XFF is still the same (loopback) client
    assert.equal((await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.2')).status, 429);
  });

  it('with two hops trusted, keys on the client behind two proxies', async () => {
    const app = buildApp({ trustProxy: 2 });
    app.get('/ip', createRateLimiter({ name: 't-xff-2', max: 1, windowMs: 60_000, keyGenerator: keyGenerators.ip }), ok);
    const a = await request(app).get('/ip').set('X-Forwarded-For', '198.51.100.7, 10.0.0.1');
    assert.equal(a.body.ip, '198.51.100.7');
  });
});

describe('key generators', () => {
  it('auth-style limiters key on IP, never on the submitted email', async () => {
    const app = buildApp();
    app.post('/login', createRateLimiter({ name: 't-auth-ip', max: 2, windowMs: 60_000, keyGenerator: keyGenerators.ip }), ok);
    await request(app).post('/login').send({ email: 'a@x.io' });
    await request(app).post('/login').send({ email: 'b@x.io' });
    const third = await request(app).post('/login').send({ email: 'c@x.io' });
    assert.equal(third.status, 429, 'a fresh email must not buy a fresh bucket');
  });

  it('bearerTokenHash keys on a hash of the token and falls back to IP', () => {
    const token = 'ddc_tge_secret_token_value';
    const req = { get: (h) => (h === 'authorization' ? `Bearer ${token}` : undefined), ip: '1.1.1.1' };
    const key = keyGenerators.bearerTokenHash(req);
    assert.equal(key, `tok:${crypto.createHash('sha256').update(token).digest('hex')}`);
    assert.ok(!key.includes(token));
    assert.equal(keyGenerators.bearerTokenHash({ get: () => undefined, ip: '1.1.1.1' }), 'ip:1.1.1.1');
  });

  it('partner limiter separates tokens', async () => {
    const app = buildApp();
    app.get('/p', createRateLimiter({ name: 't-partner-keys', max: 1, windowMs: 60_000, keyGenerator: keyGenerators.bearerTokenHash }), ok);
    assert.equal((await request(app).get('/p').set('Authorization', 'Bearer ddc_tge_aaa')).status, 200);
    assert.equal((await request(app).get('/p').set('Authorization', 'Bearer ddc_tge_aaa')).status, 429);
    assert.equal((await request(app).get('/p').set('Authorization', 'Bearer ddc_tge_bbb')).status, 200);
  });

  it('userOrIp prefers the authenticated user id', () => {
    assert.equal(keyGenerators.userOrIp({ user: { id: 'u9' }, ip: '1.1.1.1' }), 'u9');
    assert.equal(keyGenerators.userOrIp({ ip: '1.1.1.1' }), '1.1.1.1');
    assert.equal(keyGenerators.userOrIp({}), 'anonymous');
  });
});

describe('failure-only counting (opsLogin / auth)', () => {
  it('counts only responses with status >= 400', async () => {
    const app = buildApp();
    const limiter = createRateLimiter({ name: 't-fail', max: 2, windowMs: 60_000, skipSuccessfulRequests: true, keyGenerator: keyGenerators.ip });
    app.post('/login', limiter, (req, res) => {
      if (req.body.bad) return res.status(401).json({ status: 'fail' });
      return res.json({ ok: true });
    });

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await request(app).post('/login').send({})).status, 200, 'successes are free');
    }
    assert.equal((await request(app).post('/login').send({ bad: true })).status, 401);
    assert.equal((await request(app).post('/login').send({ bad: true })).status, 401);
    const blocked = await request(app).post('/login').send({});
    assert.equal(blocked.status, 429, 'after max failures even a good login is refused');
    assert.ok(blocked.headers['retry-after']);
  });
});

describe('failure-only counting under concurrency', () => {
  /** Hold the response open so every request is in flight at the same time. */
  function slowApp({ max, status }) {
    const app = buildApp();
    const limiter = createRateLimiter({
      name: `t-conc-${max}-${status}`, max, windowMs: 60_000,
      skipSuccessfulRequests: true, keyGenerator: keyGenerators.ip,
    });
    let reached = 0;
    app.post('/login', limiter, async (req, res) => {
      reached += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      res.status(status).json({ ok: status < 400 });
    });
    return { app, reached: () => reached };
  }

  it('lets at most `max` requests in at once, even before any of them has answered', async () => {
    // The old limiter counted in res.end, so N parallel attempts all passed the check first —
    // the ops-login brute-force control (§7.2 row 7) was nullified by concurrency alone.
    const { app, reached } = slowApp({ max: 2, status: 401 });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/login').set('X-Forwarded-For', '203.0.113.70'))
    );
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 2, `attempts admitted: ${statuses.join(',')}`);
    assert.equal(statuses.filter((s) => s === 429).length, 4);
    assert.equal(reached(), 2, 'the handler must never see more than max concurrent attempts');
  });

  it('gives the slot back once a concurrent request turns out to be a success', async () => {
    const { app } = slowApp({ max: 2, status: 200 });
    const first = await Promise.all(
      Array.from({ length: 2 }, () => request(app).post('/login').set('X-Forwarded-For', '203.0.113.71'))
    );
    assert.deepEqual(first.map((r) => r.status), [200, 200]);
    // Both finished successfully, so the bucket is empty again: successes stay free.
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app).post('/login').set('X-Forwarded-For', '203.0.113.71');
      assert.equal(res.status, 200, `success ${i} was charged to the bucket`);
    }
  });

  it('counts an aborted-then-failed response once, not twice', async () => {
    const app = buildApp();
    const limiter = createRateLimiter({
      name: 't-double-end', max: 2, windowMs: 60_000,
      skipSuccessfulRequests: true, keyGenerator: keyGenerators.ip,
    });
    app.post('/login', limiter, (req, res) => {
      res.status(401).json({ status: 'fail' });
      res.end(); // a second end() must not change the count
    });
    assert.equal((await request(app).post('/login').set('X-Forwarded-For', '203.0.113.72')).status, 401);
    assert.equal((await request(app).post('/login').set('X-Forwarded-For', '203.0.113.72')).status, 401);
    assert.equal((await request(app).post('/login').set('X-Forwarded-For', '203.0.113.72')).status, 429);
  });
});

describe('pre-configured limiters', () => {
  it('opsLogin allows 5 failures then blocks per IP', async () => {
    const app = buildApp();
    app.post('/api/ops/auth/login', rateLimiters.opsLogin, (req, res) => res.status(401).json({ status: 'fail' }));
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await request(app).post('/api/ops/auth/login').set('X-Forwarded-For', '203.0.113.50')).status, 401);
    }
    const blocked = await request(app).post('/api/ops/auth/login').set('X-Forwarded-For', '203.0.113.50');
    assert.equal(blocked.status, 429);
    assert.equal((await request(app).post('/api/ops/auth/login').set('X-Forwarded-For', '203.0.113.51')).status, 401);
  });

  it('web3authLogin allows 10 per minute per IP', async () => {
    const app = buildApp();
    app.post('/api/auth/web3auth-login', rateLimiters.web3authLogin, ok);
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await request(app).post('/api/auth/web3auth-login').set('X-Forwarded-For', '203.0.113.60')).status, 200);
    }
    assert.equal((await request(app).post('/api/auth/web3auth-login').set('X-Forwarded-For', '203.0.113.60')).status, 429);
  });
});
