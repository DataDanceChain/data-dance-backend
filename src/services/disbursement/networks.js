const PROFILES = {
  mainnet: {
    chainId: 56,
    usdt: '0x55d398326f99059fF775485246999027B3197955',
    rpc: 'https://bsc-dataseed.binance.org',
  },
  testnet: {
    chainId: 97,
    usdt: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
    rpc: 'https://bsc-testnet-rpc.publicnode.com',
  },
};

function networkName() {
  const requested = String(process.env.DISBURSEMENT_NETWORK || 'mainnet').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROFILES, requested) ? requested : 'mainnet';
}

function networkProfile() {
  return PROFILES[networkName()];
}

module.exports = {
  PROFILES,
  networkName,
  networkProfile,
};
