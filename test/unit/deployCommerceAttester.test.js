/**
 * scripts/deployCommerceAttester.js records receipt.contractAddress, never the CREATE-formula
 * address (contract.getAddress()), and refuses to write the JSON unless that address has code.
 * Fake provider; no network.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { deployedAddressFromReceipt } = require('../../scripts/deployCommerceAttester');
const { randomAddress, randomHash } = require('../helpers/fakeAttestChain');

function provider(codeByAddress) {
  return { getCode: async (a) => codeByAddress[String(a).toLowerCase()] || '0x' };
}

describe('deployedAddressFromReceipt', () => {
  it('returns the checksummed receipt address when it has code', async () => {
    const address = randomAddress();
    const got = await deployedAddressFromReceipt(
      provider({ [address.toLowerCase()]: '0x6080' }),
      { status: 1, hash: randomHash(), contractAddress: address.toLowerCase() },
    );
    assert.equal(got, address);
  });

  it('refuses when the receipt address has no code', async () => {
    await assert.rejects(
      deployedAddressFromReceipt(provider({}), { status: 1, contractAddress: randomAddress() }),
      /No contract code/,
    );
  });

  it('refuses a failed deploy, a missing receipt and a receipt without contractAddress', async () => {
    const address = randomAddress();
    const p = provider({ [address.toLowerCase()]: '0x6080' });
    await assert.rejects(deployedAddressFromReceipt(p, { status: 0, contractAddress: address }), /failed/);
    await assert.rejects(deployedAddressFromReceipt(p, null), /no receipt/);
    await assert.rejects(deployedAddressFromReceipt(p, { status: 1, contractAddress: null }), /no contractAddress/);
  });

  it('main() takes the address from the receipt, not contract.getAddress()', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../scripts/deployCommerceAttester.js'), 'utf8');
    assert.doesNotMatch(source, /contract\.getAddress\(\)\s*;/);
    assert.match(source, /deployedAddressFromReceipt\(provider, receipt\)/);
    // The JSON is written only after the verified address is known.
    assert.ok(source.indexOf('deployedAddressFromReceipt(provider, receipt)') < source.indexOf('fs.writeFileSync(ARTIFACT'));
  });
});
