'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { trackFamily } = require('./first-handoff');
const { openJournal } = require('./first-handoff-journal');

const FAMILIES = {
  'email-code': [60 * 60 * 1000, /^\/api\/auth\/email-code\/(?:send|verify)\/?$/i],
  'email-bind': [60 * 60 * 1000, /^\/api\/auth\/email-bind\/(?:send|verify)\/?$/i],
  oauth: [5 * 60 * 1000, /^\/oauth\/(?:token|revoke)\/?$/i],
};
const HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect']);
const normalize = address => address?.replace(/^::ffff:/, '');
const LOOPBACK = address => normalize(address) === '::1' || /^127\./.test(normalize(address) || '');
function privateIP(address) {
  const p = normalize(address);
  if (!net.isIP(p)) return false;
  if (LOOPBACK(p)) return true;
  if (net.isIP(p) === 6) return /^f[cd][0-9a-f]{2}:/i.test(p);
  const [a, b] = p.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function privateOrigin(value) {
  const u = new URL(value);
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'http:' || !privateIP(hostname) || u.pathname !== '/' ||
      u.username || u.password || u.search || u.hash) throw new Error('Expected a private HTTP origin');
  return { hostname, port: u.port || 80 };
}
function boundedSeconds(value, fallback) {
  const seconds = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('Invalid timeout');
  return seconds * 1000;
}
const familyFor = req => {
  if (req.method !== 'POST') return undefined;
  const raw = req.url || '';
  // Match the unchanged origin-form path, or its HTTP absolute-form equivalent.
  // Do not normalize dot segments or decode escapes before classifying.
  const target = raw.startsWith('/') ? raw : raw.match(/^https?:\/\/[^/?#]+(\/[^?#]*)/i)?.[1] || '';
  const pathname = target.split('?', 1)[0];
  return Object.keys(FAMILIES).find(n => FAMILIES[n][1].test(pathname));
};
function forwarded(headers) {
  const nominated = new Set(String(headers.connection || '').split(',').map(s => s.trim().toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k) && !nominated.has(k)));
}

function createProxy(options) {
  const names = Object.keys(FAMILIES);
  const trusted = new Set((options.trustedProxyIPs || []).map(normalize));
  if ([...trusted].some(address => !privateIP(address))) throw new Error('Expected exact private forwarder IPs');
  if (options.legacyLocalAddress && !privateIP(options.legacyLocalAddress)) {
    throw new Error('Expected a private dedicated legacy source');
  }
  if (Boolean(options.sharedOrigin) === Boolean(options.sharedSocket) ||
      (options.sharedSocket && !path.isAbsolute(options.sharedSocket))) {
    throw new Error('Expected exactly one shared HTTP origin or absolute Unix socket');
  }
  if (options.sharedSocket) {
    const dir = fs.lstatSync(path.dirname(options.sharedSocket));
    if (!dir.isDirectory() || (dir.mode & 0o077)) throw new Error('Shared socket directory must be private');
  }
  const origins = {
    legacy: privateOrigin(options.legacyOrigin),
    shared: options.sharedSocket ? { socketPath: options.sharedSocket } : privateOrigin(options.sharedOrigin),
  };
  const agents = Object.fromEntries(['legacy', 'shared'].map(x => [x, new http.Agent({ keepAlive: true })]));
  const journal = openJournal(options.stateDir, names);
  const armed = new Set();
  const groups = {};
  const upgraded = new Set();
  let closePromise;
  const status = () => ({
    storageHealthy: journal.healthy, families: journal.status(), observing: [...armed].sort(),
    activeUpgrades: upgraded.size,
  });
  for (const name of names) groups[name] = trackFamily({
    lifetimeMs: FAMILIES[name][0], initialOwner: journal.status()[name].owner,
    now: options.now,
    commitOwner: () => journal.commit(name),
  });
  function invalidate(name) {
    if (name) {
      armed.delete(name);
      groups[name].invalidateObservation();
    } else for (const family of names) invalidate(family);
  }
  function getProof(name) {
    let proof;
    try { proof = options.verifyClosure?.(name); } catch { return undefined; }
    if (proof?.ingressVerified !== true || proof.directConnections !== 0 || proof.unresolvedLegacyWrites !== 0) {
      return undefined;
    }
    return proof;
  }
  const heartbeat = options.verifyClosure && setInterval(() => {
    for (const name of armed) if (!getProof(name)) invalidate(name);
  }, options.closureHeartbeatMs ?? 500);
  heartbeat?.unref();
  function observe(name) {
    if (!Object.hasOwn(groups, name)) return false;
    invalidate(name);
    const row = journal.status()[name];
    const proof = getProof(name);
    if (!journal.healthy || row.owner !== 'legacy' || row.pending || row.unknown || !proof) return false;
    if (groups[name].startObservation(proof) !== true) return false;
    armed.add(name);
    return true;
  }
  function prepareReverse() {
    invalidate();
    return journal.healthy && Object.values(journal.status()).every(r => r.owner === 'legacy');
  }
  function requestOptions(req, owner, upgrade = false) {
    const peer = req.socket.remoteAddress;
    const out = forwarded(req.headers);
    const given = typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',').at(-1).trim() : '';
    // Express trust-proxy=1 selects the closest trusted edge-supplied address.
    // A direct request must not supply its own effective limiter identity.
    // Opt-in only in a wrapper whose sole data listener is a restricted Unix socket.
    const fromUnixIngress = options.trustedUnixIngress === true && peer === undefined;
    // When Nginx used TCP, a request without XFF inherited its actual upstream
    // peer. A Unix socket has no IP. Preserve the verified baseline key only
    // on this private ingress; direct TCP connections retain their own peer.
    const fallback = fromUnixIngress ? options.unixBaselinePeer : peer;
    const effective = (fromUnixIngress || trusted.has(normalize(peer))) && given ? given : fallback;
    if (!net.isIP(effective)) throw new Error('Cannot determine client identity');
    delete out.forwarded;
    delete out['x-real-ip'];
    out['x-forwarded-for'] = effective;
    if (upgrade) {
      out.connection = 'Upgrade';
      out.upgrade = req.headers.upgrade;
    }
    const localAddress = owner === 'legacy' ? options.legacyLocalAddress : undefined;
    return { ...origins[owner], method: req.method, path: req.url, headers: out, localAddress,
      agent: upgrade ? false : agents[owner] };
  }
  function reply(res, code) {
    if (!res.destroyed && !res.headersSent) res.writeHead(code, { 'Cache-Control': 'no-store' }).end();
  }
  const server = http.createServer((req, res) => {
    let family, admission, claimed, upstream, finished = false, activeResponse;
    let auxiliary = false;
    function finish(completed) {
      if (finished || !claimed) return;
      finished = true;
      try { journal.end(family, completed); } catch { completed = false; }
      if (!completed) invalidate(family);
      admission.finish(completed);
    }
    try {
      family = familyFor(req);
      let owner = 'legacy';
      if (family) {
        if (!journal.healthy) return reply(res, 503);
        const onShared = journal.status()[family].owner === 'shared';
        if (armed.has(family) && !getProof(family)) invalidate(family);
        if (onShared && !getProof(family)) return reply(res, 503);
        admission = groups[family].admit();
        owner = admission.owner;
        if (owner === 'legacy') {
          // Durable pending precedes the network attempt. A crash cannot lose it.
          journal.begin(family);
          claimed = true;
        }
      } else if (options.forwardTiming && req.method === 'POST' && req.url === '/api/app/journey-timing') {
        owner = 'shared';
        auxiliary = true;
      }
      upstream = http.request(requestOptions(req, owner), incoming => {
        activeResponse = incoming;
        incoming.on('end', () => finish(incoming.complete));
        incoming.on('aborted', () => finish(false));
        incoming.on('error', () => finish(false));
        incoming.on('close', () => { if (!incoming.complete) finish(false); });
        if (res.destroyed) incoming.resume();
        else {
          res.writeHead(incoming.statusCode, forwarded(incoming.headers));
          res.flushHeaders();
          incoming.pipe(res);
        }
      });
      upstream.on('error', () => { finish(false); reply(res, 502); });
      // Do not impose a new upstream idle deadline on unrelated streams. Their
      // existing outer ingress and application own that lifetime.
      if (family || auxiliary) {
        upstream.setTimeout(options.upstreamTimeoutMs || 120000,
          () => upstream.destroy(new Error('Upstream idle deadline')));
      }
      req.on('aborted', () => { if (!req.complete) upstream.destroy(new Error('Upload incomplete')); });
      req.on('error', () => { if (!req.complete) upstream.destroy(new Error('Upload failed')); });
      res.on('close', () => {
        if (res.writableFinished) return;
        if (activeResponse) {
          activeResponse.unpipe(res);
          if (claimed) activeResponse.resume();
          else activeResponse.destroy();
        } else if (!claimed || !req.complete) upstream.destroy(new Error('Client departed'));
      });
      // No retries, fallbacks or half-body replay.
      req.pipe(upstream);
    } catch {
      finish(false);
      if (admission && !claimed && admission.owner === 'legacy') admission.finish(false);
      if (family) invalidate(family);
      upstream?.destroy();
      reply(res, 503);
      req.resume();
    }
  });
  // Upgrade traffic has no migration semantics. Keep the existing legacy endpoint.
  server.on('upgrade', (req, client, head) => {
    if (!req.headers.upgrade || familyFor(req)) return client.destroy();
    let upstream;
    try { upstream = http.request(requestOptions(req, 'legacy', true)); }
    catch { return client.destroy(); }
    upgraded.add(client);
    client.once('close', () => { upgraded.delete(client); upstream.destroy(); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      socket.on('error', () => client.destroy());
      socket.on('close', () => client.end());
      if (client.destroyed) return socket.destroy();
      const headers = response.rawHeaders.reduce((s, v, i) => s + (i % 2 ? v + '\r\n' : v + ': '), '');
      client.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n${headers}\r\n`);
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) socket.write(head);
      client.once('close', () => socket.destroy());
      client.pipe(socket).pipe(client);
    });
    // Propagate upgrade refusals without sending an unparsed chunk header.
    upstream.on('response', response => {
      const headers = Object.entries(forwarded(response.headers)).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map(line => `${k}: ${line}\r\n`)).join('');
      client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers}Connection: close\r\n\r\n`);
      response.on('error', () => client.destroy());
      response.pipe(client);
    });
    upstream.end();
  });

  return {
    server, status, observe, invalidate, prepareReverse,
    close() {
      closePromise ??= (async () => {
        invalidate();
        if (heartbeat) clearInterval(heartbeat);
        let listenerClosed = !server.listening;
        if (!listenerClosed) server.close(() => { listenerClosed = true; });
        const deadline = performance.now() + (options.stopDrainMs ?? 120000);
        while (!listenerClosed || upgraded.size || Object.values(journal.status()).some(row => row.pending)) {
          if (performance.now() >= deadline) {
            // Do not cancel somebody's active stream, or clear the crash latch.
            throw new Error('Proxy still has active connections or legacy work');
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        Object.values(agents).forEach(a => a.destroy());
        journal.release();
      })();
      return closePromise;
    },
  };
}

function start(env = process.env) {
  const host = env.DDC_HANDOFF_LISTEN_HOST;
  const port = Number(env.DDC_HANDOFF_LISTEN_PORT);
  const socketPath = env.DDC_HANDOFF_CONTROL_SOCKET;
  const stateDir = env.DDC_HANDOFF_STATE_DIR;
  if (!privateIP(host) || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      !socketPath || !stateDir || path.dirname(socketPath) !== stateDir || fs.existsSync(socketPath)) {
    throw new Error('Invalid private TCP or control endpoint');
  }
  const adapter = env.DDC_HANDOFF_CLOSURE_MODULE;
  if (adapter && !path.isAbsolute(adapter)) throw new Error('Closure module must be absolute');
  if (adapter) {
    const stat = fs.lstatSync(adapter);
    if (!stat.isFile() || (stat.mode & 0o022)) throw new Error('Closure module must not be group/world writable');
  }
  const verifyClosure = adapter ? require(adapter).verifyClosure : undefined;
  if (adapter && typeof verifyClosure !== 'function') throw new Error('Invalid closure verifier');
  const proxy = createProxy({
    stateDir, legacyOrigin: env.DDC_HANDOFF_LEGACY_ORIGIN, sharedOrigin: env.DDC_HANDOFF_SHARED_ORIGIN,
    sharedSocket: env.DDC_HANDOFF_SHARED_SOCKET,
    legacyLocalAddress: env.DDC_HANDOFF_LEGACY_LOCAL_ADDRESS,
    trustedProxyIPs: (env.DDC_HANDOFF_TRUSTED_PROXY_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
    forwardTiming: env.DDC_HANDOFF_FORWARD_TIMING === 'true', verifyClosure,
    stopDrainMs: boundedSeconds(env.DDC_HANDOFF_STOP_DRAIN_SECONDS, 120),
  });
  const control = http.createServer((req, res) => {
    const method = req.method;
    const route = req.url;
    req.resume();
    let ok;
    if (method === 'GET' && route === '/status') ok = true;
    else if (method === 'POST' && route === '/invalidate') { proxy.invalidate(); ok = true; }
    else if (method === 'POST' && route === '/prepare-reverse') ok = proxy.prepareReverse();
    else if (method === 'POST' && route.startsWith('/observe/')) ok = proxy.observe(route.slice(9));
    else return res.writeHead(404).end();
    res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok, ...proxy.status() }));
  });
  control.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    proxy.server.listen(port, host);
  });
  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    // A graceful stop does not force-close upgraded or current HTTP flows.
    await new Promise(resolve => control.close(resolve));
    try {
      await proxy.close();
      // A Node Unix-domain server normally unlinks its own socket on close.
      try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } catch {
      console.error('STOP: proxy cannot exit cleanly with open or ambiguous work');
      process.exitCode = 1;
    }
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return proxy;
}
if (require.main === module) start();
module.exports = { createProxy, familyFor };
