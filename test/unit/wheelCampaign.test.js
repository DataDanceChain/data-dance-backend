const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDraft, toPublicCard } = require('../../src/utils/campaignRules');
const {
  THANKSGIVING_PRIZES,
  PRIZE_FACE_VALUE,
  availablePrizes,
  drawsFromCounts,
  otherRecordSites,
  pickWeighted,
  prizesForSpin,
} = require('../../src/utils/wheelRules');
const { invitePostOnDay } = require('../../src/utils/xInvite');
const { ACCEPTED_SOURCES, SHOP_SOURCES } = require('../../src/constants/crawlerSources');

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
  assert.equal(THANKSGIVING_PRIZES.find((prize) => prize.id === 'points-5').weight, 8500);
  assert.equal(THANKSGIVING_PRIZES.find((prize) => prize.id === 'usdt-50').weight, 30);
  assert.equal(THANKSGIVING_PRIZES.find((prize) => prize.id === 'amazon-5').weight, 565);
});

test('draws come from shop orders, capped non-shopping records, and one portrait', () => {
  assert.deepEqual(drawsFromCounts({ shopCount: 4, socialCount: 9, portrait: false }), {
    shopDraws: 0,
    socialDraws: 0,
    portraitDraws: 0,
    shareDraws: 0,
    earned: 0,
  });
  assert.equal(drawsFromCounts({ shopCount: 12, socialCount: 50, portrait: true }).earned, 2 + 5 + 1);
  assert.equal(drawsFromCounts({ shareDays: 1 }).shareDraws, 1);
  assert.equal(drawsFromCounts({ shareDays: 9 }).shareDraws, 5);
  assert.equal(drawsFromCounts({ shopCount: 12, socialCount: 50, portrait: true, shareDays: 3 }).earned, 2 + 5 + 1 + 3);
  assert.equal(drawsFromCounts({ shopCount: 0, socialCount: 1000, portrait: false }).socialDraws, 5);
  const shopSites = [...SHOP_SOURCES.filter((site) => site !== 'generic'), 'amazon'];
  const others = otherRecordSites(ACCEPTED_SOURCES, shopSites);
  assert.equal(others.includes('x'), true);
  assert.equal(others.includes('airbnb'), true);
  assert.equal(others.includes('uber'), true);
  assert.equal(others.includes('expedia'), true);
  assert.equal(others.includes('luma'), true);
  assert.equal(others.includes('amazon'), false);
  assert.equal(others.includes('shein'), false);
  assert.equal(others.includes('discord'), false);
  assert.equal(others.includes('generic'), false);
});

test('an invite counts only when the bound account posted the wheel link today', () => {
  const now = new Date('2026-11-26T15:00:00.000Z');
  const today = {
    created_at: '2026-11-26T12:00:00.000Z',
    text: 'Come join me https://t.co/abc',
    entities: { urls: [{ expanded_url: 'https://app.datadance.ai/user/wheel' }] },
  };
  assert.equal(invitePostOnDay(today, now), true);
  assert.equal(invitePostOnDay({ ...today, created_at: '2026-11-25T12:00:00.000Z' }, now), false);
  assert.equal(invitePostOnDay({ created_at: today.created_at, text: 'hello' }, now), false);
  assert.equal(invitePostOnDay({
    created_at: today.created_at,
    text: 'https://app.datadance.ai/user/wheel',
  }, now), true);
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

test('the 12th draw awards a gift card or USDT when the person has not won one', () => {
  const early = prizesForSpin(THANKSGIVING_PRIZES, new Map(), false, 11);
  assert.equal(early.some((prize) => prize.kind === 'POINTS'), true);
  const pity = prizesForSpin(THANKSGIVING_PRIZES, new Map(), false, 12);
  assert.equal(pity.every((prize) => prize.kind !== 'POINTS'), true);
  assert.equal(pity.length, 6);
  const later = prizesForSpin(THANKSGIVING_PRIZES, new Map(), false, 13);
  assert.equal(later.every((prize) => prize.kind !== 'POINTS'), true);
  const already = prizesForSpin(THANKSGIVING_PRIZES, new Map(), true, 12);
  assert.deepEqual(already.map((prize) => prize.kind), ['POINTS']);
  const soldOut = prizesForSpin(THANKSGIVING_PRIZES, new Map([
    ['amazon-50', 1],
    ['apple-50', 1],
    ['usdt-50', 1],
    ['apple-15', 10],
    ['amazon-5', 20],
    ['usdt-5', 20],
  ]), false, 12);
  assert.deepEqual(soldOut.map((prize) => prize.kind), ['POINTS']);
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
