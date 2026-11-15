const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../config/business-rules.json');
const { reviewedSocialLedger } = require('../../src/services/reviewedSocialLedger');

test('social uploads pay 1 point and share a cap of 10, orders stay at 10', () => {
  assert.equal(rules.dataCollection.social.pointsPerItem, 1);
  assert.equal(rules.dataCollection.social.dailyLimit, 10);
  assert.equal(rules.dataCollection.amazon.pointsPerItem, 10);
  assert.equal(rules.dataCollection.shop.pointsPerItem, 10);
  assert.equal(rules.dataCollection.travel.pointsPerItem, 10);
});

test('a balance that still holds farmed points keeps task points and adds 750', () => {
  const plan = reviewedSocialLedger({
    totalPoints: 48750,
    ledgerSum: 48750,
    crawlerPoints: 48730,
    crawlerRows: 4873,
    badSocialRows: 4873,
  });
  assert.deepEqual(plan, {
    ok: true,
    badPoints: 48730,
    target: 20,
    deduction: 48730,
    goodwill: 750,
    nextTotal: 770,
  });
});

test('redeemed points are not pulled back below zero, and goodwill is still paid when points are removed', () => {
  const plan = reviewedSocialLedger({
    totalPoints: 7950,
    ledgerSum: 7950,
    crawlerPoints: 22250,
    crawlerRows: 2225,
    badSocialRows: 2225,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 0);
  assert.equal(plan.deduction, 7950);
  assert.equal(plan.nextTotal, 750);
});

test('kept rows and task points stay when the redemption does not already cover them', () => {
  const plan = reviewedSocialLedger({
    totalPoints: 29890,
    ledgerSum: 29890,
    crawlerPoints: 29820,
    crawlerRows: 2982,
    badSocialRows: 2967,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 220);
  assert.equal(plan.deduction, 29670);
  assert.equal(plan.nextTotal, 970);
});

test('a ledger that was not paid at 10 points per row is refused', () => {
  const plan = reviewedSocialLedger({
    totalPoints: 100,
    ledgerSum: 100,
    crawlerPoints: 50,
    crawlerRows: 10,
    badSocialRows: 10,
  });
  assert.equal(plan.ok, false);
});
