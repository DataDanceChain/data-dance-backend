/**
 * Gift redemption point costs (V2) — keep in sync with app rewardRedemptionCatalog.ts
 */
const REWARD_REDEMPTION_CATALOG = [
  { type: 'USDT', faceValue: 5, pointsRequired: 750 },
  { type: 'USDT', faceValue: 25, pointsRequired: 3600 },
  { type: 'USDT', faceValue: 50, pointsRequired: 7150 },
  { type: 'Amazon eGift Card', faceValue: 5, pointsRequired: 750 },
  { type: 'Amazon eGift Card', faceValue: 25, pointsRequired: 3600 },
  { type: 'Amazon eGift Card', faceValue: 50, pointsRequired: 7150 },
  { type: 'Apple eGift Card', faceValue: 15, pointsRequired: 2200 },
  { type: 'Apple eGift Card', faceValue: 25, pointsRequired: 3600 },
  { type: 'Apple eGift Card', faceValue: 50, pointsRequired: 7150 },
  { type: 'Starbucks eGift Card', faceValue: 15, pointsRequired: 2200 },
  { type: 'Starbucks eGift Card', faceValue: 25, pointsRequired: 3600 },
  { type: 'Starbucks eGift Card', faceValue: 50, pointsRequired: 7150 },
  { type: 'Netflix eGift Card', faceValue: 15, pointsRequired: 2200 },
  { type: 'Netflix eGift Card', faceValue: 25, pointsRequired: 3600 },
  { type: 'Netflix eGift Card', faceValue: 50, pointsRequired: 7150 },
  { type: 'X Premium (Annual)', faceValue: 84, pointsRequired: 12000 },
];

/** Legacy V1 labels still seen in old Google Form submissions */
const LEGACY_REWARD_POINTS = [
  { pattern: /\$10\s*Apple|Apple Gift Code.*1500|1500.*Apple/i, points: 1500 },
  { pattern: /\$10\s*Amazon|1500.*Amazon/i, points: 1500 },
  { pattern: /\$10\s*Starbucks|1500.*Starbucks/i, points: 1500 },
  { pattern: /\$10\s*Mastercard|Mastercard.*2000|2000.*Mastercard/i, points: 2000 },
  { pattern: /Netflix Gift Card.*2200|\$15.*Netflix/i, points: 2200 },
  { pattern: /Apple Gift Code|\$25\s*Apple|\$25 Apple/i, points: 3600 },
  { pattern: /\$25\s*Amazon|\$25 Apple|\$25.*3600|3600/i, points: 3600 },
  { pattern: /\$5\s*Amazon|\$5.*750|750/i, points: 750 },
  { pattern: /X Premium|12000/i, points: 12000 },
  { pattern: /USDT.*7150|\$50.*7150|7150/i, points: 7150 },
  { pattern: /USDT|\$50/i, points: 7150 },
  { pattern: /\$15|2200/i, points: 2200 },
];

function parsePointsFromRewardText(rewardText) {
  const t = rewardText || '';
  const knownPoints = [12000, 7150, 3600, 2200, 2000, 1500, 750];
  for (const points of knownPoints) {
    if (t.includes(String(points))) return points;
  }
  for (const { type, faceValue, pointsRequired } of REWARD_REDEMPTION_CATALOG) {
    if (t.includes(type) && t.includes(String(faceValue))) {
      return pointsRequired;
    }
  }
  for (const { pattern, points } of LEGACY_REWARD_POINTS) {
    if (pattern.test(t)) return points;
  }
  return null;
}

module.exports = {
  REWARD_REDEMPTION_CATALOG,
  LEGACY_REWARD_POINTS,
  parsePointsFromRewardText,
};
