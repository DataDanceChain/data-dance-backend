/**
 * Deploy CommerceAttester to DDC chain 44508 using the backend wallet.
 * Does not print private keys. Writes src/contracts/commerceAttester.deployed.json
 * when the tx lands.
 *
 * Usage:
 *   node scripts/deployCommerceAttester.js
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { getProvider, getBackendWallet, getChainId, getRpcUrl } = require('../src/utils/commerceAttestChain');

const ARTIFACT = path.join(__dirname, '../src/contracts/commerceAttester.deployed.json');
const BYTECODE_FILE = path.join(__dirname, '../src/contracts/CommerceAttester.bytecode.json');

async function compileIfNeeded() {
  if (fs.existsSync(BYTECODE_FILE)) {
    return JSON.parse(fs.readFileSync(BYTECODE_FILE, 'utf8'));
  }
  let solc;
  try {
    solc = require('solc');
  } catch {
    throw new Error('No CommerceAttester.bytecode.json and solc is not installed');
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/contracts/CommerceAttester.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'CommerceAttester.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const contract = output.contracts?.['CommerceAttester.sol']?.CommerceAttester;
  if (!contract?.evm?.bytecode?.object) {
    throw new Error('solc did not produce CommerceAttester bytecode');
  }
  const artifact = {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object.replace(/^0x/, '')}`,
  };
  fs.writeFileSync(BYTECODE_FILE, JSON.stringify(artifact, null, 2));
  return artifact;
}

async function main() {
  const artifact = await compileIfNeeded();
  const provider = getProvider();
  const wallet = getBackendWallet(provider);
  if (!wallet) throw new Error('Backend wallet unavailable');
  const block = await provider.getBlockNumber();
  const balance = await provider.getBalance(wallet.address);
  console.log('chain', getChainId(), 'rpc', getRpcUrl(), 'block', block);
  console.log('deployer', wallet.address, 'balanceWei', balance.toString());
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  const deployed = {
    chainId: getChainId(),
    address,
    deployTxHash: receipt?.hash || null,
    name: 'CommerceAttester',
    abi: [
      'function attest(bytes32 hash)',
      'event Attested(bytes32 indexed hash, address indexed sender)',
    ],
    note: 'Live CommerceAttester on DDC chain. Backend calls attest(bytes32).',
  };
  fs.writeFileSync(ARTIFACT, JSON.stringify(deployed, null, 2));
  console.log('CommerceAttester', address, 'tx', deployed.deployTxHash);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
