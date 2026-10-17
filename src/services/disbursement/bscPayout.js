const { ethers } = require('ethers');
const { evaluateSend, tokenAddress, chainId, limits } = require('./policy');
const { networkProfile } = require('./networks');

const TRANSFER_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];
const FALLBACK_GAS_WEI = 100_000n * 5_000_000_000n;

function rpcUrl() {
  return String(process.env.BSC_RPC_URL || networkProfile().rpc).trim();
}

function normalizeKey(value) {
  const key = String(value || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(key)) return key;
  if (/^[0-9a-fA-F]{64}$/.test(key)) return `0x${key}`;
  return '';
}

function blockedPayoutKeys() {
  return [process.env.BACKEND_WALLET_PRIVATE_KEY]
    .map(normalizeKey)
    .filter(Boolean);
}

function payoutSignerProblem() {
  const key = normalizeKey(process.env.BSC_PAYOUT_PRIVATE_KEY);
  if (!key) return 'missing';
  if (blockedPayoutKeys().includes(key)) return 'shared';
  return '';
}

function payoutSigningKey() {
  return payoutSignerProblem() ? '' : normalizeKey(process.env.BSC_PAYOUT_PRIVATE_KEY);
}

function getPayoutWallet(provider) {
  const key = payoutSigningKey();
  if (!key) return null;
  return new ethers.Wallet(key, provider);
}

function signerError() {
  if (payoutSignerProblem() === 'shared') {
    return Object.assign(
      new Error('BSC payout signer must be a dedicated DataDance key'),
      { statusCode: 503, code: 'payout_signer_not_dedicated' },
    );
  }
  return Object.assign(
    new Error('BSC payout signer is not configured'),
    { statusCode: 503, code: 'payout_signer_unconfigured' },
  );
}

function assessFloat({ usdtUnits, bnbWei, neededUnits, gasWei = 0n } = {}) {
  if (usdtUnits < neededUnits) {
    return {
      ok: false,
      code: 'insufficient_usdt',
      message: 'Payout address does not have enough USDT. Top it up. Gas is not taken from the amount sent.',
    };
  }
  if (bnbWei < gasWei) {
    return {
      ok: false,
      code: 'insufficient_gas',
      message: 'Payout address does not have enough BNB for gas. Top up BNB separately.',
    };
  }
  return { ok: true };
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

async function readPayoutFloat(provider, signer) {
  const address = signer.address || await signer.getAddress();
  const contract = new ethers.Contract(tokenAddress(), TRANSFER_ABI, provider);
  const decimals = Number(await contract.decimals());
  const [usdtUnits, bnbWei] = await Promise.all([
    contract.balanceOf(address),
    provider.getBalance(address),
  ]);
  return { address, decimals, usdtUnits, bnbWei, contract };
}

async function gasBudgetWei(provider, contract, to, units) {
  try {
    const gas = await contract.transfer.estimateGas(to, units);
    const fee = await provider.getFeeData();
    const price = fee.maxFeePerGas || fee.gasPrice || 5_000_000_000n;
    return gas * price * 2n;
  } catch {
    return FALLBACK_GAS_WEI;
  }
}

async function describeFunding() {
  if (payoutSignerProblem()) throw signerError();
  const rpc = getProvider();
  const signer = getPayoutWallet(rpc);
  if (!signer) throw signerError();
  const float = await readPayoutFloat(rpc, signer);
  const cap = limits();
  return {
    address: float.address,
    chainId: chainId(),
    asset: 'USDT',
    tokenAddress: tokenAddress(),
    usdtBalance: ethers.formatUnits(float.usdtUnits, float.decimals),
    bnbBalance: ethers.formatEther(float.bnbWei),
    gasPaidBy: 'payout_address',
    perItemMax: cap.perItemMax,
    monthlyMax: cap.monthlyMax,
  };
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
  if (!signer) throw signerError();

  const network = await rpc.getNetwork();
  if (Number(network.chainId) !== decision.chainId) {
    throw Object.assign(new Error('BSC payout signer is connected to the wrong chain'), {
      statusCode: 409,
      code: 'unexpected_chain',
    });
  }

  const already = await confirmedHash(rpc, existingTxHash);
  if (already) return { txHash: already, replayed: true };

  const float = await readPayoutFloat(rpc, signer);
  const units = amountToUnits(decision.amount, float.decimals);
  const covered = assessFloat({
    usdtUnits: float.usdtUnits,
    bnbWei: float.bnbWei,
    neededUnits: units,
    gasWei: 0n,
  });
  if (!covered.ok) {
    throw Object.assign(new Error(covered.message), { statusCode: 409, code: covered.code });
  }
  const contract = float.contract.connect(signer);
  const gasWei = await gasBudgetWei(rpc, contract, decision.walletAddress, units);
  const gas = assessFloat({
    usdtUnits: float.usdtUnits,
    bnbWei: float.bnbWei,
    neededUnits: units,
    gasWei,
  });
  if (!gas.ok) {
    throw Object.assign(new Error(gas.message), { statusCode: 409, code: gas.code });
  }
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
  payoutSignerProblem,
  getProvider,
  amountToUnits,
  assessFloat,
  describeFunding,
  sendBscUsdt,
};
