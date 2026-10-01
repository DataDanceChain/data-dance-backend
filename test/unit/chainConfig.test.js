/**
 * src/constants/chainConfig.js — the chain signer key and chain settings come from the
 * environment, never from source.
 *
 * Every key in this file is generated fresh for the run. The repository's old keys are never used,
 * and no assertion prints a key: failures are boolean checks with fixed messages.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ethers } = require('ethers');

process.env.LOG_LEVEL = 'error';

const {
  DEFAULT_CHAIN_RPC_URL,
  DEFAULT_CHAIN_ID,
  SIGNER_KEY_ENV,
  chainRpcUrl,
  chainId,
  chainSignerKey,
  createSignerWallet,
  inspectChainConfig,
  warnIfChainSignerUnavailable,
} = require('../../src/constants/chainConfig');

const KEY_HEX = crypto.randomBytes(32).toString('hex');
const KEY = `0x${KEY_HEX}`;
const ADDRESS = new ethers.Wallet(KEY).address;

/** Collects what boot would log, so a test can read it back. */
function captureLog() {
  const calls = [];
  return {
    calls,
    warn: (event, meta) => calls.push({ level: 'warn', event, meta }),
    info: (event, meta) => calls.push({ level: 'info', event, meta }),
    ofLevel: (level) => calls.filter((call) => call.level === level),
    text: () => JSON.stringify(calls),
  };
}

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe('defaults are the production values, whatever NODE_ENV says', () => {
  it('RPC URL and chain id', () => {
    assert.equal(DEFAULT_CHAIN_RPC_URL, 'https://dev-exp-alpha.datadance.ai/eth/rpc');
    assert.equal(DEFAULT_CHAIN_ID, 44508);
    for (const NODE_ENV of [undefined, '', 'production', 'development', 'test']) {
      assert.equal(chainRpcUrl({ NODE_ENV }), DEFAULT_CHAIN_RPC_URL, `NODE_ENV=${NODE_ENV}`);
      assert.equal(chainId({ NODE_ENV }), DEFAULT_CHAIN_ID, `NODE_ENV=${NODE_ENV}`);
    }
  });

  it('blank values count as unset', () => {
    assert.equal(chainRpcUrl({ CHAIN_RPC_URL: '   ' }), DEFAULT_CHAIN_RPC_URL);
    assert.equal(chainId({ CHAIN_ID: '' }), DEFAULT_CHAIN_ID);
  });
});

describe('CHAIN_RPC_URL and CHAIN_ID', () => {
  it('override the defaults (trimmed)', () => {
    assert.equal(chainRpcUrl({ CHAIN_RPC_URL: ' http://localhost:8545 ' }), 'http://localhost:8545');
    assert.equal(chainRpcUrl({ CHAIN_RPC_URL: 'https://rpc.example.test/eth' }), 'https://rpc.example.test/eth');
    assert.equal(chainId({ CHAIN_ID: ' 31337 ' }), 31337);
  });

  it('an unusable RPC URL throws chain_rpc_url_invalid, names the variable and never echoes the value', () => {
    for (const bad of ['not a url', 'localhost:8545', 'ftp://rpc.example.test/SENTINEL-4f2a', 'javascript:SENTINEL-4f2a']) {
      const error = thrownBy(() => chainRpcUrl({ CHAIN_RPC_URL: bad }));
      assert.ok(error, `expected ${JSON.stringify(bad.slice(0, 12))} to be refused`);
      assert.equal(error.code, 'chain_rpc_url_invalid');
      assert.ok(error.message.includes('CHAIN_RPC_URL'), 'message names CHAIN_RPC_URL');
      assert.ok(!error.message.includes('SENTINEL-4f2a'), 'message must not echo the value');
    }
  });

  it('an unusable chain id throws chain_id_invalid and names the variable', () => {
    for (const bad of ['abc', '0', '-1', '1.5', '0x539', '44508x', '99999999999999999999']) {
      const error = thrownBy(() => chainId({ CHAIN_ID: bad }));
      assert.ok(error, `expected CHAIN_ID=${bad} to be refused`);
      assert.equal(error.code, 'chain_id_invalid');
      assert.ok(error.message.includes('CHAIN_ID'));
    }
  });
});

describe('the DDC_RPC_URL / DDC_CHAIN_ID pair the rest of the backend reads', () => {
  it('is the fallback: used when CHAIN_RPC_URL / CHAIN_ID are not set', () => {
    assert.equal(chainRpcUrl({ DDC_RPC_URL: ' https://rpc.example.test/eth ' }), 'https://rpc.example.test/eth');
    assert.equal(chainId({ DDC_CHAIN_ID: ' 777 ' }), 777);
  });

  it('CHAIN_RPC_URL / CHAIN_ID win when both are set; a blank one falls through', () => {
    assert.equal(chainRpcUrl({ CHAIN_RPC_URL: 'http://a.example.test', DDC_RPC_URL: 'http://b.example.test' }), 'http://a.example.test');
    assert.equal(chainId({ CHAIN_ID: '1', DDC_CHAIN_ID: '2' }), 1);
    assert.equal(chainRpcUrl({ CHAIN_RPC_URL: '   ', DDC_RPC_URL: 'http://b.example.test' }), 'http://b.example.test');
    assert.equal(chainId({ CHAIN_ID: '', DDC_CHAIN_ID: '2' }), 2);
  });

  it('with neither set the production defaults apply (NODE_ENV plays no part)', () => {
    assert.equal(chainRpcUrl({ NODE_ENV: 'production' }), DEFAULT_CHAIN_RPC_URL);
    assert.equal(chainId({ NODE_ENV: 'development' }), DEFAULT_CHAIN_ID);
  });

  it('a bad value is an error that names the variable that holds it, never the value', () => {
    const badUrl = thrownBy(() => chainRpcUrl({ DDC_RPC_URL: 'ftp://rpc.example.test/SENTINEL-4f2a' }));
    assert.ok(badUrl && badUrl.code === 'chain_rpc_url_invalid' && badUrl.variable === 'DDC_RPC_URL');
    assert.ok(badUrl.message.includes('DDC_RPC_URL') && !badUrl.message.includes('CHAIN_RPC_URL'));
    assert.ok(!badUrl.message.includes('SENTINEL-4f2a'));

    const badId = thrownBy(() => chainId({ DDC_CHAIN_ID: 'forty-four' }));
    assert.ok(badId && badId.code === 'chain_id_invalid' && badId.variable === 'DDC_CHAIN_ID');
    assert.ok(badId.message.includes('DDC_CHAIN_ID') && !badId.message.includes('forty-four'));
  });

  it('an invalid CHAIN_* value is an error even when the DDC_* one is fine (no silent fall-through)', () => {
    const url = thrownBy(() => chainRpcUrl({ CHAIN_RPC_URL: 'not a url', DDC_RPC_URL: 'https://rpc.example.test' }));
    assert.ok(url && url.variable === 'CHAIN_RPC_URL');
    const id = thrownBy(() => chainId({ CHAIN_ID: 'abc', DDC_CHAIN_ID: '44508' }));
    assert.ok(id && id.variable === 'CHAIN_ID');
  });

  it('the boot check reads through it, and warns about the variable that is really wrong', () => {
    const ok = captureLog();
    const report = warnIfChainSignerUnavailable({
      env: { CHAIN_SIGNER_PRIVATE_KEY: KEY, DDC_RPC_URL: 'https://rpc.example.test/eth', DDC_CHAIN_ID: '777' },
      log: ok,
    });
    assert.equal(ok.ofLevel('warn').length, 0);
    assert.equal(report.rpcHost, 'rpc.example.test');
    assert.equal(report.chainId, 777);

    const bad = captureLog();
    warnIfChainSignerUnavailable({ env: { CHAIN_SIGNER_PRIVATE_KEY: KEY, DDC_CHAIN_ID: 'x', DDC_RPC_URL: 'ftp://h.example.test/SENTINEL' }, log: bad });
    assert.deepEqual(bad.ofLevel('warn').map((call) => call.meta.variable).sort(), ['DDC_CHAIN_ID', 'DDC_RPC_URL']);
    assert.ok(!bad.text().includes('SENTINEL'));
  });

  it('is separate from the signer: BACKEND_WALLET_PRIVATE_KEY and the DDC_* pair never stand in for CHAIN_SIGNER_PRIVATE_KEY', () => {
    const error = thrownBy(() => chainSignerKey({ BACKEND_WALLET_PRIVATE_KEY: KEY, DDC_RPC_URL: 'https://rpc.example.test', DDC_CHAIN_ID: '1' }));
    assert.ok(error && error.code === 'chain_signer_unconfigured');
  });
});

describe('chainSignerKey', () => {
  it('reads CHAIN_SIGNER_PRIVATE_KEY, with or without 0x, trimmed', () => {
    assert.equal(SIGNER_KEY_ENV, 'CHAIN_SIGNER_PRIVATE_KEY');
    assert.ok(chainSignerKey({ CHAIN_SIGNER_PRIVATE_KEY: KEY }) === KEY);
    assert.ok(chainSignerKey({ CHAIN_SIGNER_PRIVATE_KEY: KEY_HEX }) === KEY);
    assert.ok(chainSignerKey({ CHAIN_SIGNER_PRIVATE_KEY: `  ${KEY}\n` }) === KEY);
  });

  it('is not read from any other variable (the old per-NODE_ENV constants are gone)', () => {
    for (const other of ['PROD_MAIN_PRIVATE_KEY', 'DEV_MAIN_PRIVATE_KEY', 'BACKEND_WALLET_PRIVATE_KEY', 'PRIVATE_KEY']) {
      const error = thrownBy(() => chainSignerKey({ [other]: KEY }));
      assert.ok(error && error.code === 'chain_signer_unconfigured', `${other} must not stand in for the signer`);
    }
  });

  it('unset or blank: chain_signer_unconfigured, 503, names the variable', () => {
    for (const env of [{}, { CHAIN_SIGNER_PRIVATE_KEY: '' }, { CHAIN_SIGNER_PRIVATE_KEY: '   ' }]) {
      const error = thrownBy(() => chainSignerKey(env));
      assert.ok(error, 'expected an error');
      assert.equal(error.code, 'chain_signer_unconfigured');
      assert.equal(error.statusCode, 503);
      assert.ok(error.message.includes('CHAIN_SIGNER_PRIVATE_KEY'));
    }
  });

  it('malformed: chain_signer_invalid, names the variable, never contains the value', () => {
    const malformed = [
      KEY_HEX.slice(1), // 63 characters
      `${KEY_HEX}0`, // 65 characters
      `0x${KEY_HEX.slice(0, 62)}zz`, // not hex
      `"${KEY}"`, // quotes left in by an env_file
      `0X${KEY_HEX}`, // upper-case prefix
      `${KEY} ${KEY}`,
      'SENTINEL-not-a-key-4f2a',
    ];
    for (const bad of malformed) {
      const error = thrownBy(() => chainSignerKey({ CHAIN_SIGNER_PRIVATE_KEY: bad }));
      assert.ok(error, 'expected a malformed value to be refused');
      assert.equal(error.code, 'chain_signer_invalid');
      assert.equal(error.statusCode, 503);
      assert.ok(error.message.includes('CHAIN_SIGNER_PRIVATE_KEY'));
      assert.ok(!error.message.includes(KEY_HEX.slice(0, 16)), 'message must not echo any part of the value');
      assert.ok(!error.message.includes('SENTINEL'), 'message must not echo the value');
    }
  });
});

describe('createSignerWallet', () => {
  it('builds the wallet of the configured key, connected to the given provider', () => {
    const provider = { sentinel: true };
    const wallet = createSignerWallet(provider, { CHAIN_SIGNER_PRIVATE_KEY: KEY });
    assert.equal(wallet.address, ADDRESS);
    assert.ok(wallet.provider === provider, 'the wallet uses the provider it was given');
    assert.equal(createSignerWallet(null, { CHAIN_SIGNER_PRIVATE_KEY: KEY_HEX }).address, ADDRESS);
  });

  it('hex that is not a usable secp256k1 key is chain_signer_invalid, without the library message', () => {
    for (const unusable of ['0'.repeat(64), 'f'.repeat(64)]) {
      const error = thrownBy(() => createSignerWallet(null, { CHAIN_SIGNER_PRIVATE_KEY: unusable }));
      assert.ok(error, 'expected an error');
      assert.equal(error.code, 'chain_signer_invalid');
      assert.ok(error.message.includes('CHAIN_SIGNER_PRIVATE_KEY'));
    }
  });

  it('unset: chain_signer_unconfigured', () => {
    const error = thrownBy(() => createSignerWallet(null, {}));
    assert.ok(error && error.code === 'chain_signer_unconfigured');
  });
});

describe('boot check: warnIfChainSignerUnavailable', () => {
  it('key unset: exactly ONE warning, naming the variable, and the API is not stopped', () => {
    const log = captureLog();
    const report = warnIfChainSignerUnavailable({ env: {}, log });
    assert.equal(log.ofLevel('warn').length, 1, 'one warning');
    assert.equal(log.ofLevel('info').length, 0);
    const [warning] = log.ofLevel('warn');
    assert.equal(warning.event, 'chain.signer_unconfigured');
    assert.equal(warning.meta.variable, 'CHAIN_SIGNER_PRIVATE_KEY');
    assert.ok(warning.meta.detail.includes('CHAIN_SIGNER_PRIVATE_KEY'));
    assert.equal(report.signer, 'missing');
    assert.equal(report.signerAddress, null);
  });

  it('key set and valid: no warning; one info line with the PUBLIC address and no secret', () => {
    const log = captureLog();
    const report = warnIfChainSignerUnavailable({ env: { CHAIN_SIGNER_PRIVATE_KEY: KEY }, log });
    assert.equal(log.ofLevel('warn').length, 0);
    const infos = log.ofLevel('info');
    assert.equal(infos.length, 1);
    assert.equal(infos[0].event, 'chain.signer_configured');
    assert.equal(infos[0].meta.signerAddress, ADDRESS);
    assert.equal(infos[0].meta.chainId, 44508);
    assert.equal(infos[0].meta.rpcHost, 'dev-exp-alpha.datadance.ai');
    assert.equal(report.signer, 'ok');
    assert.ok(!log.text().includes(KEY_HEX), 'the log must never contain the key');
  });

  it('key malformed: one warning that names the variable and does not contain the value', () => {
    const log = captureLog();
    const bad = `${KEY_HEX.slice(0, 40)}-SENTINEL`;
    const report = warnIfChainSignerUnavailable({ env: { CHAIN_SIGNER_PRIVATE_KEY: bad }, log });
    assert.equal(log.ofLevel('warn').length, 1);
    assert.equal(log.ofLevel('warn')[0].event, 'chain.signer_invalid');
    assert.equal(log.ofLevel('warn')[0].meta.variable, 'CHAIN_SIGNER_PRIVATE_KEY');
    assert.equal(report.signer, 'invalid');
    assert.ok(!log.text().includes('SENTINEL') && !log.text().includes(KEY_HEX.slice(0, 16)), 'no part of the value in the log');
  });

  it('a bad CHAIN_ID or CHAIN_RPC_URL is its own warning; the key warning stays one', () => {
    const log = captureLog();
    warnIfChainSignerUnavailable({ env: { CHAIN_ID: 'abc', CHAIN_RPC_URL: 'ftp://x.example/SENTINEL' }, log });
    const variables = log.ofLevel('warn').map((call) => call.meta.variable).sort();
    assert.deepEqual(variables, ['CHAIN_ID', 'CHAIN_RPC_URL', 'CHAIN_SIGNER_PRIVATE_KEY']);
    assert.ok(!log.text().includes('SENTINEL'));
  });

  it('logs the RPC host only: an API key embedded in the URL never reaches the log', () => {
    const log = captureLog();
    const env = { CHAIN_SIGNER_PRIVATE_KEY: KEY, CHAIN_RPC_URL: 'https://user:pass@rpc.example.test/v3/SENTINEL-api-key?k=SENTINEL' };
    const report = inspectChainConfig(env);
    warnIfChainSignerUnavailable({ env, log });
    assert.equal(report.rpcHost, 'rpc.example.test');
    assert.ok(!log.text().includes('SENTINEL') && !log.text().includes('user:pass'), 'only the host is reported');
  });

  it('never throws, even on odd values', () => {
    const log = captureLog();
    assert.doesNotThrow(() => warnIfChainSignerUnavailable({
      env: { CHAIN_SIGNER_PRIVATE_KEY: { a: 1 }, CHAIN_ID: [], CHAIN_RPC_URL: {} },
      log,
    }));
  });

  it('works with the default logger (LOG_LEVEL=error keeps it quiet)', () => {
    assert.doesNotThrow(() => warnIfChainSignerUnavailable({ env: {} }));
  });
});
