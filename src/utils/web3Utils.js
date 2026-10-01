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

const ActivityNFTFactoryABI = [
    "function create(bytes32 activityId, address owner) external returns (address)",
    "event ActivityNFTContractCreated(address indexed newContract)"
];

const ActivityNFTABI = [
    "function mint(bytes32 hashedUserId) external onlyOwner returns (uint256 tokenId)",
    "function snapshot() external onlyOwner returns (uint256 snapId)",
    "event ActivityNFTMinted(uint256 tokenId, bytes32 hashedUserId)",
    "event ActivityNFTSnapshot(uint256 snapId, bytes32[] holders)"
]

const DataNFTFactoryABI = [
    "function create(bytes32 collectionId, address owner) external returns (address)",
    "event DataNFTContractCreated(address indexed newContract)"
]

const DataNFTABI = [
    "function mint(bytes32 hashedUserId) external onlyOwner returns (uint256 tokenId)",
    "event DataNFTMinted(uint256 tokenId, bytes32 hashedUserId)"
]

const activityNFTFactoryAddress = '0x1Ee817752d98037eA6a2Ca38325e496dCAA3CB40';

const dataNFTFactoryAddress = '0xc565EB7363769f8ffAe0005285ccD854c631A0a0';

exports.getActivityNFTContract = async (address) => {
    const contract = new ethers.Contract(address, ActivityNFTABI, getDdcProvider());
    return contract;
}

exports.getDataNFTContract = async (address) => {
    const contract = new ethers.Contract(address, DataNFTABI, getDdcProvider());
    return contract;
}

exports.createActivityNFTContract = async (activityId, owner) => {
    const wallet = signerWallet();
    console.log("Wallet:", wallet.address);
    console.log("Wallet balance:", await wallet.provider.getBalance(wallet.address));
    const activityNFTFactoryWithSigner = new ethers.Contract(activityNFTFactoryAddress, ActivityNFTFactoryABI, wallet);

    activityNFTFactoryWithSigner.on("ActivityNFTContractCreated", (contractAddress, event) => {
        console.log(`${contractAddress}`);
        event.removeListener();
    });

    const tx = await activityNFTFactoryWithSigner.create(activityId, owner);
    const receipt = await tx.wait();
    return receipt.logs;
}

exports.getDdcProvider = getDdcProvider;

exports.getBackendWallet = (overrideProvider) => {
    return signerWallet(overrideProvider);
};

exports.createDataNFTContract = async (collectionId, owner) => {
    const wallet = signerWallet();
    // Unchanged from before: the factory is built from DataNFTABI, which has no `create`, so this
    // function cannot work as written. Nothing calls it.
    const dataNFTFactoryWithSigner = new ethers.Contract(dataNFTFactoryAddress, DataNFTABI, wallet);

    dataNFTFactoryWithSigner.on("DataNFTContractCreated", (contractAddress, event) => {
        console.log(`${contractAddress}`);
        event.removeListener();
    });

    const tx = await dataNFTFactoryWithSigner.create(collectionId, owner);
    const receipt = await tx.wait();
    return receipt.logs;
}
