const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

const deployed = require('../contracts/commerceAttester.deployed.json');

// Values from the deploy receipt of deployed.deployTxHash on DDC chain 44508.
// The chain reports contractAddress 0xe944…2a93. The standard CREATE formula
// (sender + nonce) gives 0xE0fF…2FeC, which has no code on this chain, so the
// address must come from the receipt, never from getCreateAddress().
const RECEIPT_CONTRACT_ADDRESS = '0xe944f723af28659622425F62a49F48844C152a93';
const DEPLOYER = '0xf20a757d8fae4a0274f592f4606b070214dd0563';
const DEPLOY_NONCE = 432;

test('deployed.json points at the contract address from the deploy receipt', () => {
  assert.strictEqual(deployed.chainId, 44508);
  assert.strictEqual(ethers.getAddress(deployed.address), RECEIPT_CONTRACT_ADDRESS);
  assert.notStrictEqual(
    ethers.getCreateAddress({ from: DEPLOYER, nonce: DEPLOY_NONCE }),
    RECEIPT_CONTRACT_ADDRESS,
  );
});

test('getAttesterAddress falls back to the receipt address without an env override', () => {
  const saved = process.env.COMMERCE_ATTESTER;
  delete process.env.COMMERCE_ATTESTER;
  try {
    const { getAttesterAddress } = require('./commerceAttestChain');
    assert.strictEqual(ethers.getAddress(getAttesterAddress()), RECEIPT_CONTRACT_ADDRESS);
  } finally {
    if (saved !== undefined) process.env.COMMERCE_ATTESTER = saved;
  }
});
