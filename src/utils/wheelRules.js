const { randomInt } = require('crypto');

const WHEEL_KINDS = new Set(['POINTS', 'GIFT_CARD', 'USDT']);

/** The first draw at or after this number awards a gift card or USDT when the person has none yet. */
const PITY_SPIN = 7;

/** Documented Thanksgiving × Black Friday pool. Weights are hundredths of a percent and sum to 10000. */
const THANKSGIVING_PRIZES = [
  { id: 'amazon-50', kind: 'GIFT_CARD', quantity: 1, weight: 30, points: 0, labelEn: '$50 Amazon Gift Card', labelZh: '$50 亚马逊礼品卡', labelZhTw: '$50 亞馬遜禮品卡', labelJa: 'Amazonギフトカード $50', labelKo: '아마존 기프트 카드 $50' },
  { id: 'apple-50', kind: 'GIFT_CARD', quantity: 1, weight: 30, points: 0, labelEn: '$50 Apple Gift Card', labelZh: '$50 Apple 礼品卡', labelZhTw: '$50 Apple 禮品卡', labelJa: 'Appleギフトカード $50', labelKo: 'Apple 기프트 카드 $50' },
  { id: 'usdt-50', kind: 'USDT', quantity: 1, weight: 30, points: 0, labelEn: '$50 USDT', labelZh: '$50 USDT', labelZhTw: '$50 USDT', labelJa: '$50 USDT', labelKo: '$50 USDT' },
  { id: 'apple-15', kind: 'GIFT_CARD', quantity: 10, weight: 280, points: 0, labelEn: '$15 Apple Gift Card', labelZh: '$15 Apple 礼品卡', labelZhTw: '$15 Apple 禮品卡', labelJa: 'Appleギフトカード $15', labelKo: 'Apple 기프트 카드 $15' },
  { id: 'amazon-5', kind: 'GIFT_CARD', quantity: 20, weight: 565, points: 0, labelEn: '$5 Amazon Gift Card', labelZh: '$5 亚马逊礼品卡', labelZhTw: '$5 亞馬遜禮品卡', labelJa: 'Amazonギフトカード $5', labelKo: '아마존 기프트 카드 $5' },
  { id: 'usdt-5', kind: 'USDT', quantity: 20, weight: 565, points: 0, labelEn: '$5 USDT', labelZh: '$5 USDT', labelZhTw: '$5 USDT', labelJa: '$5 USDT', labelKo: '$5 USDT' },
  { id: 'points-5', kind: 'POINTS', quantity: null, weight: 8500, points: 5, labelEn: '5 Points', labelZh: '5 积分', labelZhTw: '5 積分', labelJa: '5 ポイント', labelKo: '5 포인트' },
];

const PRIZE_FACE_VALUE = {
  'amazon-50': 50,
  'apple-50': 50,
  'usdt-50': 50,
  'apple-15': 15,
  'amazon-5': 5,
  'usdt-5': 5,
};

/** Every accepted source except the shop list, generic shop rows, and Discord. */
function otherRecordSites(acceptedSources, shopSites) {
  const shop = new Set(Array.isArray(shopSites) ? shopSites : []);
  shop.add('generic');
  shop.add('discord');
  return [...new Set(acceptedSources)].filter((site) => site && !shop.has(site));
}

function drawsFromCounts({ shopCount = 0, socialCount = 0, portrait = false, shopPer = 5, socialPer = 10, socialMaxDraws = 5 }) {
  const shopDraws = Math.floor(Math.max(0, shopCount) / shopPer);
  const socialDraws = Math.min(socialMaxDraws, Math.floor(Math.max(0, socialCount) / socialPer));
  const portraitDraws = portrait ? 1 : 0;
  return {
    shopDraws,
    socialDraws,
    portraitDraws,
    earned: shopDraws + socialDraws + portraitDraws,
  };
}

/**
 * Prizes still on the wheel. A person who already won a gift card or USDT only sees points.
 * A finite prize leaves once its awarded count reaches quantity. Weights are not renormalized
 * here; the picker sums whatever remains.
 */
function availablePrizes(prizes, awardedById, blocked) {
  return (Array.isArray(prizes) ? prizes : []).filter((prize) => {
    if (!prize || prize.weight <= 0) return false;
    if (prize.kind !== 'POINTS' && blocked) return false;
    if (prize.quantity == null) return true;
    return (awardedById.get(prize.id) || 0) < prize.quantity;
  });
}

/**
 * One pity draw. From the 7th spin onward, a person with no gift card or USDT yet
 * draws only from those prizes. Someone who already won one stays on points.
 * If every finite prize is gone, the draw falls back to whatever is still open.
 */
function prizesForSpin(prizes, awardedById, blocked, spinNumber) {
  const open = availablePrizes(prizes, awardedById, blocked);
  if (blocked || spinNumber < PITY_SPIN) return open;
  const gifts = open.filter((prize) => prize.kind !== 'POINTS');
  return gifts.length ? gifts : open;
}

/** `roll` is an integer in [0, total). Omit it to draw from the process randomness. */
function pickWeighted(prizes, roll) {
  const total = prizes.reduce((sum, prize) => sum + prize.weight, 0);
  if (total <= 0) return null;
  let cursor = roll == null ? randomInt(total) : Math.min(total - 1, Math.max(0, Math.floor(roll)));
  for (const prize of prizes) {
    cursor -= prize.weight;
    if (cursor < 0) return prize;
  }
  return prizes[prizes.length - 1] || null;
}

module.exports = {
  WHEEL_KINDS,
  THANKSGIVING_PRIZES,
  PRIZE_FACE_VALUE,
  drawsFromCounts,
  otherRecordSites,
  availablePrizes,
  prizesForSpin,
  pickWeighted,
  PITY_SPIN,
};
