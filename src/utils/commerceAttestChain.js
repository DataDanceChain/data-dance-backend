const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DEFAULT_RPC = 'https://dev-exp-alpha.datadance.ai/eth/rpc';
const DEFAULT_CHAIN_ID = 44508;
const DEFAULT_ATTESTER = '0xE0fFF93Ae34D87E6393242b7BbB46029E8d02FeC';
const CHAIN_TIMEOUT_MS = 20000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), CHAIN_TIMEOUT_MS);
    }),
  ]);
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

function describeSkip(reason) {
  return {
    ok: false,
    pending: true,
    txHash: null,
    reason,
    attester: getAttesterAddress() || null,
    chainId: getChainId(),
  };
}

async function attestHashOnChain(hashHex) {
  const attester = getAttesterAddress();
  if (!attester) {
    return describeSkip('COMMERCE_ATTESTER not configured');
  }

  let provider;
  try {
    provider = getProvider();
    await withTimeout(provider.getBlockNumber(), 'DDC RPC timed out');
  } catch (error) {
    return describeSkip(error.message || 'DDC RPC unavailable');
  }

  let wallet;
  try {
    wallet = getBackendWallet(provider);
  } catch (error) {
    return describeSkip(error.message || 'Backend wallet unavailable');
  }
  if (!wallet) {
    return describeSkip('Backend wallet unavailable');
  }

  try {
    const contract = new ethers.Contract(attester, ATTESTER_ABI, wallet);
    const tx = await withTimeout(contract.attest(toBytes32(hashHex)), 'attest(bytes32) send timed out');
    const receipt = await withTimeout(tx.wait(), 'attest(bytes32) receipt timed out');
    const txHash = receipt?.hash || tx.hash || null;
    if (!txHash) {
      return describeSkip('Chain accepted the call but returned no transaction hash');
    }
    return {
      ok: true,
      pending: false,
      txHash,
      attester,
      chainId: getChainId(),
    };
  } catch (error) {
    return describeSkip(error.message || 'attest(bytes32) failed');
  }
}

module.exports = {
  ATTESTER_ABI,
  getAttesterAddress,
  getRpcUrl,
  getChainId,
  getProvider,
  getBackendWallet,
  attestHashOnChain,
  toBytes32,
};
