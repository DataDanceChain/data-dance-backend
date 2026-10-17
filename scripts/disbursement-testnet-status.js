const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '../.env.disbursement.testnet');
const ENV_KEYS = [
  'DISBURSEMENT_NETWORK',
  'BSC_PAYOUT_PRIVATE_KEY',
  'BSC_CHAIN_ID',
  'BSC_USDT_ADDRESS',
  'BSC_RPC_URL',
];

function loadTestnetEnv() {
  const text = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!ENV_KEYS.includes(key)) continue;
    process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

async function main() {
  loadTestnetEnv();
  const { describeFunding, payoutSignerProblem } = require('../src/services/disbursement/bscPayout');
  const { networkName } = require('../src/services/disbursement/networks');
  const problem = payoutSignerProblem();
  if (problem) {
    console.error(`signer ${problem}`);
    process.exit(1);
  }
  const funding = await describeFunding();
  console.log(JSON.stringify({
    network: networkName(),
    signer: 'configured',
    address: funding.address,
    chainId: funding.chainId,
    asset: funding.asset,
    tokenAddress: funding.tokenAddress,
    usdtBalance: funding.usdtBalance,
    bnbBalance: funding.bnbBalance,
    gasPaidBy: funding.gasPaidBy,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.code || 'testnet_status_failed');
  process.exit(1);
});
