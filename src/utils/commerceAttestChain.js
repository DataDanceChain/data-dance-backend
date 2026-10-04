const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DEFAULT_RPC = 'https://dev-exp-alpha.datadance.ai/eth/rpc';
const DEFAULT_CHAIN_ID = 44508;
const DEFAULT_ATTESTER = '0xe944f723af28659622425F62a49F48844C152a93';
const CHAIN_TIMEOUT_MS = 20000;

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), CHAIN_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
const ATTESTER_ABI = [
  'function attest(bytes32 hash)',
  'event Attested(bytes32 indexed hash, address indexed sender)',
];

function readDeployedAddress() {
  try {
    const file = path.join(__dirname, '../contracts/commerceAttester.deployed.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return String(json.address || '').trim();
  } catch {
    return '';
  }
}

function getAttesterAddress() {
  const fromEnv = String(process.env.COMMERCE_ATTESTER || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(fromEnv)) return fromEnv;
  const fromFile = readDeployedAddress();
  if (/^0x[0-9a-fA-F]{40}$/.test(fromFile)) return fromFile;
  return DEFAULT_ATTESTER;
}

function getRpcUrl() {
  return String(process.env.DDC_RPC_URL || DEFAULT_RPC).trim();
}

function getChainId() {
  const parsed = Number(process.env.DDC_CHAIN_ID);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHAIN_ID;
}

function getProvider() {
  return new ethers.JsonRpcProvider(getRpcUrl(), getChainId(), { batchMaxCount: 1 });
}

function getEnvPrivateKey() {
  const key = String(process.env.BACKEND_WALLET_PRIVATE_KEY || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(key) || /^[0-9a-fA-F]{64}$/.test(key)) {
    return key.startsWith('0x') ? key : `0x${key}`;
  }
  return '';
}

function getBackendWallet(provider) {
  const envKey = getEnvPrivateKey();
  if (envKey) return new ethers.Wallet(envKey, provider);
  const web3Utils = require('./web3Utils');
  if (typeof web3Utils.getBackendWallet === 'function') {
    return web3Utils.getBackendWallet(provider);
  }
  return null;
}

function toBytes32(hashHex) {
  const hex = String(hashHex || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('Attestation hash must be 32 bytes');
  }
  return `0x${hex}`;
}

const ATTESTED_TOPIC = ethers.id('Attested(bytes32,address)');
const attesterInterface = new ethers.Interface(ATTESTER_ABI);

let cachedLogger = null;
function defaultLog() {
  if (!cachedLogger) cachedLogger = require('./logger').createLogger('commerceAttestChain');
  return cachedLogger;
}

function describeSkip(reason, extra = {}) {
  return {
    ok: false,
    pending: true,
    txHash: null,
    reason,
    attester: getAttesterAddress() || null,
    chainId: getChainId(),
    ...extra,
  };
}

function receiptStatusIsSuccess(status) {
  if (status === null || status === undefined) return false;
  try {
    return BigInt(status) === 1n;
  } catch {
    return false;
  }
}

function sameAddress(a, b) {
  return ethers.isAddress(a) && ethers.isAddress(b) && ethers.getAddress(a) === ethers.getAddress(b);
}

function addressTopic(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32).toLowerCase();
}

/**
 * True only when `receipt` succeeded (status 1) and carries an Attested(hash, sender) log emitted
 * by `attester` with exactly `hash` and `sender`. Pure: no network. Works on ethers receipts and on
 * raw JSON-RPC receipts (status "0x1").
 */
function verifyAttestedReceipt(receipt, { attester, hash, sender }) {
  if (!receipt) return { ok: false, code: 'no_receipt', reason: 'no receipt' };
  if (!receiptStatusIsSuccess(receipt.status)) {
    return { ok: false, code: 'status_not_1', reason: `transaction status is not 1 (${String(receipt.status)})` };
  }
  if (!ethers.isAddress(attester)) return { ok: false, code: 'invalid_attester', reason: 'attester address is invalid' };
  if (!ethers.isAddress(sender)) return { ok: false, code: 'invalid_sender', reason: 'sender address is invalid' };
  let expectedHash;
  try {
    expectedHash = toBytes32(hash);
  } catch (error) {
    return { ok: false, code: 'invalid_hash', reason: error.message };
  }
  const expectedSender = addressTopic(sender);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const match = logs.find((log) => {
    if (!log || log.removed === true) return false;
    if (!sameAddress(log.address, attester)) return false;
    const topics = Array.isArray(log.topics) ? log.topics.map((t) => String(t).toLowerCase()) : [];
    return topics.length === 3
      && topics[0] === ATTESTED_TOPIC
      && topics[1] === expectedHash
      && topics[2] === expectedSender
      && (log.data === undefined || log.data === null || log.data === '0x');
  });
  if (!match) {
    return {
      ok: false,
      code: logs.length ? 'no_matching_log' : 'no_logs',
      reason: logs.length
        ? 'receipt has no Attested log from the attester for this hash and sender'
        : 'receipt has no logs (call did not reach the attester contract)',
    };
  }
  return { ok: true, logIndex: match.index ?? match.logIndex ?? null };
}

// Addresses already seen with code. Only positive results are cached.
const attesterWithCode = new Set();

async function attesterHasCode(provider, attester) {
  const key = ethers.getAddress(attester);
  if (attesterWithCode.has(key)) return true;
  const code = await withTimeout(provider.getCode(key), 'eth_getCode timed out');
  const has = typeof code === 'string' && code !== '0x' && code.length > 2;
  if (has) attesterWithCode.add(key);
  return has;
}

/**
 * Sends attest(hash) from the backend wallet and returns ok:true only when the mined receipt
 * proves it (see verifyAttestedReceipt). Never throws: every failure is
 * { ok:false, pending:true, reason } and is logged.
 *
 * `deps` exists for tests and the re-attest script: { provider, wallet, attester, log }.
 */
async function attestHashOnChain(hashHex, deps = {}) {
  const log = deps.log || null;
  const skip = (reason, extra = {}) => {
    try {
      (log || defaultLog()).warn('commerce attestation not confirmed on chain', {
        reason,
        ...(extra.sentTxHash ? { sentTxHash: extra.sentTxHash } : {}),
      });
    } catch {
      // Logging must never turn a skip into a throw.
    }
    return describeSkip(reason, extra);
  };

  try {
    const attester = deps.attester || getAttesterAddress();
    if (!attester || !ethers.isAddress(attester)) {
      return skip('COMMERCE_ATTESTER not configured');
    }

    let hash;
    try {
      hash = toBytes32(hashHex);
    } catch (error) {
      return skip(error.message);
    }

    let provider;
    try {
      provider = deps.provider || getProvider();
      await withTimeout(provider.getBlockNumber(), 'DDC RPC timed out');
    } catch (error) {
      return skip(error.message || 'DDC RPC unavailable');
    }

    try {
      if (!(await attesterHasCode(provider, attester))) {
        return skip(`attester ${attester} has no contract code`);
      }
    } catch (error) {
      return skip(error.message || 'eth_getCode failed');
    }

    let wallet;
    try {
      wallet = deps.wallet || getBackendWallet(provider);
    } catch (error) {
      return skip(error.message || 'Backend wallet unavailable');
    }
    if (!wallet) {
      return skip('Backend wallet unavailable');
    }

    let sender;
    try {
      sender = await wallet.getAddress();
    } catch (error) {
      return skip(error.message || 'Backend wallet address unavailable');
    }

    let tx;
    try {
      tx = await withTimeout(
        wallet.sendTransaction({
          to: ethers.getAddress(attester),
          data: attesterInterface.encodeFunctionData('attest', [hash]),
        }),
        'attest(bytes32) send timed out',
      );
    } catch (error) {
      return skip(error.shortMessage || error.message || 'attest(bytes32) send failed');
    }
    const sentTxHash = tx?.hash || null;

    let receipt;
    try {
      receipt = await withTimeout(tx.wait(), 'attest(bytes32) receipt timed out');
    } catch (error) {
      return skip(error.shortMessage || error.message || 'attest(bytes32) failed', { sentTxHash });
    }

    const txHash = receipt?.hash || receipt?.transactionHash || null;
    if (!txHash) {
      return skip('Chain accepted the call but returned no receipt or transaction hash', { sentTxHash });
    }
    if (sentTxHash && String(sentTxHash).toLowerCase() !== String(txHash).toLowerCase()) {
      return skip('Receipt does not belong to the sent transaction', { sentTxHash });
    }
    const verdict = verifyAttestedReceipt(receipt, { attester, hash, sender });
    if (!verdict.ok) {
      return skip(verdict.reason, { sentTxHash: txHash });
    }
    return {
      ok: true,
      pending: false,
      txHash,
      attester: ethers.getAddress(attester),
      chainId: getChainId(),
    };
  } catch (error) {
    return skip((error && error.message) || 'attest(bytes32) failed');
  }
}

module.exports = {
  ATTESTER_ABI,
  ATTESTED_TOPIC,
  getAttesterAddress,
  getRpcUrl,
  getChainId,
  getProvider,
  getBackendWallet,
  attestHashOnChain,
  verifyAttestedReceipt,
  attesterHasCode,
  addressTopic,
  toBytes32,
};
