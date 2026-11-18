const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../../src/utils/prisma');
const { recordShare } = require('../../src/services/wheelService');

const now = new Date('2026-11-26T15:00:00.000Z');
const today = new Date('2026-11-26T00:00:00.000Z');
const campaign = {
  id: 'wheel-1',
  slug: 'thanksgiving-2026',
  template: 'WHEEL',
  status: 'LIVE',
  startsAt: new Date('2026-11-26T00:00:00.000Z'),
  endsAt: new Date('2026-12-01T23:59:59.000Z'),
  titleEn: 'Thanksgiving × Black Friday',
  titleZh: '感恩节',
  blurbEn: 'A five hundred dollar prize pool for the published window.',
  blurbZh: '活动说明',
  legalText: 'Points credit on spin. Gift cards and USDT must be claimed by December 1 or they are forfeited.',
  ctaKind: 'ROUTE',
  ctaValue: '/user/wheel',
  config: {
    playEndsAt: '2026-11-30T23:59:59.000Z',
    shopPer: 5,
    socialPer: 10,
    socialMaxDraws: 5,
    prizes: [{ id: 'points-5', kind: 'POINTS', quantity: null, weight: 100, points: 5, labelEn: '5 Points', labelZh: '5 积分' }],
  },
};

const saved = {};
const state = { events: [], upserts: 0 };

function install() {
  if (!prisma.campaignSpin) prisma.campaignSpin = {};
  saved.campaignFindMany = prisma.campaign.findMany;
  saved.count = prisma.crawlerData.count;
  saved.settings = prisma.lifeContextSettings.findUnique;
  saved.events = prisma.userDailyEvent.findMany;
  saved.upsert = prisma.userDailyEvent.upsert;
  saved.spins = prisma.campaignSpin.count;
  saved.group = prisma.campaignSpin.groupBy;
  saved.spinRows = prisma.campaignSpin.findMany;
  prisma.campaign.findMany = async () => [campaign];
  prisma.crawlerData.count = async () => 0;
  prisma.lifeContextSettings.findUnique = async () => null;
  prisma.userDailyEvent.findMany = async () => state.events.map((day) => ({ day }));
  prisma.userDailyEvent.upsert = async ({ create }) => {
    state.upserts += 1;
    state.events.push(create.day);
    return create;
  };
  prisma.campaignSpin.count = async () => 0;
  prisma.campaignSpin.groupBy = async () => [];
  prisma.campaignSpin.findMany = async () => [];
}

function restore() {
  prisma.campaign.findMany = saved.campaignFindMany;
  prisma.crawlerData.count = saved.count;
  prisma.lifeContextSettings.findUnique = saved.settings;
  prisma.userDailyEvent.findMany = saved.events;
  prisma.userDailyEvent.upsert = saved.upsert;
  prisma.campaignSpin.count = saved.spins;
  prisma.campaignSpin.groupBy = saved.group;
  prisma.campaignSpin.findMany = saved.spinRows;
}

test.before(install);
test.after(restore);
test.beforeEach(() => {
  state.events = [];
  state.upserts = 0;
});

test('opening the invite earns one draw without checking X, and a second tap the same day does not earn another', async () => {
  const first = await recordShare('user-1', now);
  assert.equal(first.progress.shareDraws, 1);
  assert.equal(first.progress.sharedToday, true);
  assert.equal(first.drawsLeft, 1);
  assert.equal(state.upserts, 1);
  assert.equal(state.events[0].toISOString(), today.toISOString());

  const second = await recordShare('user-1', now);
  assert.equal(second.progress.shareDraws, 1);
  assert.equal(state.upserts, 1);
});

test('five invite days is the cap', async () => {
  state.events = [26, 27, 28, 29, 30].map((day) => new Date(Date.UTC(2026, 10, day)));
  const result = await recordShare('user-1', now);
  assert.equal(result.progress.shareDraws, 5);
  assert.equal(state.upserts, 0);
});
