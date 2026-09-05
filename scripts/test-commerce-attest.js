const assert = require('assert');
const {
  LICENCE_SCHEMA,
  buildLicenceReceipt,
  hashLicenceReceipt,
  soldRecordCount,
  publicAttestation,
  omitAttestationPayload,
} = require('../src/services/commerceAttest');

const receipt = buildLicenceReceipt({
  purchaseId: 'pur_demo_01',
  orderNumber: 'PO-20260905-ABCD',
  dataNFTId: 'nft_pack_01',
  sellerOrgId: 'org_seller_01',
  buyerOrgId: 'org_buyer_01',
  amount: 128,
  currency: 'USD',
  recordCount: 420,
  licencePolicyVersion: '2026-09-04',
  paidAt: '2026-09-05T05:20:00.000Z',
  packTitle: 'Travel receipts pack',
});

assert.strictEqual(receipt.schema, LICENCE_SCHEMA);
assert.strictEqual(receipt.version, 1);
assert.strictEqual(receipt.purpose, 'analysis-research');
assert.strictEqual(receipt.directMarketing, false);
assert.strictEqual(receipt.datasetBytesExcluded, true);
assert.strictEqual(receipt.buyerOrgId, 'org_buyer_01');
assert.ok(!JSON.stringify(receipt).includes('@'));
assert.ok(!('attestedAt' in receipt));
assert.ok(!('email' in receipt));

const again = buildLicenceReceipt({
  purchaseId: 'pur_demo_01',
  orderNumber: 'PO-20260905-ABCD',
  dataNFTId: 'nft_pack_01',
  sellerOrgId: 'org_seller_01',
  buyerOrgId: 'org_buyer_01',
  amount: 128,
  currency: 'USD',
  recordCount: 420,
  licencePolicyVersion: '2026-09-04',
  paidAt: '2026-09-05T05:20:00.000Z',
  packTitle: 'Travel receipts pack',
});
assert.strictEqual(hashLicenceReceipt(receipt), hashLicenceReceipt(again));
assert.strictEqual(hashLicenceReceipt(receipt).length, 64);

assert.strictEqual(soldRecordCount({ dataRecords: [{ a: 1 }, { a: 2 }] }), 2);
assert.strictEqual(soldRecordCount({ dataRecords: { records: [{ a: 1 }], recordCount: 99 } }), 1);
assert.strictEqual(soldRecordCount({ dataRecords: { recordCount: 15 } }), 15);

const publicView = publicAttestation({
  attestationHash: hashLicenceReceipt(receipt),
  attestationTxHash: null,
  attestedAt: new Date().toISOString(),
  attestationPayload: { email: 'hidden@example.com', schema: 'should-not-leak' },
});
assert.strictEqual(publicView.attestationStatus, 'recorded');
assert.strictEqual(publicView.attestationLabel, 'Recorded (hash)');
assert.strictEqual(publicView.chainId, 44508);
assert.strictEqual(publicView.attesterName, 'CommerceAttester');
assert.ok(!('attestationPayload' in publicView));
assert.ok(!JSON.stringify(publicView).includes('@'));
assert.ok(!('attestationPayload' in omitAttestationPayload({
  attestationHash: 'abc',
  attestationPayload: { email: 'hidden@example.com' },
})));
assert.strictEqual(publicAttestation({}).attestationLabel, 'On-chain pending');
assert.strictEqual(publicAttestation({ attestationTxHash: '0xabc' }).attestationLabel, 'On-chain');

console.log('commerce attest receipt OK');
console.log(JSON.stringify(receipt, null, 2));
console.log('sha256', hashLicenceReceipt(receipt));
