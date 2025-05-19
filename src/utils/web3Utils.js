const ethers = require('ethers');

const PROD_PROVIDER = new ethers.JsonRpcProvider('https://dev-exp-alpha.datadance.ai/eth/rpc', 44508, {
    batchMaxCount: 1,
});
const DEV_PROVIDER = new ethers.JsonRpcProvider('http://localhost:8545');
const provider = process.env.NODE_ENV === 'production' ? PROD_PROVIDER : DEV_PROVIDER;

const PROD_MAIN_PRIVATE_KEY = "0xa174c554214fa873a481dc01aa2cf99c9486a07733b28b1f9b127efccd7bbb11";
const DEV_MAIN_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const mainPrivateKey = process.env.NODE_ENV === 'production' ? PROD_MAIN_PRIVATE_KEY : DEV_MAIN_PRIVATE_KEY;

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
const activityNFTFactoryContract = new ethers.Contract(activityNFTFactoryAddress, ActivityNFTFactoryABI, provider);

const dataNFTFactoryAddress = '0xc565EB7363769f8ffAe0005285ccD854c631A0a0';
const dataNFTFactoryContract = new ethers.Contract(dataNFTFactoryAddress, DataNFTABI, provider);

exports.getActivityNFTContract = async (address) => {
    const contract = new ethers.Contract(address, ActivityNFTABI, provider);
    return contract;
}

exports.getDataNFTContract = async (address) => {
    const contract = new ethers.Contract(address, DataNFTABI, provider);
    return contract;
}

exports.createActivityNFTContract = async (activityId, owner) => {
    const wallet = new ethers.Wallet(mainPrivateKey, provider);
    console.log("Wallet:", wallet.address);
    console.log("Wallet balance:", await provider.getBalance(wallet.address));
    const activityNFTFactoryWithSigner = activityNFTFactoryContract.connect(wallet);

    activityNFTFactoryWithSigner.on("ActivityNFTContractCreated", (contractAddress, event) => {
        console.log(`${contractAddress}`);
        event.removeListener();
    });

    const tx = await activityNFTFactoryWithSigner.create(activityId, owner);
    const receipt = await tx.wait();
    return receipt.logs;
}

exports.createDataNFTContract = async (collectionId, owner) => {
    const wallet = new ethers.Wallet(mainPrivateKey, provider);
    const dataNFTFactoryWithSigner = dataNFTFactoryContract.connect(wallet);

    dataNFTFactoryWithSigner.on("DataNFTContractCreated", (contractAddress, event) => {
        console.log(`${contractAddress}`);
        event.removeListener();
    });

    const tx = await dataNFTFactoryWithSigner.create(collectionId, owner);
    const receipt = await tx.wait();
    return receipt.logs;
}
