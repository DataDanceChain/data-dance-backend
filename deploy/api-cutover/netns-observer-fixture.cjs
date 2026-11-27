// Disposable namespace only. Demonstrates the observation barrier, not a release endpoint.
const { readFileSync } = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const express = createRequire('/app/package.json')('express');
const { trackFamily } = require('./first-handoff.js');

const PORT = 3000;
const terminalStates = new Set(['06', '07', '0A']); // TIME_WAIT, CLOSE, LISTEN
const loopback1 = new Set(['0100007F', '0000000000000000FFFF00000100007F']);
const loopback2 = new Set(['0200007F', '0000000000000000FFFF00000200007F']);
const agent = new http.Agent({ keepAlive: true, maxSockets: 4, timeout: 30000 });
const pipeline = () => trackFamily({
  lifetimeMs: 60 * 60 * 1000,
  initialOwner: 'legacy',
  // This fixture must never transfer the application owner.
  commitOwner: () => { throw new Error('Fixture does not permit a change of application owner'); },
});
let family = pipeline();
let observationStarted = false;
let transportChecked = false;
let routed = 0;

function oldSockets() {
  const result = { listener: false, direct: 0, observed: 0 };
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const rows = readFileSync(path, 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      const [_, local, remote, state] = row.trim().split(/\s+/);
      const [localIP, localPort] = local.split(':');
      if (Number.parseInt(localPort, 16) !== PORT) continue;
      if (state === '0A') result.listener = true;
      if (terminalStates.has(state)) continue;
      const [remoteIP] = remote.split(':');
      if (loopback1.has(localIP) && loopback2.has(remoteIP)) result.observed++;
      else result.direct++;
    }
  }
  return result;
}

const observer = express();
observer.set('trust proxy', 1);
observer.use((req, res) => {
  if (!['/who', '/issue', '/hold'].includes(req.path)) return res.sendStatus(404);
  const admission = family.admit();
  if (admission.owner !== 'legacy') return res.sendStatus(503);
  const upstream = http.request({
    hostname: '127.0.0.1', port: PORT, localAddress: '127.0.0.2',
    method: req.method, path: req.url, agent,
    headers: { 'X-Forwarded-For': req.ip },
  }, (incoming) => {
    routed++;
    res.status(incoming.statusCode).set('X-Fixture-Observer', '1');
    if (incoming.headers['content-type']) res.set('Content-Type', incoming.headers['content-type']);
    incoming.on('end', () => admission.finish(incoming.complete));
    incoming.on('aborted', () => admission.finish(false));
    incoming.pipe(res);
  });
  upstream.on('error', () => {
    admission.finish(false);
    if (!res.headersSent) res.sendStatus(502);
    else res.destroy();
  });
  res.on('close', () => {
    if (!res.writableFinished) {
      admission.finish(false);
      upstream.destroy();
    }
  });
  req.pipe(upstream);
});
observer.listen(3001, '0.0.0.0');

// Separate loopback control, never exposed by the ingress rule. The test calls
// transport-checked only after healthy observed replies via both real paths.
http.createServer((req, res) => {
  try {
    if (req.url === '/transport-checked' && routed >= 2) transportChecked = true;
    if (req.url === '/invalidate') {
      observationStarted = false;
      transportChecked = false;
      family = pipeline();
    }
    const sockets = oldSockets();
    if (req.url === '/start-observation' && !observationStarted &&
        transportChecked && sockets.listener && sockets.direct === 0 && sockets.observed > 0) {
      family.startObservation();
      observationStarted = true;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      observationStarted,
      originalDirectStillAlive: sockets.direct > 0,
      dedicatedLegacyPathAlive: sockets.observed > 0,
      transportChecked,
    }));
  } catch {
    res.writeHead(503).end();
  }
}).listen(3999, '127.0.0.1');
