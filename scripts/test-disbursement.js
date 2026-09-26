const assert = require('assert');
const { ethers } = require('ethers');
const {
  ORIGIN_PARTNER_VOLUME,
  RECORD_DATA_UPLOAD,
  countsAsDataUpload,
  isPartnerVolume,
  assertSeparateFromDataUploads,
  RECEIPT_SCHEMA,
} = require('../src/services/disbursement/classify');
const { LICENCE_SCHEMA } = require('../src/services/commerceAttest');
const {
  validatePartnerItems,
  evaluateSend,
  samePayload,
  partnerKeyMatches,
  planWalletBind,
} = require('../src/services/disbursement/policy');
const { buildDisbursementReceipt, hashDisbursementReceipt } = require('../src/services/disbursement/receipt');
const { amountToUnits } = require('../src/services/disbursement/bscPayout');

const wallet = ethers.Wallet.createRandom().address;
const validated = validatePartnerItems([
  {
    payoutId: 'pay_1',
    email: 'Trainer@Example.com',
    externalUserRef: 'seesaw-user-1',
    walletAddress: wallet,
    amount: 50,
    reason: 'trainer_reward',
  },
]);
assert.strictEqual(validated.ok, true);
assert.strictEqual(validated.items[0].origin, ORIGIN_PARTNER_VOLUME);
assert.strictEqual(validated.items[0].recordClass, 'partner_volume');
assert.strictEqual(validated.items[0].countsAsDataUpload, false);
assert.strictEqual(validated.items[0].countsAsDataTrade, false);
assert.strictEqual(validated.items[0].email, 'trainer@example.com');
assert.strictEqual(isPartnerVolume(validated.items[0]), true);
assert.strictEqual(countsAsDataUpload(validated.items[0]), false);

assert.throws(
  () => assertSeparateFromDataUploads({
    origin: ORIGIN_PARTNER_VOLUME,
    recordClass: RECORD_DATA_UPLOAD,
    countsAsDataUpload: true,
    countsAsDataTrade: false,
  }),
  (error) => error.code === 'partner_volume_not_data_upload',
);

const overCap = validatePartnerItems([
  {
    payoutId: 'pay_big',
    email: 'a@example.com',
    walletAddress: wallet,
    amount: 2001,
  },
]);
assert.strictEqual(overCap.ok, false);
assert.strictEqual(overCap.code, 'per_item_limit');

const receipt = buildDisbursementReceipt({
  payoutId: 'pay_1',
  origin: ORIGIN_PARTNER_VOLUME,
  partnerSlug: 'seesaw',
  email: 'trainer@example.com',
  walletAddress: wallet,
  amount: 50,
  chainId: 56,
  tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
  bscTxHash: '0xabc',
  paidAt: '2026-09-26T00:00:00.000Z',
  reason: 'trainer_reward',
});
assert.strictEqual(receipt.schema, RECEIPT_SCHEMA);
assert.notStrictEqual(receipt.schema, LICENCE_SCHEMA);
assert.strictEqual(receipt.purpose, 'partner_volume');
assert.strictEqual(receipt.countsAsDataUpload, false);
assert.strictEqual(receipt.countsAsDataTrade, false);
assert.strictEqual(receipt.datasetBytesExcluded, true);
assert.ok(!JSON.stringify(receipt).includes('trainer@example.com'));
assert.strictEqual(hashDisbursementReceipt(receipt), hashDisbursementReceipt({ ...receipt }));

const internal = buildDisbursementReceipt({
  payoutId: 'redemption:1',
  origin: 'internal_reward',
  email: 'member@example.com',
  walletAddress: wallet,
  amount: 25,
  chainId: 56,
  tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
  bscTxHash: '0xdef',
  paidAt: '2026-09-26T00:00:00.000Z',
  reason: 'points_redemption',
});
assert.strictEqual(internal.purpose, 'internal_reward');
assert.strictEqual(internal.recordClass, 'internal_reward_settlement');
assert.strictEqual(internal.countsAsDataUpload, false);

assert.strictEqual(amountToUnits(50, 18), 50n * (10n ** 18n));
assert.strictEqual(amountToUnits('1.5', 18), 15n * (10n ** 17n));

const paused = evaluateSend({ amount: 10, walletAddress: wallet, monthToDate: 20000 });
assert.strictEqual(paused.ok, false);
assert.strictEqual(paused.code, 'monthly_limit');

assert.strictEqual(samePayload(
  { emailNormalized: 'a@example.com', walletAddress: wallet, amount: 50, reason: 'trainer_reward', externalUserRef: 'u1' },
  { email: 'a@example.com', walletAddress: wallet, amount: 50, reason: 'trainer_reward', externalUserRef: 'u1' },
), true);

process.env.SEESAW_DISBURSEMENT_API_KEY = 'test-partner-key';
assert.strictEqual(planWalletBind({ existingWallet: '', walletOwnerId: null, userId: null }).setWallet, true);
assert.strictEqual(planWalletBind({ existingWallet: wallet, walletOwnerId: 'user-1', userId: 'user-1' }).setWallet, false);
assert.strictEqual(planWalletBind({ existingWallet: '', walletOwnerId: 'other', userId: null }).setWallet, false);

assert.strictEqual(partnerKeyMatches('seesaw', 'test-partner-key'), true);
assert.strictEqual(partnerKeyMatches('seesaw', 'other'), false);

console.log('disbursement tests passed');
