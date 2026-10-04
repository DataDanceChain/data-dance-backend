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
 * Lower-cased topics of `log` when it is an un-removed Attested(bytes32,address) log emitted by
 * `attester` with exactly three topics and empty data; otherwise null.
 */
function attestedLogTopics(log, attester) {
  if (!log || log.removed === true) return null;
  if (!sameAddress(log.address, attester)) return null;
  const topics = Array.isArray(log.topics) ? log.topics.map((t) => String(t).toLowerCase()) : [];
  if (topics.length !== 3 || topics[0] !== ATTESTED_TOPIC) return null;
  if (!(log.data === undefined || log.data === null || log.data === '0x')) return null;
  return topics;
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
    const topics = attestedLogTopics(log, attester);
    return Boolean(topics) && topics[1] === expectedHash && topics[2] === expectedSender;
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

function submittedError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/;

/**
 * Checks a transaction hash that a caller (an org user or ops) says attests `hashHex`, before it is
 * stored as attestationTxHash. Passes only when the mined receipt has status 1 and an
 * Attested(hash, sender) log from the configured attester whose hash topic equals `hashHex`. The
 * sender is not required to be the backend wallet (an org may attest from its own wallet); it is
 * returned so the caller can record it.
 *
 * Resolves { txHash, sender, attester, blockNumber }. Rejects with an Error carrying
 * statusCode/code: 422 when the transaction does not prove the attestation, 503 when the chain
 * cannot be asked. Callers store nothing on rejection.
 *
 * `deps` exists for tests: { provider, attester }.
 */
async function verifySubmittedAttestation(txHash, hashHex, deps = {}) {
  const submitted = String(txHash ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(submitted)) {
    throw submittedError(422, 'ATTESTATION_TX_MALFORMED', 'txHash must be a 0x-prefixed 32-byte transaction hash');
  }
  const expectedHash = toBytes32(hashHex);
  const attester = deps.attester || getAttesterAddress();
  if (!attester || !ethers.isAddress(attester)) {
    throw submittedError(503, 'ATTESTATION_CHAIN_UNAVAILABLE', 'The attester contract is not configured; nothing was saved');
  }

  let receipt;
  try {
    const provider = deps.provider || getProvider();
    receipt = await withTimeout(provider.getTransactionReceipt(submitted), 'eth_getTransactionReceipt timed out');
  } catch {
    throw submittedError(503, 'ATTESTATION_CHAIN_UNAVAILABLE', 'Could not reach the DDC chain to verify the transaction; nothing was saved. Try again later');
  }
  if (!receipt) {
    throw submittedError(422, 'ATTESTATION_TX_NOT_FOUND', 'Transaction not found on the DDC chain, or not mined yet; nothing was saved');
  }
  const receiptHash = String(receipt.hash || receipt.transactionHash || '').toLowerCase();
  if (receiptHash !== submitted.toLowerCase()) {
    throw submittedError(503, 'ATTESTATION_CHAIN_UNAVAILABLE', 'The DDC chain returned an inconsistent receipt; nothing was saved. Try again later');
  }
  if (!receiptStatusIsSuccess(receipt.status)) {
    throw submittedError(422, 'ATTESTATION_TX_FAILED', 'Transaction did not succeed on the DDC chain (status is not 1); nothing was saved');
  }
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  for (const log of logs) {
    const topics = attestedLogTopics(log, attester);
    if (!topics || topics[1] !== expectedHash || !ADDRESS_TOPIC.test(topics[2])) continue;
    return {
      txHash: submitted,
      sender: ethers.getAddress(`0x${topics[2].slice(26)}`),
      attester: ethers.getAddress(attester),
      blockNumber: receipt.blockNumber ?? null,
    };
  }
  throw submittedError(422, 'ATTESTATION_TX_NOT_ATTESTED', 'Transaction has no Attested log from the CommerceAttester contract for this order\'s attestation hash; nothing was saved');
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
  verifySubmittedAttestation,
  attesterHasCode,
  addressTopic,
  toBytes32,
};
