const ethers = require('ethers');
const { chainRpcUrl, chainId, chainSignerKey, createSignerWallet } = require('../constants/chainConfig');

// Chain settings and the signer key come from the environment (src/constants/chainConfig.js):
// CHAIN_SIGNER_PRIVATE_KEY, CHAIN_RPC_URL, CHAIN_ID. No key is kept in this file, and nothing is
// read or connected at require time, so the API boots with or without them.

// One provider per distinct (endpoint, chain id); rebuilt only if the settings change.
let cachedProvider = null;
let cachedProviderKey = '';

const getDdcProvider = () => {
    const url = chainRpcUrl();
    const id = chainId();
    const key = `${id}|${url}`;
    if (!cachedProvider || cachedProviderKey !== key) {
        // Some RPC nodes reject batched requests.
        cachedProvider = new ethers.JsonRpcProvider(url, id, { batchMaxCount: 1 });
        cachedProviderKey = key;
    }
    return cachedProvider;
};

// The signing wallet. When CHAIN_SIGNER_PRIVATE_KEY is unset or not a key this throws an error that
// names it, before any provider is built, so a misconfigured server fails without touching RPC.
const signerWallet = (overrideProvider) => {
    chainSignerKey();
    return createSignerWallet(overrideProvider || getDdcProvider());
};

const ActivityNFTABI = [
    "function mint(bytes32 hashedUserId) external onlyOwner returns (uint256 tokenId)",
    "function snapshot() external onlyOwner returns (uint256 snapId)",
    "event ActivityNFTMinted(uint256 tokenId, bytes32 hashedUserId)",
    "event ActivityNFTSnapshot(uint256 snapId, bytes32[] holders)"
]

const DataNFTABI = [
    "function mint(bytes32 hashedUserId) external onlyOwner returns (uint256 tokenId)",
    "event DataNFTMinted(uint256 tokenId, bytes32 hashedUserId)"
]

exports.getActivityNFTContract = async (address) => {
    const contract = new ethers.Contract(address, ActivityNFTABI, getDdcProvider());
    return contract;
}

exports.getDataNFTContract = async (address) => {
    const contract = new ethers.Contract(address, DataNFTABI, getDdcProvider());
    return contract;
}

// ---------------------------------------------------------------------------
// Creating an activity's NFT contract (POST /api/activities/new).
//
// Refused here whatever ACTIVITY_NFT_ENABLED says, before any wallet, provider or RPC call. The code
// this replaces could never succeed: it called create(bytes32,address), which the deployed factory
// does not implement (its creation function takes other arguments), and it passed the creator's user
// id, a UUID, as the bytes32, so ethers threw before sending. The deployed factories must not be
// reused. It also registered a listener for the factory's creation event before sending and removed
// it only from inside that event's callback, so every call left a listener on the shared provider
// for the life of the process.
//
// Re-enabling needs a new factory with a verified ABI and a new owner key. Then only the two
// functions below change: activityNftUnavailableReason() returns null once that factory is
// configured, and createActivityNFTContract() sends the transaction, waits for the receipt and reads
// the new contract's address from receipt.logs (factory.interface.parseLog). Never contract.on() or
// provider.on() here: a request must not leave a subscription behind.
// ---------------------------------------------------------------------------

/** Why an activity's NFT contract cannot be created now, for the server log; null once it can. */
const activityNftUnavailableReason = () =>
    'no activity NFT factory with a verified interface is configured (the deployed factories must not be reused)';

/** Always rejects with code ACTIVITY_NFT_UNAVAILABLE today, before any wallet, provider or RPC call. */
exports.createActivityNFTContract = async () => {
    throw Object.assign(new Error(`activity NFT creation is unavailable: ${activityNftUnavailableReason()}`), {
        code: 'ACTIVITY_NFT_UNAVAILABLE',
    });
};

exports.activityNftUnavailableReason = activityNftUnavailableReason;

exports.getDdcProvider = getDdcProvider;

exports.getBackendWallet = (overrideProvider) => {
    return signerWallet(overrideProvider);
};
