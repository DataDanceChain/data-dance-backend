/**
 * The server-side wallet lookup (design §3.7 step 3, I5, F21): node details and Torus are built
 * the way SFA 9.5.0 builds them, every failure fails closed with W3A_LOOKUP_UNAVAILABLE, and the
 * subject never reaches a log. Unit tests inject a fake torus; no test here reaches a node, except
 * the opt-in live test at the end.
 *
 * Live test (skipped unless configured; devnet only, and only for the throwaway subject):
 *   NATIVE_AUTH_LIVE_W3A_CLIENT_ID=<O1 client id> \
 *   NATIVE_AUTH_LIVE_W3A_CONNECTION=ddc-jwt-devnet \
 *   node --test test/unit/nativeAuthW3aLookup.test.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const winston = require('winston');
const { Wallet } = require('ethers');

process.env.LOG_LEVEL = 'info';

const config = require('../../src/services/nativeAuth/config');
const w3aLookup = require('../../src/services/nativeAuth/w3aLookup');

const SUBJECT = 'c0ffee00-1111-4222-8333-444455556666';
const THROWAWAY_SUBJECT = '00000000-0000-4000-8000-000000000000';
const ARGS = { connection: 'ddc-jwt-devnet', subject: SUBJECT, network: 'sapphire_devnet', clientId: 'BClient', loginRef: 'ref0123456789abc' };

function captureLogs() {
  const lines = [];
  const transport = new winston.transports.Stream({ stream: new (require('stream').Writable)({ write(chunk, enc, cb) { lines.push(String(chunk)); cb(); } }) });
  config.logger.add(transport);
  return { lines, stop: () => config.logger.remove(transport) };
}

/** A fake of { Torus, fetchLocalConfig, keyType } recording how it is called. */
function fakeDeps({ answer, fail, hang, nodeDetails } = {}) {
  const calls = { constructed: [], lookups: [], fetch: [] };
  class Torus {
    constructor(opts) {
      calls.constructed.push(opts);
    }

    async getPublicAddress(endpoints, pubs, params) {
      calls.lookups.push({ endpoints, pubs, params });
      if (hang) return new Promise(() => {});
      if (fail) throw new Error(`node results do not match ${params.verifierId}`);
      return answer;
    }
  }
  return {
    calls,
    deps: {
      Torus,
      keyType: 'secp256k1',
      fetchLocalConfig: (network, keyType) => {
        calls.fetch.push({ network, keyType });
        return nodeDetails === undefined ? { torusNodeEndpoints: ['https://node-1/sss/jrpc', 'https://node-2/sss/jrpc'], torusNodePub: [{ X: '1', Y: '2' }] } : nodeDetails;
      },
    },
  };
}

async function unavailable(promise) {
  await assert.rejects(promise, (err) => err.code === 'W3A_LOOKUP_UNAVAILABLE' && err.status === 503);
}

afterEach(() => w3aLookup.setLookupDepsForTests(null));

describe('w3aLookup.lookupWalletAddress', () => {
  it('asks the nodes for (connection, subject) like SFA 9.5.0 and returns the checksummed address', async () => {
    const wallet = Wallet.createRandom();
    const { deps, calls } = fakeDeps({ answer: { finalKeyData: { walletAddress: wallet.address.toLowerCase() } } });
    w3aLookup.setLookupDepsForTests(deps);
    const address = await w3aLookup.lookupWalletAddress(ARGS);
    assert.equal(address, wallet.address);
    assert.deepEqual(calls.fetch, [{ network: 'sapphire_devnet', keyType: 'secp256k1' }]);
    assert.deepEqual(calls.constructed, [{ clientId: 'BClient', network: 'sapphire_devnet', enableOneKey: true }]);
    assert.deepEqual(calls.lookups[0].params, { verifier: 'ddc-jwt-devnet', verifierId: SUBJECT });
    assert.deepEqual(calls.lookups[0].endpoints, ['https://node-1/sss/jrpc', 'https://node-2/sss/jrpc']);
  });

  it('reuses one Torus client per (clientId, network)', async () => {
    const { deps, calls } = fakeDeps({ answer: { finalKeyData: { walletAddress: Wallet.createRandom().address } } });
    w3aLookup.setLookupDepsForTests(deps);
    await w3aLookup.lookupWalletAddress(ARGS);
    await w3aLookup.lookupWalletAddress(ARGS);
    assert.equal(calls.constructed.length, 1);
    assert.equal(calls.lookups.length, 2);
  });

  it('fails closed on a node error, a malformed answer, missing node details and missing config', async () => {
    w3aLookup.setLookupDepsForTests(fakeDeps({ fail: true }).deps);
    await unavailable(w3aLookup.lookupWalletAddress(ARGS));
    w3aLookup.setLookupDepsForTests(fakeDeps({ answer: { finalKeyData: { walletAddress: 'not-an-address' } } }).deps);
    await unavailable(w3aLookup.lookupWalletAddress(ARGS));
    w3aLookup.setLookupDepsForTests(fakeDeps({ answer: {} }).deps);
    await unavailable(w3aLookup.lookupWalletAddress(ARGS));
    w3aLookup.setLookupDepsForTests(fakeDeps({ nodeDetails: { torusNodeEndpoints: [] } }).deps);
    await unavailable(w3aLookup.lookupWalletAddress(ARGS));
    const { deps, calls } = fakeDeps({ answer: { finalKeyData: { walletAddress: Wallet.createRandom().address } } });
    w3aLookup.setLookupDepsForTests(deps);
    await unavailable(w3aLookup.lookupWalletAddress({ ...ARGS, clientId: '' }));
    await unavailable(w3aLookup.lookupWalletAddress({ ...ARGS, subject: '' }));
    assert.equal(calls.lookups.length, 0, 'no node is asked without a complete configuration');
  });

  it('times out (fail closed) instead of hanging', async () => {
    w3aLookup.setLookupDepsForTests(fakeDeps({ hang: true }).deps);
    const started = Date.now();
    await unavailable(w3aLookup.lookupWalletAddress({ ...ARGS, timeoutMs: 50 }));
    assert.ok(Date.now() - started < 2000);
    assert.equal(w3aLookup.LOOKUP_TIMEOUT_MS, 8000, 'the production timeout is 8 s');
  });

  it('logs loginRef, duration and an outcome enum — never the subject or the library message', async () => {
    const logs = captureLogs();
    try {
      w3aLookup.setLookupDepsForTests(fakeDeps({ fail: true }).deps);
      await unavailable(w3aLookup.lookupWalletAddress(ARGS));
      w3aLookup.setLookupDepsForTests(fakeDeps({ answer: { finalKeyData: { walletAddress: Wallet.createRandom().address } } }).deps);
      await w3aLookup.lookupWalletAddress(ARGS);
    } finally {
      logs.stop();
    }
    const text = logs.lines.join('\n');
    assert.match(text, /native_auth\.wallet_lookup_unavailable/);
    assert.match(text, /"outcome":"node_error"/);
    assert.match(text, /native_auth\.wallet_lookup"/);
    assert.match(text, /"outcome":"ok"/);
    assert.match(text, /ref0123456789abc/);
    assert.ok(!text.includes(SUBJECT), 'the w3aSubject must never be logged');
    assert.ok(!text.includes('node results do not match'), 'library messages are not logged');
  });

  it('loads the pinned torus packages lazily (the real fnd-base table has sapphire_devnet nodes)', () => {
    const fnd = require('@toruslabs/fnd-base');
    const constants = require('@toruslabs/constants');
    const torus = require('@toruslabs/torus.js');
    assert.equal(typeof (torus.Torus || torus.default), 'function');
    const details = fnd.fetchLocalConfig('sapphire_devnet', constants.KEY_TYPE.SECP256K1);
    assert.ok(details.torusNodeEndpoints.length >= 3);
    assert.equal(details.torusNodeEndpoints.length, details.torusNodePub.length);
    assert.equal(require('@toruslabs/torus.js/package.json').version, '15.1.1');
  });
});

const LIVE_CLIENT_ID = process.env.NATIVE_AUTH_LIVE_W3A_CLIENT_ID;
const LIVE_CONNECTION = process.env.NATIVE_AUTH_LIVE_W3A_CONNECTION || 'ddc-jwt-devnet';

describe('live Web3Auth sapphire_devnet lookup (opt-in)', () => {
  it(
    'the throwaway subject resolves to one stable address',
    { skip: LIVE_CLIENT_ID ? false : 'set NATIVE_AUTH_LIVE_W3A_CLIENT_ID (and NATIVE_AUTH_LIVE_W3A_CONNECTION) to run against devnet', timeout: 60000 },
    async () => {
      w3aLookup.setLookupDepsForTests(null);
      const args = { connection: LIVE_CONNECTION, subject: THROWAWAY_SUBJECT, network: 'sapphire_devnet', clientId: LIVE_CLIENT_ID, loginRef: 'live-test', timeoutMs: 20000 };
      const first = await w3aLookup.lookupWalletAddress(args);
      const second = await w3aLookup.lookupWalletAddress(args);
      assert.match(first, /^0x[0-9a-fA-F]{40}$/);
      assert.equal(second, first);
    },
  );
});
