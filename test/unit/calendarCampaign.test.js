const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDraft, toPublicCard } = require('../../src/utils/campaignRules');
const { CHRISTMAS_DAYS, CALENDAR_SITES, cellState, dayNumber } = require('../../src/utils/calendarRules');
const { SOCIAL_SOURCES } = require('../../src/constants/crawlerSources');

function calendarBody(overrides = {}) {
  return {
    slug: 'christmas-2026',
    titleEn: 'Christmas Advent Calendar',
    titleZh: '圣诞倒数日历',
    blurbEn: 'Upload. Unlock. Unwrap.',
    template: 'CALENDAR',
    startsAt: '2026-12-01T00:00:00.000Z',
    endsAt: '2026-12-26T23:59:59.000Z',
    playEndsAt: '2026-12-25T23:59:59.000Z',
    purpose: 'December advent calendar.',
    legalText: 'One shop, travel, or life upload unlocks that UTC day. Points are added when the gift is unwrapped.',
    ...overrides,
  };
}

test('christmas days total 410 points and keep the documented gifts', () => {
  assert.equal(CHRISTMAS_DAYS.length, 25);
  const points = CHRISTMAS_DAYS.reduce((sum, day) => sum + day.points, 0);
  assert.equal(points, 410);
  assert.equal(CHRISTMAS_DAYS.find((day) => day.day === 3).kind, 'DIGITAL');
  assert.equal(CHRISTMAS_DAYS.find((day) => day.day === 10).points, 50);
  assert.equal(CHRISTMAS_DAYS.find((day) => day.day === 23).points, 150);
  assert.equal(CHRISTMAS_DAYS.find((day) => day.day === 25).kind, 'GIFT_CARD');
  assert.equal(CALENDAR_SITES.includes('amazon'), true);
  assert.equal(CALENDAR_SITES.includes('airbnb'), true);
  assert.equal(CALENDAR_SITES.includes('luma'), true);
  assert.equal(CALENDAR_SITES.some((site) => SOCIAL_SOURCES.includes(site)), false);
  assert.equal(CALENDAR_SITES.includes('generic'), false);
});

test('a calendar draft keeps the 25 days and hides them from the home card', () => {
  const parsed = parseDraft(calendarBody());
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.ctaValue, '/user/calendar');
  assert.equal(parsed.data.config.days.length, 25);
  assert.equal(parsed.data.config.days.reduce((sum, day) => sum + day.points, 0), 410);
  const card = toPublicCard({ ...parsed.data, id: 'row', status: 'SCHEDULED' });
  assert.equal(card.config.playEndsAt, '2026-12-25T23:59:59.000Z');
  assert.equal(card.config.days, undefined);
});

test('day numbers and cell states follow the UTC calendar', () => {
  const start = '2026-12-01T00:00:00.000Z';
  assert.equal(dayNumber(new Date('2026-12-01T23:59:00.000Z'), start), 1);
  assert.equal(dayNumber(new Date('2026-12-25T12:00:00.000Z'), start), 25);
  assert.equal(dayNumber(new Date('2026-12-26T00:00:00.000Z'), start), 26);
  assert.equal(cellState({ day: 3, unlocked: true, opened: false, today: 5, accepting: true }), 'unwrap');
  assert.equal(cellState({ day: 2, unlocked: false, opened: false, today: 5, accepting: true }), 'missed');
  assert.equal(cellState({ day: 5, unlocked: false, opened: false, today: 5, accepting: true }), 'upload');
  assert.equal(cellState({ day: 6, unlocked: false, opened: false, today: 5, accepting: true }), 'future');
  assert.equal(cellState({ day: 4, unlocked: true, opened: true, today: 5, accepting: true }), 'revealed');
  assert.equal(cellState({ day: 9, unlocked: true, opened: false, today: 26, accepting: true }), 'unwrap');
  assert.equal(cellState({ day: 9, unlocked: true, opened: false, today: 26, accepting: false }), 'missed');
});
