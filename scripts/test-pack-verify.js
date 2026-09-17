const assert = require('assert');
const {
  emailsFromRecords,
  buildMembershipIndex,
  matchMembership,
  maskEmailOne,
} = require('../src/utils/packRecords');
const { verifyPackMembership } = require('../src/services/packVerify');

const dataRecords = {
  emailField: 'buyer-email',
  recordCount: 3,
  records: [
    { recordId: 1, email: 'Jane.Doe@Shop.example', 'buyer-email': 'Jane.Doe@Shop.example', 'order-id': 'A-100' },
    { recordId: 2, 'buyer-email': 'sam@other.io', 'order-id': 'B-200' },
    { recordId: 3, email: 'skip-me', 'order-id': 'C-300' },
  ],
};

const emails = emailsFromRecords(dataRecords);
assert.deepStrictEqual(emails, ['jane.doe@shop.example', 'sam@other.io']);

const index = buildMembershipIndex(dataRecords);
assert.strictEqual(matchMembership(index, { email: 'JANE.DOE@shop.example' }), true);
assert.strictEqual(matchMembership(index, { email: 'nobody@shop.example' }), false);
assert.strictEqual(matchMembership(index, { email: 'jane.doe@shop.example', recordId: 'A-100' }), true);
assert.strictEqual(matchMembership(index, { email: 'jane.doe@shop.example', recordId: 'B-200' }), false);
assert.strictEqual(matchMembership(index, { recordId: 'B-200' }), true);
assert.strictEqual(maskEmailOne('jane.doe@shop.example'), 'j***@shop.example');

const pack = { id: 'pack-1', updatedAt: new Date(), dataRecords };
assert.deepStrictEqual(
  verifyPackMembership(pack, { email: 'Jane.Doe@Shop.example' }),
  { inPack: true, emailMasked: 'j***@shop.example' },
);
assert.deepStrictEqual(verifyPackMembership(pack, { email: 'absent@shop.example' }), { inPack: false });
assert.deepStrictEqual(verifyPackMembership(pack, { recordId: 'A-100' }), { inPack: true });

let threw = false;
try {
  verifyPackMembership(pack, {});
} catch (error) {
  threw = true;
  assert.strictEqual(error.status, 400);
}
assert.ok(threw);

const miss = verifyPackMembership(pack, { email: 'absent@shop.example' });
assert.ok(!('emailMasked' in miss));
assert.ok(!JSON.stringify(miss).includes('@'));
assert.ok(!JSON.stringify(verifyPackMembership(pack, { email: 'Jane.Doe@Shop.example' })).includes('jane.doe'));

console.log('pack verify membership OK');
