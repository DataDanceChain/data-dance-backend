// Local, private Docker fixture. The edge derives the forwarded identity from its
// accepted socket. Neither requests supplied by the test caller nor stdout carry an IP.
const http = require('node:http');
const dns = require('node:dns/promises');
const crypto = require('node:crypto');
const fs = require('node:fs');
const normalize = (ip) => ip?.replace(/^::ffff:/, '');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

const role = process.argv[2];
if (role === 'edge') {
  const hosts = {
    '/production': 'api.example.test',
    '/rehearsal': 'api-rehearsal.example.test',
  };
  http.createServer((req, res) => {
    const host = hosts[req.url];
    if (!host || req.method !== 'GET') return res.writeHead(404).end();
    const peer = normalize(req.socket.remoteAddress);
    const proxied = http.get({
      hostname: 'identity-gateway', port: 8080, path: '/key',
      headers: { Host: host, 'X-Forwarded-For': peer },
    }, (upstream) => {
      let body = '';
      upstream.setEncoding('utf8');
      upstream.on('data', (chunk) => { body += chunk; });
      upstream.on('end', () => {
        if (upstream.statusCode !== 200) return res.writeHead(502).end();
        const parsed = JSON.parse(body);
        parsed.matchesObservedClient = parsed.key === digest(peer);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(parsed));
      });
    });
    proxied.setTimeout(1500, () => proxied.destroy());
    proxied.on('error', () => res.writeHead(502).end());
  }).listen(4000, '0.0.0.0');
} else if (role === 'origin') {
  const express = require('express');
  const app = express();
  app.set('trust proxy', 1);
  app.get('/key', async (req, res) => {
    // The protected phase tests a separate transport-peer policy, not trust in a header.
    if (fs.existsSync('/lab/origin-guard-on')) {
      try {
        const expectedProxy = await dns.lookup('identity-gateway', { family: 4 });
        if (normalize(req.socket.remoteAddress) !== expectedProxy.address) {
          return res.sendStatus(403);
        }
      } catch {
        return res.sendStatus(503);
      }
    }
    // Same anonymous key expression as rateLimitMiddleware.js, using Express's actual req.ip.
    res.json({
      target: process.argv[3],
      key: digest(req.ip || 'anonymous'),
      forwarded: req.headers['x-forwarded-for'] !== undefined,
    });
  });
  app.listen(3000, '0.0.0.0');
} else if (role === 'request') {
  // Called locally from an owned fixture container, never from a user or production host.
  const req = http.get(process.argv[3], (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (value) => { body += value; });
    res.on('end', () => {
      process.stdout.write(JSON.stringify({
        status: res.statusCode,
        payload: res.statusCode === 200 ? JSON.parse(body) : undefined,
      }));
    });
  });
  req.setTimeout(2000, () => req.destroy());
  req.on('error', () => process.stdout.write('{"status":0}'));
} else {
  process.exitCode = 2;
}
