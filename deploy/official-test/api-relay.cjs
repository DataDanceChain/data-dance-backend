'use strict';

const { lookup, Resolver } = require('node:dns').promises;
const { chmodSync, lstatSync, unlinkSync } = require('node:fs');
const net = require('node:net');
const { networkInterfaces } = require('node:os');

const [purpose, target] = process.argv.slice(2);
const vendorHosts = new Set(['api-auth.web3auth.io', 'authjs.web3auth.io']);
const apiContainer = /^ddc-official-test-api-[a-z0-9-]+$/;
const ingressOk = purpose === 'ingress' && apiContainer.test(target);
const jwksOk = purpose === 'jwks' && vendorHosts.has(target);
if ((!ingressOk && !jwksOk) || process.argv.length !== 4) {
  throw Error('Unknown TEST API relay');
}

function publicAddress(address) {
  // Reject local, reserved and non-unicast IPv4 addresses from DNS results.
  const [a, b, c] = address.split('.').map(Number);
  return net.isIPv4(address) && a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113);
}

const resolver = new Resolver({ timeout: 1500, tries: 2 });
// Resolve publicly. Docker DNS aliases the vendor inside TEST.
resolver.setServers(['1.1.1.1', '8.8.8.8']);
function connect(client, options) {
  if (client.destroyed) return;
  const upstream = net.createConnection(options);
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  if (jwksOk) upstream.setTimeout(15000, () => upstream.destroy());
  upstream.on('connect', () => {
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

const server = net.createServer({ pauseOnConnect: true }, async client => {
  client.on('error', () => {});
  if (ingressOk) {
    connect(client, { host: target, port: 3000 });
    return;
  }

  try {
    const addresses = await resolver.resolve4(target);
    if (addresses.length === 0 || !addresses.every(publicAddress)) {
      client.destroy();
      return;
    }
    // A blind TCP relay preserves the caller's hostname, TLS and JWK pin checks.
    connect(client, { host: addresses[0], port: 443 });
  } catch {
    client.destroy();
  }
});

server.maxConnections = 128;
if (ingressOk) {
  const socket = '/run/ddc-test-api/api.sock';
  try {
    if (!lstatSync(socket).isSocket()) throw Error('Unsafe TEST socket path');
    unlinkSync(socket);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  server.listen(socket, () => chmodSync(socket, 0o660));
} else {
  lookup(target, { family: 4 }).then(({ address }) => {
    const interfaces = Object.values(networkInterfaces()).flat();
    if (publicAddress(address) || !interfaces.some(record => record.address === address && !record.internal)) {
      throw Error('Vendor alias is not bound to this TEST relay');
    }
    server.listen(443, address);
  }).catch(error => { throw error; });
}
