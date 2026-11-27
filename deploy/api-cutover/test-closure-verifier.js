'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createVerifier, readSockets, readProtected } = require('./closure-verifier');

const head = '  sl  local_address rem_address   st other';
const line = (local, port, remote, peerPort, status) =>
  `  0: ${local}:${port} ${remote}:${peerPort} ${status} 00000000`;
const mapped = hex => '0000000000000000FFFF0000' + hex;
const empty = [head, line('00000000', '0BB8', '00000000', '0000', '0A')].join('\n');
const proof = { ingressVerified: true, directConnections: 0, unresolvedLegacyWrites: 0 };
const closed = { ingressVerified: false, directConnections: null, unresolvedLegacyWrites: null };
const policy = {
  generation: 'fixture-20261127',
  legacyImage: 'sha256:' + 'e'.repeat(64), legacyStartBootMs: 400,
  bootId: 'fixture-boot', netns: 'net:[42]',
  legacyAddress: '127.0.0.1', legacyPort: 3000, gatewayAddress: '127.0.0.2',
  routes: ['host-loopback-v4', 'docker-bridge-v4', 'nginx-api-main', 'nginx-api-alias'],
};
const common = () => ({
  version: 1, generation: policy.generation, legacyImage: policy.legacyImage,
  bootId: policy.bootId, netns: policy.netns, issuedBootMs: 1200, expiresBootMs: 1700, cutBootMs: 900,
});
const makeTopology = () => ({ ...common(), kind: 'topology',
  legacyAddress: policy.legacyAddress, legacyPort: policy.legacyPort,
  gatewayAddress: policy.gatewayAddress, routes: [...policy.routes] });
const makeCompletion = () => ({ ...common(), kind: 'completion', coveredSinceBootMs: 400,
  coveredThroughBootMs: 1000, families: { oauth: { admitted: 7, terminal: 7, unresolved: 0 } } });

test('exact IPv4 and mapped gateway sockets are separated from direct and lingering old sockets', () => {
  const v4 = empty + '\n' + [
    line('0100007F', '0BB8', '0200007F', '9999', '01'),
    line('0B00000A', '0BB8', '0C00000A', '9999', '08'),
    line('0B00000A', '0BB8', '0C00000A', '9998', '06'),
    line('0B00000A', '0BB8', '0200007F', '9999', '01'),
  ].join('\n');
  assert.deepEqual(readSockets(v4, 3000, '127.0.0.1', '127.0.0.2'),
    { listener: true, directConnections: 2, dedicatedConnections: 1 });
  const ipv6 = [head, line(mapped('0100007F'), '0BB8', mapped('0200007F'), '8888', '01')].join('\n');
  assert.deepEqual(readSockets(ipv6, 3000, '127.0.0.1', '127.0.0.2'),
    { listener: false, directConnections: 0, dedicatedConnections: 1 });
  assert.throws(() => readSockets(head + '\nmissing row', 3000, '127.0.0.1', '127.0.0.2'));
});

test('two same-generation live sources plus live sockets are required, independently per family', () => {
  const topology = makeTopology(), completion = makeCompletion();
  let time = 1300, namespace = policy.netns, socketReport = [empty, head];
  const evaluate = createVerifier(policy, {
    uptimeMs: () => time, bootId: () => policy.bootId, netns: () => namespace,
    topology: () => topology, completion: () => completion, tables: () => socketReport,
  });
  assert.deepEqual(evaluate('oauth'), proof);
  assert.deepEqual(evaluate('email-code'), closed);
  completion.families.oauth.unresolved = 1;
  completion.families.oauth.terminal--;
  assert.deepEqual(evaluate('oauth'), { ...proof, unresolvedLegacyWrites: 1 });
  completion.families.oauth.unresolved = 0;
  assert.deepEqual(evaluate('oauth'), closed, 'a zero does not make an unaccounted write terminal');
  completion.families.oauth.terminal++;
  socketReport = [empty + '\n' + line('0100007F', '0BB8', '0300007F', '9999', '02'), head];
  assert.equal(evaluate('oauth').directConnections, 1);
  socketReport = [empty, head];
  completion.coveredSinceBootMs++;
  assert.deepEqual(evaluate('oauth'), closed);
  completion.coveredSinceBootMs--;
  topology.routes.pop();
  assert.deepEqual(evaluate('oauth'), closed);
  topology.routes = [...policy.routes];
  namespace = 'net:[43]';
  assert.deepEqual(evaluate('oauth'), closed);
  namespace = policy.netns;
  time = 1700;
  assert.deepEqual(evaluate('oauth'), closed);
  time = 1300;
  assert.deepEqual(evaluate('oauth'), proof);
  completion.expiresBootMs += 10000;
  assert.deepEqual(evaluate('oauth'), closed, 'permit cannot extend indefinitely');
});

test('closure files cannot be supplied by an application-writable directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddc-evidence-unit-'));
  try {
    const file = path.join(dir, 'evidence.json');
    fs.chmodSync(dir, 0o777);
    fs.writeFileSync(file, JSON.stringify(makeTopology()), { mode: 0o600 });
    assert.throws(() => readProtected(file), /Untrusted closure directory/);
    assert.throws(() => readProtected('relative.json'), /Invalid closure path/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
