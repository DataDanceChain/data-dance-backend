const { ethers } = require('ethers');
const { evaluateSend, tokenAddress, chainId } = require('./policy');

const TRANSFER_ABI = [
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

function rpcUrl() {
  return String(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org').trim();
}

function normalizeKey(value) {
  const key = String(value || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(key)) return key;
  if (/^[0-9a-fA-F]{64}$/.test(key)) return `0x${key}`;
  return '';
}

function getPayoutWallet(provider) {
  const key = normalizeKey(process.env.BSC_PAYOUT_PRIVATE_KEY);
  if (!key) return null;
  return new ethers.Wallet(key, provider);
}

function getProvider() {
  return new ethers.JsonRpcProvider(rpcUrl(), chainId(), { batchMaxCount: 1 });
}

function amountToUnits(amount, decimals) {
  const text = String(amount);
  const [whole, frac = ''] = text.split('.');
  const scale = BigInt(decimals);
  const base = 10n ** scale;
  const fraction = (frac + '0'.repeat(Number(scale))).slice(0, Number(scale));
  return BigInt(whole || '0') * base + BigInt(fraction || '0');
}

async function confirmedHash(provider, txHash) {
  if (!txHash) return '';
  const receipt = await provider.getTransactionReceipt(txHash);
  if (receipt && receipt.status === 1) return receipt.hash;
  return '';
}

/**
 * Send BSC USDT from the dedicated payout wallet.
 * The DDC attestation key is never accepted here.
 */
async function sendBscUsdt({ to, amount, existingTxHash, provider, wallet } = {}) {
  const decision = evaluateSend({
    amount,
    walletAddress: to,
    token: tokenAddress(),
    chain: chainId(),
  });
  if (!decision.ok) {
    throw Object.assign(new Error(decision.message), { statusCode: 409, code: decision.code });
  }

  const rpc = provider || getProvider();
  const signer = wallet === undefined ? getPayoutWallet(rpc) : wallet;
  if (!signer) {
    throw Object.assign(
      new Error('BSC payout signer is not configured'),
      { statusCode: 503, code: 'payout_signer_unconfigured' },
    );
  }

  const network = await rpc.getNetwork();
  if (Number(network.chainId) !== decision.chainId) {
    throw Object.assign(new Error('BSC payout signer is connected to the wrong chain'), {
      statusCode: 409,
      code: 'unexpected_chain',
    });
  }

  const already = await confirmedHash(rpc, existingTxHash);
  if (already) return { txHash: already, replayed: true };

  const contract = new ethers.Contract(decision.tokenAddress, TRANSFER_ABI, signer);
  const decimals = Number(await contract.decimals());
  const units = amountToUnits(decision.amount, decimals);
  const tx = await contract.transfer(decision.walletAddress, units);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw Object.assign(new Error('BSC USDT transfer failed'), { statusCode: 502, code: 'bsc_transfer_failed' });
  }
  return { txHash: receipt.hash, replayed: false };
}

module.exports = {
  TRANSFER_ABI,
  rpcUrl,
  getPayoutWallet,
  getProvider,
  amountToUnits,
  sendBscUsdt,
};
