'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createProxy } = require('./first-handoff-proxy');

const delay = ms => new Promise(r => setTimeout(r, ms));
const proof = { ingressVerified: true, directConnections: 0, unresolvedLegacyWrites: 0 };
const validRoute = '/api/auth/email-code/send';
async function listen(s) { s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s; }
async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Condition not observed');
}
function call(server, pathname, method = 'GET', agent, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method,
      localAddress: '127.0.0.1', path: pathname, agent, headers: { 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let value = '';
      res.on('data', data => { value += data; });
      res.on('end', () => resolve({ status: res.statusCode, value }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('unknown flow, protected identities, positive observation and guarded inverse', { timeout: 9000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddc-handoff-service-'));
  const headersSeen = [];
  const legacy = await listen(http.createServer((req, res) => {
    headersSeen.push(req.headers['x-forwarded-for']);
    req.resume();
    res.write('leg');
    setTimeout(() => res.end('acy'), 10);
  }));
  const allUpgrades = new Set();
  legacy.on('upgrade', (req, socket, head) => {
    allUpgrades.add(socket); socket.on('close', () => allUpgrades.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  const sharedPath = path.join(tmp, 'shared.sock');
  const shared = http.createServer((req, res) => { req.resume(); res.end('shared'); });
  shared.listen(sharedPath);
  await once(shared, 'listening');
  let checked, clock = 0;
  const proxy = createProxy({ stateDir: tmp, legacyOrigin: 'http://127.0.0.1:' + legacy.address().port,
    sharedSocket: sharedPath, forwardTiming: true,
    verifyClosure: () => checked, now: () => clock });
  const keep = new http.Agent({ keepAlive: true });
  try {
    await listen(proxy.server);
    assert.equal(proxy.observe('email-code'), false);
    checked = { ...proof, directConnections: 1 };
    assert.equal(proxy.observe('email-code'), false);
    checked = { ...proof, unresolvedLegacyWrites: 1 };
    assert.equal(proxy.observe('email-code'), false);
    assert.equal((await call(proxy.server, validRoute, 'POST', keep)).value, 'legacy');
    assert.equal(headersSeen.at(-1), '127.0.0.1');
    checked = proof;
    assert.equal(proxy.observe('email-code'), true);
    assert.equal(proxy.prepareReverse(), true);
    clock += 3600001;
    assert.equal((await call(proxy.server, validRoute, 'POST', keep)).value, 'legacy');
    await until(() => proxy.status().families['email-code'].pending === 0);
    assert.equal(proxy.observe('email-code'), true);
    clock += 3600001;
    assert.equal((await call(proxy.server, '/API/AUTH/EMAIL-CODE/VERIFY/?x=1', 'POST', keep)).value, 'shared');
    assert.equal((await call(proxy.server, '/api/auth/email-bind/send', 'POST', keep)).value, 'legacy');
    assert.equal((await call(proxy.server, '/unassigned?query=unchanged', 'GET', keep)).value, 'legacy');
    assert.equal((await call(proxy.server, '/api/app/journey-timing', 'POST', keep)).value, 'shared');
    assert.equal((await call(proxy.server, '/api/app/journey-timing?extra=1', 'POST', keep)).value, 'legacy');
    assert.equal(proxy.prepareReverse(), false);
    const s = net.connect(proxy.server.address().port, '127.0.0.1');
    await once(s, 'connect');
    s.write('GET /unassigned-upgrade HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    let upgraded = '';
    s.on('data', b => { upgraded += b.toString(); });
    await until(() => upgraded.includes('101 Switching Protocols'));
    s.write('upgraded-legacy-frame');
    await until(() => upgraded.includes('upgraded-legacy-frame'));
    s.destroy();
    keep.destroy();
    await until(() => allUpgrades.size === 0);
    await proxy.close();
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'owners.json')));
    assert.equal(saved['email-code'].owner, 'shared');
    assert.equal(saved['email-bind'].owner, 'legacy');
  } finally {
    keep.destroy();
    for (const s of allUpgrades) s.destroy();
    proxy.server.closeAllConnections();
    await Promise.allSettled([proxy.close(), new Promise(r => legacy.close(r)), new Promise(r => shared.close(r))]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('restricted Unix ingress retains the exact no-XFF key and the last forwarded IPv6 key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddc-peer-'));
  const socketPath = path.join(dir, 'ingress.sock');
  const legacy = await listen(http.createServer((req, res) => res.end(req.headers['x-forwarded-for'])));
  const proxy = createProxy({ stateDir: dir, trustedUnixIngress: true, unixBaselinePeer: '::ffff:172.19.0.1',
    legacyOrigin: 'http://127.0.0.1:' + legacy.address().port, sharedSocket: path.join(dir, 'unused.sock') });
  try {
    proxy.server.listen(socketPath);
    await once(proxy.server, 'listening');
    for (const [headers, expected] of [
      [{}, '::ffff:172.19.0.1'],
      [{ 'x-forwarded-for': '192.0.2.1, 2001:db8::1' }, '2001:db8::1'],
    ]) {
      const response = await new Promise((resolve, reject) =>
        http.get({ socketPath, path: '/', headers, agent: false }, resolve).on('error', reject));
      assert.equal(response.statusCode, 200);
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), expected);
    }
  } finally {
    await proxy.close();
    await new Promise(resolve => legacy.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real CLI separates mode-0600 control socket from private legacy-default TCP', { timeout: 9500 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddc-cli-handoff-'));
  const legacy = await listen(http.createServer((req, res) => res.end('legacy')));
  const probe = await listen(http.createServer());
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const sharedPath = path.join(tmp, 'shared.sock');
  const controlPath = path.join(tmp, 'control.sock');
  // The shared application is deliberately not started in this default-legacy check.
  const child = spawn(process.execPath, [path.join(__dirname, 'first-handoff-proxy.js')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH,
      DDC_HANDOFF_LISTEN_HOST: '127.0.0.1', DDC_HANDOFF_LISTEN_PORT: String(port),
      DDC_HANDOFF_CONTROL_SOCKET: controlPath, DDC_HANDOFF_STATE_DIR: tmp,
      DDC_HANDOFF_LEGACY_ORIGIN: 'http://127.0.0.1:' + legacy.address().port,
      DDC_HANDOFF_SHARED_SOCKET: sharedPath,
    },
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  function command(route, method = 'POST') {
    return new Promise((resolve, reject) => {
      const r = http.request({ socketPath: controlPath, path: route, method, agent: false }, s => {
        let body = '';
        s.on('data', val => { body += val; });
        s.on('end', () => resolve({ code: s.statusCode, body: JSON.parse(body) }));
      });
      r.on('error', reject);
      r.end();
    });
  }
  try {
    await until(() => fs.existsSync(controlPath));
    assert.equal(fs.statSync(controlPath).mode & 0o777, 0o600);
    const verdict = await command('/observe/email-code');
    assert.equal(verdict.code, 409);
    assert.equal(verdict.body.families['email-code'].owner, 'legacy');
    assert.equal((await command('/prepare-reverse')).code, 200);
    assert.equal((await call({ address: () => ({ port }) }, '/status')).value, 'legacy');
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null], stderr);
    assert.equal(fs.existsSync(controlPath), false);
    assert.equal(fs.existsSync(path.join(tmp, 'owner.lock')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await new Promise(resolve => legacy.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('finished upload survives downstream disconnect; upstream abort latches unknown and never retries', { timeout: 9000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddc-handoff-disconnect-'));
  let n = 0, release;
  const old = await listen(http.createServer((req, res) => {
    n++;
    req.on('end', () => {
      release = n === 2 ? () => res.socket.destroy() : () => res.end('confirmed terminal');
    });
    req.resume();
  }));
  const next = await listen(http.createServer((req, res) => res.end('new')));
  const p = createProxy({ stateDir: tmp, legacyOrigin: 'http://127.0.0.1:' + old.address().port,
    sharedOrigin: 'http://127.0.0.1:' + next.address().port, verifyClosure: () => proof });
  try {
    await listen(p.server);
    assert.equal(p.observe('email-code'), true);
    const gone = http.request({ hostname: '127.0.0.1', port: p.server.address().port,
      path: validRoute, method: 'POST', headers: { 'Content-Length': '2' }, agent: false });
    gone.on('error', () => {});
    gone.end('{}');
    await until(() => Boolean(release));
    gone.destroy();
    await delay(40);
    assert.equal(p.status().families['email-code'].pending, 1);
    assert.equal(p.observe('email-code'), false);
    release();
    await until(() => p.status().families['email-code'].pending === 0);
    assert.equal(p.status().families['email-code'].unknown, 0);
    assert.equal(p.observe('email-code'), true);
    release = undefined;
    const uncertain = call(p.server, validRoute, 'POST', false, '{}');
    await until(() => Boolean(release));
    release();
    assert.equal((await uncertain).status, 502);
    assert.equal(n, 2);
    assert.equal(p.status().families['email-code'].unknown, 1);
    assert.equal(p.observe('email-code'), false);
    assert.equal(p.observe('email-bind'), true, 'different family has its own evidence');
    assert.equal(p.prepareReverse(), true);
    release = undefined;
    const detached = http.request({ hostname: '127.0.0.1', port: p.server.address().port,
      path: '/api/auth/email-bind/send', method: 'POST', headers: { 'Content-Length': '2' }, agent: false });
    detached.on('error', () => {});
    detached.end('{}');
    await until(() => Boolean(release));
    detached.destroy();
    let closed = false;
    const draining = p.close().then(() => { closed = true; });
    await delay(40);
    assert.equal(closed, false);
    assert.equal(p.status().families['email-bind'].pending, 1);
    release();
    await draining;
    assert.equal(p.status().families['email-bind'].pending, 0);
  } finally {
    p.server.closeAllConnections();
    await Promise.allSettled([p.close(), new Promise(r => old.close(r)), new Promise(r => next.close(r))]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('closure watchdog disarms without a request and non-migrated streams inherit the old lifetime', { timeout: 9000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddc-stream-handoff-'));
  const old = await listen(http.createServer((req, res) => {
    req.resume();
    if (req.url === '/existing-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => res.end('data: legacy\n\n'), 130);
    } else res.end('legacy');
  }));
  const next = await listen(http.createServer((req, res) => res.end('shared')));
  let alive = true, clock = 0;
  const p = createProxy({stateDir: tmp, legacyOrigin: 'http://127.0.0.1:'+old.address().port,
    sharedOrigin: 'http://127.0.0.1:'+next.address().port, verifyClosure: () => alive && proof,
    now: () => clock, closureHeartbeatMs: 15, upstreamTimeoutMs: 35});
  try {
    await listen(p.server);
    assert.equal(p.observe('email-code'), true);
    alive = false;
    await until(() => p.status().observing.length === 0);
    assert.equal((await call(p.server, validRoute, 'POST')).value, 'legacy');
    await until(() => p.status().families['email-code'].pending === 0);
    const finished = await call(p.server, '/existing-stream');
    assert.equal(finished.status, 200);
    assert.equal(finished.value, 'data: legacy\n\n');
    alive = true;
    assert.equal(p.observe('email-code'), true);
    clock += 3600001;
    assert.equal((await call(p.server, validRoute, 'POST')).value, 'shared');
    alive = false;
    assert.equal((await call(p.server, validRoute, 'POST')).status, 503);
    assert.equal((await call(p.server, '/unchanged')).value, 'legacy');
  } finally {
    p.server.closeAllConnections();
    await Promise.allSettled([p.close(), new Promise(r => old.close(r)), new Promise(r => next.close(r))]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
