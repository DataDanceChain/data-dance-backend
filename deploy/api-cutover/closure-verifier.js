'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const FAMILIES = new Set(['email-code', 'email-bind', 'oauth']);
const DONE = new Set(['06', '07', '0A']); // TIME_WAIT, CLOSE, LISTEN
const MAX_LEASE_MS = 5000;
const harmless = label => typeof label === 'string' && /^[A-Za-z0-9_:.\[\]-]{1,160}$/.test(label);
const safeInteger = n => Number.isSafeInteger(n) && n >= 0;
const stayClosed = () => ({ ingressVerified: false, directConnections: null, unresolvedLegacyWrites: null });

function addressKey(address) {
  if (!net.isIPv4(address)) throw new Error('Dedicated observer tuple must be IPv4 loopback');
  const reversed = Buffer.from(address.split('.').map(Number)).reverse().toString('hex').toUpperCase();
  return new Set([reversed, '0000000000000000FFFF0000' + reversed]);
}
const loopback = address => net.isIPv4(address) && address.startsWith('127.');

function readSockets(text, legacyPort, localIP, gatewayIP) {
  const addresses = { local: addressKey(localIP), gateway: addressKey(gatewayIP) };
  const lines = text.trim().split('\n');
  if (!/^\s*sl\s+local_address\s+rem(?:ote)?_address\s+st\b/.test(lines.shift() || '')) {
    throw new Error('Unexpected kernel TCP table');
  }
  let directConnections = 0;
  let dedicatedConnections = 0;
  let listener = false;
  for (const line of lines) {
    const m = /^\s*\d+:\s+([A-F0-9]{8}|[A-F0-9]{32}):([A-F0-9]{4})\s+([A-F0-9]{8}|[A-F0-9]{32}):([A-F0-9]{4})\s+([A-F0-9]{2})\b/i.exec(line);
    if (!m) throw new Error('Malformed socket row');
    if (parseInt(m[2], 16) !== legacyPort) continue;
    const [local, peer, state] = [m[1], m[3], m[5]].map(v => v.toUpperCase());
    if (state === '0A' && (addresses.local.has(local) || /^0+$/.test(local))) listener = true;
    if (DONE.has(state)) continue;
    if (addresses.local.has(local) && addresses.gateway.has(peer)) dedicatedConnections++;
    else directConnections++;
  }
  return { listener, directConnections, dedicatedConnections };
}

function readPrivateFile(filename, owner = 0) {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) throw new Error('Invalid closure path');
  for (let dir = path.dirname(filename); ; dir = path.dirname(dir)) {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== owner || (st.mode & 0o022)) {
      throw new Error('Untrusted closure directory');
    }
    if (dir === '/') break;
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== owner || (st.mode & 0o022) || st.size < 1 || st.size > 65536) {
      throw new Error('Unsafe closure artifact');
    }
    const data = Buffer.alloc(st.size + 1);
    let offset = 0, n;
    while (offset < data.length && (n = fs.readSync(fd, data, offset, data.length - offset, null)) > 0) offset += n;
    if (offset !== st.size) throw new Error('Closure artifact changed during read');
    return data.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}
const readProtected = filename => JSON.parse(readPrivateFile(filename));

function createVerifier(policy, io) {
  const { generation, legacyImage, legacyStartBootMs, bootId, netns, legacyAddress,
    legacyPort, gatewayAddress, routes } = policy;
  if (![generation, legacyImage, bootId, netns].every(harmless) ||
      !/^sha256:[a-f0-9]{64}$/.test(legacyImage) || !/^net:\[\d+\]$/.test(netns) ||
      !safeInteger(legacyStartBootMs) ||
      !loopback(legacyAddress) || !loopback(gatewayAddress) || gatewayAddress === legacyAddress ||
      !Number.isInteger(legacyPort) || legacyPort < 1 || legacyPort > 65535 ||
      !Array.isArray(routes) || routes.length < 1 || routes.length !== new Set(routes).size ||
      !routes.every(harmless)) throw new Error('Invalid closure policy');
  const expectedRoutes = [...routes].sort().join(',');
  function common(receipt, expectedKind, now) {
    return receipt?.version === 1 && receipt.kind === expectedKind &&
      receipt.generation === generation && receipt.legacyImage === legacyImage &&
      receipt.bootId === bootId && receipt.netns === netns &&
      [receipt.issuedBootMs, receipt.expiresBootMs, receipt.cutBootMs].every(safeInteger) &&
      receipt.cutBootMs >= legacyStartBootMs && receipt.cutBootMs <= receipt.issuedBootMs &&
      receipt.issuedBootMs <= now && now < receipt.expiresBootMs &&
      receipt.expiresBootMs - receipt.issuedBootMs <= MAX_LEASE_MS;
  }
  return function verifyClosure(family) {
    if (!FAMILIES.has(family)) return stayClosed();
    try {
      const now = io.uptimeMs();
      if (io.bootId() !== bootId || io.netns() !== netns || !safeInteger(now)) return stayClosed();
      const topology = io.topology(), completion = io.completion();
      if (!common(topology, 'topology', now) || !common(completion, 'completion', now) ||
          topology.cutBootMs !== completion.cutBootMs ||
          topology.legacyAddress !== legacyAddress || topology.legacyPort !== legacyPort ||
          topology.gatewayAddress !== gatewayAddress ||
          !Array.isArray(topology.routes) || !topology.routes.every(harmless) ||
          [...topology.routes].sort().join(',') !== expectedRoutes ||
          !safeInteger(completion.coveredSinceBootMs) || completion.coveredSinceBootMs > legacyStartBootMs ||
          !safeInteger(completion.coveredThroughBootMs) ||
          completion.coveredThroughBootMs < topology.cutBootMs ||
          completion.coveredThroughBootMs > completion.issuedBootMs) return stayClosed();
      const work = completion.families?.[family];
      if (!work || ![work.admitted, work.terminal, work.unresolved].every(safeInteger) ||
          work.terminal + work.unresolved !== work.admitted) return stayClosed();
      const sockets = io.tables().map(s => readSockets(s, legacyPort, legacyAddress, gatewayAddress));
      if (sockets.length !== 2 || !sockets.some(x => x.listener)) return stayClosed();
      return {
        ingressVerified: true,
        directConnections: sockets.reduce((sum, x) => sum + x.directConnections, 0),
        unresolvedLegacyWrites: work.unresolved,
      };
    } catch {
      return stayClosed();
    }
  };
}

function fromEnvironment(env = process.env) {
  if (!env.DDC_HANDOFF_CLOSURE_POLICY) throw new Error('Missing closure policy');
  const policy = readProtected(env.DDC_HANDOFF_CLOSURE_POLICY);
  if (policy.topologyReceipt === policy.completionReceipt) throw new Error('Closure evidence must describe both facts separately');
  return createVerifier(policy, {
    uptimeMs: () => Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ', 1)[0]) * 1000),
    bootId: () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    netns: () => fs.readlinkSync('/proc/self/ns/net'),
    topology: () => readProtected(policy.topologyReceipt),
    completion: () => readProtected(policy.completionReceipt),
    tables: () => ['/proc/net/tcp', '/proc/net/tcp6'].map(file => fs.readFileSync(file, 'utf8')),
  });
}

let active;
function verifyClosure(family) {
  try {
    active ??= fromEnvironment();
    return active(family);
  } catch {
    return stayClosed();
  }
}
module.exports = { verifyClosure, createVerifier, readSockets, readProtected };
