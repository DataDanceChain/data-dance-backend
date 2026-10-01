/**
 * src/utils/web3Utils.js — the signing key and the chain settings come from the environment.
 *
 * The key used here is generated fresh for each run; the repository's old keys are never used and
 * no assertion prints a key. No test touches a network: ethers' JsonRpcProvider is replaced by a
 * recorder, so "no RPC call was made" is something the tests can state.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.LOG_LEVEL = 'error';

const realEthers = require('ethers');

const created = [];
class RecordingProvider {
  constructor(url, network, options) {
    this.ctorArgs = [url, network, options];
    this.balanceCalls = [];
    created.push(this);
  }

  async getBalance(address) {
    this.balanceCalls.push(address);
    throw Object.assign(new Error('recording provider: RPC reached'), { code: 'RECORDED_RPC_CALL' });
  }
}
// Same module, one export swapped. Everything else (Wallet, Contract, ...) is the real thing.
const ethersWithRecorder = Object.create(realEthers, {
  JsonRpcProvider: { value: RecordingProvider, enumerable: true },
});
require.cache[require.resolve('ethers')].exports = ethersWithRecorder;

const web3Utils = require('../../src/utils/web3Utils');

const KEY_HEX = crypto.randomBytes(32).toString('hex');
const KEY = `0x${KEY_HEX}`;
const ADDRESS = new realEthers.Wallet(KEY).address;

const ENV_NAMES = ['CHAIN_SIGNER_PRIVATE_KEY', 'CHAIN_RPC_URL', 'CHAIN_ID', 'NODE_ENV'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  mock.method(console, 'log', () => {});
});
afterEach(() => {
  mock.restoreAll();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const rpcCalls = () => created.reduce((sum, provider) => sum + provider.balanceCalls.length, 0);

describe('loading the module', () => {
  it('reads no environment and builds no provider, so the API boots with or without the key', () => {
    // The module was required at the top of this file, with no CHAIN_* variable set.
    assert.equal(created.length, 0, 'a provider was built at require time');
    // The public surface the callers rely on is unchanged.
    for (const name of [
      'createActivityNFTContract',
      'createDataNFTContract',
      'getActivityNFTContract',
      'getBackendWallet',
      'getDataNFTContract',
      'getDdcProvider',
    ]) {
      assert.equal(typeof web3Utils[name], 'function', `${name} is still exported`);
    }
  });
});

describe('the signing key', () => {
  it('getBackendWallet signs with CHAIN_SIGNER_PRIVATE_KEY', () => {
    process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
    const override = { name: 'override-provider' };
    const before = created.length;
    const wallet = web3Utils.getBackendWallet(override);
    assert.equal(wallet.address, ADDRESS);
    assert.ok(wallet.provider === override, 'an override provider is honoured');
    assert.equal(created.length, before, 'no default provider is built when one is passed in');
  });

  it('accepts the key without its 0x prefix', () => {
    process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY_HEX;
    assert.equal(web3Utils.getBackendWallet({}).address, ADDRESS);
  });

  it('without an override the wallet uses the shared provider', () => {
    process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
    const wallet = web3Utils.getBackendWallet();
    assert.ok(wallet.provider === web3Utils.getDdcProvider());
  });

  it('is read at call time: a key set after the module loaded is used', () => {
    const first = thrownBy(() => web3Utils.getBackendWallet({}));
    assert.ok(first && first.code === 'chain_signer_unconfigured');
    process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
    assert.equal(web3Utils.getBackendWallet({}).address, ADDRESS);
  });

  it('createActivityNFTContract builds its signer from the environment key', async () => {
    process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
    const provider = web3Utils.getDdcProvider();
    const calls = provider.balanceCalls.length;
    await assert.rejects(
      web3Utils.createActivityNFTContract('activity-1', ADDRESS),
      (error) => error.code === 'RECORDED_RPC_CALL',
    );
    assert.deepEqual(provider.balanceCalls.slice(calls), [ADDRESS], 'the first RPC call asks for the env key\'s own balance');
  });
});

describe('without a usable key', () => {
  const entryPoints = {
    getBackendWallet: () => web3Utils.getBackendWallet(),
    createActivityNFTContract: () => web3Utils.createActivityNFTContract('activity-1', ADDRESS),
    createDataNFTContract: () => web3Utils.createDataNFTContract('collection-1', ADDRESS),
  };

  for (const [setting, value] of [['unset', undefined], ['blank', '  '], ['malformed', `${KEY_HEX.slice(0, 40)}-SENTINEL`], ['too short', KEY_HEX.slice(2)]]) {
    it(`every signing call fails with an error naming CHAIN_SIGNER_PRIVATE_KEY, before any RPC call (${setting})`, async () => {
      if (value !== undefined) process.env.CHAIN_SIGNER_PRIVATE_KEY = value;
      const providersBefore = created.length;
      const callsBefore = rpcCalls();
      for (const [name, call] of Object.entries(entryPoints)) {
        let error = null;
        try {
          await call();
        } catch (caught) {
          error = caught;
        }
        assert.ok(error, `${name} must fail`);
        assert.ok(error.message.includes('CHAIN_SIGNER_PRIVATE_KEY'), `${name}: the message names the variable`);
        assert.ok(['chain_signer_unconfigured', 'chain_signer_invalid'].includes(error.code), `${name}: code`);
        assert.ok(!error.message.includes('SENTINEL'), `${name}: the message never echoes the value`);
      }
      assert.equal(created.length, providersBefore, 'no provider was built');
      assert.equal(rpcCalls(), callsBefore, 'no RPC call was made');
    });
  }
});

describe('chain settings', () => {
  it('default to the production values whatever NODE_ENV is (behaviour unchanged)', () => {
    for (const NODE_ENV of [undefined, 'production', 'development', 'test']) {
      if (NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = NODE_ENV;
      const provider = web3Utils.getDdcProvider();
      assert.deepEqual(
        provider.ctorArgs,
        ['https://dev-exp-alpha.datadance.ai/eth/rpc', 44508, { batchMaxCount: 1 }],
        `NODE_ENV=${NODE_ENV}`,
      );
    }
  });

  it('CHAIN_RPC_URL and CHAIN_ID replace them', () => {
    process.env.CHAIN_RPC_URL = 'http://localhost:8545';
    process.env.CHAIN_ID = '31337';
    assert.deepEqual(web3Utils.getDdcProvider().ctorArgs, ['http://localhost:8545', 31337, { batchMaxCount: 1 }]);
  });

  it('one provider is shared while the settings stay the same, and replaced when they change', () => {
    const a = web3Utils.getDdcProvider();
    assert.ok(web3Utils.getDdcProvider() === a);
    process.env.CHAIN_ID = '777';
    const b = web3Utils.getDdcProvider();
    assert.ok(b !== a);
    assert.equal(b.ctorArgs[1], 777);
    assert.ok(web3Utils.getDdcProvider() === b);
  });

  it('an invalid value fails the chain call with an error naming the variable, never the value', () => {
    process.env.CHAIN_ID = 'forty-four';
    const badId = thrownBy(() => web3Utils.getDdcProvider());
    assert.ok(badId && badId.message.includes('CHAIN_ID') && badId.code === 'chain_id_invalid');
    delete process.env.CHAIN_ID;

    process.env.CHAIN_RPC_URL = 'ftp://rpc.example.test/SENTINEL';
    const badUrl = thrownBy(() => web3Utils.getDdcProvider());
    assert.ok(badUrl && badUrl.message.includes('CHAIN_RPC_URL') && badUrl.code === 'chain_rpc_url_invalid');
    assert.ok(!badUrl.message.includes('SENTINEL'));
  });
});

describe('no key lives in the source', () => {
  const root = path.join(__dirname, '../..');

  it('web3Utils.js and chainConfig.js contain no 64-hex literal', () => {
    for (const file of ['src/utils/web3Utils.js', 'src/constants/chainConfig.js']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.ok(!/[0-9a-fA-F]{64}/.test(text), `${file} contains a 64-hex run`);
      assert.ok(!/PROD_MAIN_PRIVATE_KEY|DEV_MAIN_PRIVATE_KEY/.test(text), `${file} still names the old key constants`);
    }
  });

  it('no file under src/ or scripts/ assigns a 64-hex literal to a private-key / secret / mnemonic name', () => {
    const pattern = /(private[_-]?key|secret|mnemonic)\w*["'`]?\s*[:=]\s*["'`](?:0x)?[0-9a-fA-F]{64}["'`]/i;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) {
          fs.readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
            if (pattern.test(line)) offenders.push(`${path.relative(root, full)}:${index + 1}`);
          });
        }
      }
    };
    walk(path.join(root, 'src'));
    walk(path.join(root, 'scripts'));
    assert.deepEqual(offenders, [], 'a key literal was committed (file:line, value withheld)');
  });
});

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}
