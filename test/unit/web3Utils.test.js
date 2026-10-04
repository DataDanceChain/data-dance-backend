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
    this.subscriptions = [];
    created.push(this);
  }

  async getBalance(address) {
    this.balanceCalls.push(address);
    throw Object.assign(new Error('recording provider: RPC reached'), { code: 'RECORDED_RPC_CALL' });
  }

  // An event subscription (contract.on() ends here) is recorded, never started.
  async on(event) {
    this.subscriptions.push(event);
    return this;
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

const ENV_NAMES = ['CHAIN_SIGNER_PRIVATE_KEY', 'CHAIN_RPC_URL', 'CHAIN_ID', 'DDC_RPC_URL', 'DDC_CHAIN_ID', 'NODE_ENV'];
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
      'activityNftUnavailableReason',
      'createActivityNFTContract',
      'getActivityNFTContract',
      'getBackendWallet',
      'getDataNFTContract',
      'getDdcProvider',
    ]) {
      assert.equal(typeof web3Utils[name], 'function', `${name} is still exported`);
    }
    // Dead code with no caller, aimed at a factory address that was never deployed on the chain.
    assert.equal(web3Utils.createDataNFTContract, undefined, 'createDataNFTContract is gone');
  });
});

describe('activity NFT creation', () => {
  const contractListenerMethods = ['on', 'once', 'addListener'];

  for (const [setting, key] of [['no key', undefined], ['a valid key', KEY]]) {
    it(`createActivityNFTContract refuses before any wallet, provider, listener or RPC call (${setting})`, async () => {
      if (key !== undefined) process.env.CHAIN_SIGNER_PRIVATE_KEY = key;
      const listenerCalls = contractListenerMethods.map((name) =>
        mock.method(realEthers.BaseContract.prototype, name, async function recorded() { return this; }));
      const providersBefore = created.length;
      const callsBefore = rpcCalls();
      const subscriptionsBefore = created.reduce((sum, provider) => sum + provider.subscriptions.length, 0);

      let error = null;
      try {
        await web3Utils.createActivityNFTContract('3f2b8c1e-0000-4000-8000-000000000001', ADDRESS);
      } catch (caught) {
        error = caught;
      }

      assert.ok(error, 'it must refuse');
      assert.equal(error.code, 'ACTIVITY_NFT_UNAVAILABLE');
      assert.ok(error.message.includes(web3Utils.activityNftUnavailableReason()), 'the message carries the reason');
      assert.ok(!error.message.includes(KEY_HEX), 'the message never carries the key');
      for (const spy of listenerCalls) assert.equal(spy.mock.callCount(), 0, 'no contract event listener');
      assert.equal(created.length, providersBefore, 'no provider was built');
      assert.equal(rpcCalls(), callsBefore, 'no RPC call was made');
      assert.equal(
        created.reduce((sum, provider) => sum + provider.subscriptions.length, 0),
        subscriptionsBefore,
        'no provider subscription was created',
      );
    });
  }

  it('activityNftUnavailableReason explains the refusal for the server log', () => {
    const reason = web3Utils.activityNftUnavailableReason();
    assert.equal(typeof reason, 'string');
    assert.match(reason, /verified interface/);
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
});

describe('without a usable key', () => {
  // createActivityNFTContract no longer signs anything (see 'activity NFT creation' above).
  const entryPoints = {
    getBackendWallet: () => web3Utils.getBackendWallet(),
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

  it('follow DDC_RPC_URL / DDC_CHAIN_ID, the pair the other chain readers use, when CHAIN_* are not set', () => {
    process.env.DDC_RPC_URL = 'https://rpc.example.test/eth';
    process.env.DDC_CHAIN_ID = '777';
    assert.deepEqual(web3Utils.getDdcProvider().ctorArgs, ['https://rpc.example.test/eth', 777, { batchMaxCount: 1 }]);
  });

  it('CHAIN_RPC_URL / CHAIN_ID win over DDC_RPC_URL / DDC_CHAIN_ID', () => {
    process.env.DDC_RPC_URL = 'https://rpc.example.test/eth';
    process.env.DDC_CHAIN_ID = '777';
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
    delete process.env.CHAIN_RPC_URL;

    process.env.DDC_RPC_URL = 'ftp://rpc.example.test/SENTINEL';
    const badFallback = thrownBy(() => web3Utils.getDdcProvider());
    assert.ok(badFallback && badFallback.message.includes('DDC_RPC_URL') && !badFallback.message.includes('CHAIN_RPC_URL'));
    assert.ok(!badFallback.message.includes('SENTINEL'));
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

  it('web3Utils.js holds no contract address and registers no event listener', () => {
    const text = fs.readFileSync(path.join(root, 'src/utils/web3Utils.js'), 'utf8');
    // The retired activity/data NFT factory addresses lived here; none may come back.
    assert.ok(!/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.test(text), 'web3Utils.js contains a contract address literal');
    // Comments may describe .on(); code may not call it.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\.(on|once|addListener)\s*\(/.test(code), 'web3Utils.js calls .on()/.once()/.addListener()');
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
