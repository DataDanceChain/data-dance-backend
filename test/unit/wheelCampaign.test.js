const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDraft, toPublicCard } = require('../../src/utils/campaignRules');
const {
  THANKSGIVING_PRIZES,
  PRIZE_FACE_VALUE,
  availablePrizes,
  drawsFromCounts,
  pickWeighted,
} = require('../../src/utils/wheelRules');

function wheelBody(overrides = {}) {
  return {
    slug: 'thanksgiving-2026',
    titleEn: 'Thanksgiving × Black Friday',
    blurbEn: '$500 prize pool and unlimited 2× points.',
    template: 'WHEEL',
    startsAt: '2026-11-26T00:00:00.000Z',
    endsAt: '2026-12-01T23:59:59.000Z',
    playEndsAt: '2026-11-30T23:59:59.000Z',
    shopPer: 5,
    socialPer: 10,
    socialMaxDraws: 5,
    shopSites: ['amazon', 'stockx'],
    socialSites: ['x', 'instagram'],
    prizes: THANKSGIVING_PRIZES,
    purpose: 'Thanksgiving and Black Friday wheel for the published window.',
    legalText: 'Points credit on spin. Gift cards and USDT must be claimed by December 1 or they are forfeited.',
    ...overrides,
  };
}

test('thanksgiving prize weights sum to 100% and the finite prizes are $500', () => {
  const weight = THANKSGIVING_PRIZES.reduce((sum, prize) => sum + prize.weight, 0);
  assert.equal(weight, 10000);
  const face = THANKSGIVING_PRIZES.reduce((sum, prize) => {
    if (prize.quantity == null) return sum;
    return sum + PRIZE_FACE_VALUE[prize.id] * prize.quantity;
  }, 0);
  assert.equal(face, 500);
  assert.equal(THANKSGIVING_PRIZES.filter((prize) => prize.kind === 'POINTS').length, 1);
});

test('draws come from shop orders, capped social posts, and one portrait', () => {
  assert.deepEqual(drawsFromCounts({ shopCount: 4, socialCount: 9, portrait: false }), {
    shopDraws: 0,
    socialDraws: 0,
    portraitDraws: 0,
    earned: 0,
  });
  assert.equal(drawsFromCounts({ shopCount: 12, socialCount: 50, portrait: true }).earned, 2 + 5 + 1);
  assert.equal(drawsFromCounts({ shopCount: 0, socialCount: 1000, portrait: false }).socialDraws, 5);
});

test('a gift or USDT already won, or an empty stock line, leaves only points', () => {
  const awarded = new Map([['amazon-5', 20], ['usdt-50', 1]]);
  const open = availablePrizes(THANKSGIVING_PRIZES, awarded, false).map((prize) => prize.id);
  assert.equal(open.includes('amazon-5'), false);
  assert.equal(open.includes('usdt-50'), false);
  assert.equal(open.includes('amazon-50'), true);
  const blocked = availablePrizes(THANKSGIVING_PRIZES, new Map(), true);
  assert.deepEqual(blocked.map((prize) => prize.kind), ['POINTS']);
});

test('the picker stays inside the prizes that are still available', () => {
  const points = THANKSGIVING_PRIZES.find((prize) => prize.kind === 'POINTS');
  const card = THANKSGIVING_PRIZES.find((prize) => prize.id === 'amazon-50');
  assert.equal(pickWeighted([card, points], 0).id, 'amazon-50');
  assert.equal(pickWeighted([card, points], card.weight).id, 'points-5');
  assert.equal(pickWeighted([points], 0).id, 'points-5');
});

test('a wheel campaign keeps its play window and does not publish prize weights', () => {
  const parsed = parseDraft(wheelBody());
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.ctaValue, '/user/wheel');
  assert.equal(parsed.data.config.playEndsAt, '2026-11-30T23:59:59.000Z');
  assert.equal(parsed.data.endsAt.toISOString(), '2026-12-01T23:59:59.000Z');
  const card = toPublicCard({ ...parsed.data, id: 'wheel-1', status: 'SCHEDULED' });
  assert.equal(card.config.prizes.some((prize) => prize.weight != null), false);
  assert.equal(card.config.prizes.length, THANKSGIVING_PRIZES.length);
  const late = parseDraft(wheelBody({ playEndsAt: '2026-12-02T00:00:00.000Z' }));
  assert.match(late.error, /claim deadline/);
});
