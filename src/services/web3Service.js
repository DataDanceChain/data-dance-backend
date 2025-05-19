// Ethers v6 CJS import
const { JsonRpcProvider, formatEther } = require('ethers');

// Read configuration from environment variables
const RPC_URL = process.env.DDC_RPC_URL;
const DDC_CHAIN_ID = process.env.DDC_CHAIN_ID ? parseInt(process.env.DDC_CHAIN_ID, 10) : undefined;

// Minimal ERC20 ABI for balanceOf
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

// Initialize provider (with optional chainId)
const provider = DDC_CHAIN_ID
  ? new JsonRpcProvider(RPC_URL, DDC_CHAIN_ID)
  : new JsonRpcProvider(RPC_URL);

/**
 * Fetch DDC token balance for a wallet address
 * @param {string} walletAddress
 * @returns {Promise<number>} balance in DDC (formatted from wei)
 */
async function getDDCBalance(walletAddress) {
  if (!walletAddress) return 0;
  try {
    // Fetch native DDC balance (wei)
    const balanceWei = await provider.getBalance(walletAddress);
    // Convert to DDC unit
    return parseFloat(formatEther(balanceWei));
  } catch (error) {
    console.error('Error fetching DDC balance:', error);
    return 0;
  }
}

module.exports = { getDDCBalance };