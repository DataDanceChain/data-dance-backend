'use strict';
// Run against a dedicated, disposable local database with the auth-window migration.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.hostname, 'localhost');
assert.equal(url.pathname, '/cutover_test');
assert.match(url.searchParams.get('host') || '', /^\/private\/tmp\/ddc-route-[A-Za-z0-9]+\/socket$/);

process.env.DATABASE_URL = url.href;
process.env.DDC_SHARED_AUTH_STATE = 'true';
if (process.argv[2] === 'worker') {
  const express = require('express');
  const { createRateLimiter } = require('../../src/middlewares/rateLimitMiddleware');
  const app = express();
  const options = { name: process.env.TEST_BUCKET, windowMs: 3600000, max: 2 };
  app.get('/all', createRateLimiter(options), (_, res) => res.sendStatus(200));
  app.get('/outcome/:status', createRateLimiter({
    ...options, name: options.name + '/failed', skipSuccessfulRequests: true,
  }), (req, res) => res.sendStatus(Number(req.params.status)));
  const server = app.listen(0, '127.0.0.1', () => process.send(server.address().port));
} else {
  const { test } = require('node:test');
  test('two processes share admission, success refunds and retained failures after retirement', { timeout: 15000 }, async t => {
    process.env.TEST_BUCKET = randomUUID();
    const workers = [];
    async function stop(child) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = once(child, 'exit');
      child.kill();
      await done;
    }
    t.after(() => Promise.all(workers.map(stop)));
    async function start() {
      const child = fork(__filename, ['worker'], { silent: true });
      workers.push(child);
      const [port] = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => { throw Error('Fixture worker exited during startup'); }),
      ]);
      return { child, call: async path => (await fetch('http://127.0.0.1:' + port + path)).status };
    }
    const [a, b] = await Promise.all([start(), start()]);
    const outcomes = await Promise.all([a.call('/all'), b.call('/all'), b.call('/all')]);
    assert.deepEqual(outcomes.sort(), [200, 200, 429]);
    assert.equal(await a.call('/outcome/200'), 200);
    assert.equal(await b.call('/outcome/200'), 200);
    assert.equal(await a.call('/outcome/400'), 400);
    await stop(a.child);
    assert.equal(await b.call('/all'), 429);
    assert.equal(await b.call('/outcome/400'), 400);
    assert.equal(await b.call('/outcome/200'), 429);
  });
}
