/**
 * 30 September 2026 gift-card purchases.
 * Eight Amazon orders, 137 cards, $2,000. Each $5 of face value is one
 * contributor redeeming 500 points. A $15 card is three such redemptions,
 * a $25 card is five, and a $50 card is ten.
 */

const GIFT_CARD_BATCH = 'gift-card-batch-20260930';

const GIFT_CARD_PURCHASES = [
  {
    reference: '112-0809542-3584210',
    lines: [
      { brand: 'apple', face: 15, qty: 6 },
      { brand: 'amazon', face: 5, qty: 1 },
    ],
  },
  {
    reference: '112-6528194-3467423',
    lines: [
      { brand: 'amazon', face: 5, qty: 5 },
      { brand: 'amazon', face: 25, qty: 5 },
      { brand: 'amazon', face: 50, qty: 1 },
    ],
  },
  {
    reference: '112-0556493-2380248',
    lines: [{ brand: 'apple', face: 25, qty: 5 }],
  },
  {
    reference: '112-7629990-9669863',
    lines: [{ brand: 'amazon', face: 50, qty: 8 }],
  },
  {
    reference: '112-0156683-9802638',
    lines: [{ brand: 'apple', face: 50, qty: 5 }],
  },
  {
    reference: '112-7082878-6063459',
    lines: [
      { brand: 'amazon', face: 5, qty: 40 },
      { brand: 'amazon', face: 25, qty: 9 },
      { brand: 'amazon', face: 50, qty: 1 },
    ],
  },
  {
    reference: '112-6817699-4983407',
    lines: [{ brand: 'amazon', face: 5, qty: 1 }],
  },
  {
    reference: '112-7085393-2757848',
    lines: [
      { brand: 'amazon', face: 5, qty: 40 },
      { brand: 'amazon', face: 25, qty: 10 },
    ],
  },
];

function purchaseTotal(purchase) {
  return purchase.lines.reduce((sum, line) => sum + line.face * line.qty, 0);
}

function giftCardSlots() {
  const slots = [];
  for (const purchase of GIFT_CARD_PURCHASES) {
    for (const line of purchase.lines) {
      if (line.face % 5 !== 0) throw new Error(`face $${line.face} is not a multiple of $5`);
      for (let index = 1; index <= line.qty; index += 1) {
        const shares = line.face / 5;
        for (let share = 1; share <= shares; share += 1) {
          slots.push({
            reference: purchase.reference,
            brand: line.brand,
            face: line.face,
            index,
            qty: line.qty,
            share,
            shares,
          });
        }
      }
    }
  }
  return slots;
}

function assertGiftCardBatch() {
  const slots = giftCardSlots();
  const total = GIFT_CARD_PURCHASES.reduce((sum, purchase) => sum + purchaseTotal(purchase), 0);
  if (slots.length !== 400) throw new Error(`expected 400 point redemptions, got ${slots.length}`);
  if (total !== 2000) throw new Error(`expected $2000 of gift cards, got ${total}`);
  const cards = GIFT_CARD_PURCHASES.reduce(
    (sum, purchase) => sum + purchase.lines.reduce((inner, line) => inner + line.qty, 0),
    0,
  );
  if (cards !== 137) throw new Error(`expected 137 cards, got ${cards}`);
  return { slots, total, cards };
}

module.exports = {
  GIFT_CARD_BATCH,
  GIFT_CARD_PURCHASES,
  purchaseTotal,
  giftCardSlots,
  assertGiftCardBatch,
};
