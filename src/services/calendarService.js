const prisma = require('../utils/prisma');
const { isActiveNow, POINT_SOURCE_CALENDAR, toPublicCard } = require('../utils/campaignRules');
const { CALENDAR_DAYS, CHRISTMAS_DAYS, calendarSites, cellState, dayNumber } = require('../utils/calendarRules');
const { grantPoints, listActiveRows } = require('./campaignEffects');

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function rulesOf(campaign) {
  const config = campaign?.config && typeof campaign.config === 'object' ? campaign.config : {};
  const days = Array.isArray(config.days) && config.days.length === CALENDAR_DAYS ? config.days : CHRISTMAS_DAYS;
  return {
    playEndsAt: new Date(config.playEndsAt || campaign.endsAt),
    sites: calendarSites(config),
    days,
  };
}

async function findCalendar(now = new Date()) {
  const rows = await listActiveRows(null, now, 'CALENDAR');
  return rows.find((row) => isActiveNow(row, now)) || null;
}

async function unlockedDays(client, userId, campaign, rules) {
  const rows = await client.crawlerData.findMany({
    where: {
      userId,
      source: { in: rules.sites },
      createdAt: { gte: campaign.startsAt, lte: rules.playEndsAt },
    },
    select: { createdAt: true },
  });
  const days = new Set();
  for (const row of rows) {
    const day = dayNumber(new Date(row.createdAt), campaign.startsAt);
    if (day >= 1 && day <= CALENDAR_DAYS) days.add(day);
  }
  return days;
}

function present(campaign, rules, opens, now) {
  const today = dayNumber(now, campaign.startsAt);
  const liveToday = today >= 1 && today <= CALENDAR_DAYS && now <= rules.playEndsAt ? today : null;
  const accepting = now <= new Date(campaign.endsAt);
  const byDay = new Map(opens.map((open) => [open.day, open]));
  return {
    campaign: toPublicCard(campaign),
    phase: now <= rules.playEndsAt ? 'open' : 'grace',
    today: liveToday,
    cells: rules.days.map((gift) => {
      const open = byDay.get(gift.day) || null;
      return {
        day: gift.day,
        state: cellState({
          day: gift.day,
          unlocked: false,
          opened: Boolean(open),
          today: liveToday || (today > CALENDAR_DAYS ? CALENDAR_DAYS + 1 : today),
          accepting,
        }),
        kind: gift.kind,
        points: Number(gift.points) || 0,
        asset: gift.asset || '',
        labelEn: gift.labelEn,
        labelZh: gift.labelZh,
        labelZhTw: gift.labelZhTw || '',
        labelJa: gift.labelJa || '',
        labelKo: gift.labelKo || '',
        openId: open?.id || null,
        claimStatus: open?.claimStatus || null,
      };
    }),
  };
}

async function decorateUnlocks(client, userId, campaign, rules, view, now) {
  const unlocked = await unlockedDays(client, userId, campaign, rules);
  const today = dayNumber(now, campaign.startsAt);
  const liveToday = today >= 1 && today <= CALENDAR_DAYS && now <= rules.playEndsAt ? today : null;
  const accepting = now <= new Date(campaign.endsAt);
  view.cells = view.cells.map((cell) => ({
    ...cell,
    state: cellState({
      day: cell.day,
      unlocked: unlocked.has(cell.day),
      opened: Boolean(cell.openId),
      today: liveToday || (today > CALENDAR_DAYS ? CALENDAR_DAYS + 1 : today),
      accepting,
    }),
  }));
  return view;
}

async function calendarState(userId, now = new Date()) {
  const campaign = await findCalendar(now);
  if (!campaign) return { campaign: null, phase: 'none', today: null, cells: [] };
  const rules = rulesOf(campaign);
  const opens = await prisma.campaignCalendarOpen.findMany({ where: { campaignId: campaign.id, userId } });
  const view = present(campaign, rules, opens, now);
  return decorateUnlocks(prisma, userId, campaign, rules, view, now);
}

async function openDay(userId, day, now = new Date()) {
  const wanted = Math.floor(Number(day));
  if (wanted < 1 || wanted > CALENDAR_DAYS) throw fail(400, 'That day is not on the calendar');
  const campaign = await findCalendar(now);
  if (!campaign) throw fail(404, 'The calendar is closed');
  if (now > new Date(campaign.endsAt)) throw fail(409, 'The calendar is closed');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Campaign" WHERE id = ${campaign.id} FOR NO KEY UPDATE`;
    const fresh = await tx.campaign.findUnique({ where: { id: campaign.id } });
    if (!fresh || !isActiveNow(fresh, now)) throw fail(409, 'The calendar is closed');
    const rules = rulesOf(fresh);
    const gift = rules.days.find((row) => row.day === wanted);
    if (!gift) throw fail(404, 'That day is not on the calendar');
    const today = dayNumber(now, fresh.startsAt);
    if (!today || wanted > today) throw fail(409, 'That day has not started');
    const existing = await tx.campaignCalendarOpen.findUnique({
      where: { campaignId_userId_day: { campaignId: fresh.id, userId, day: wanted } },
    });
    if (existing) return { open: existing, granted: false };
    const unlocked = await unlockedDays(tx, userId, fresh, rules);
    if (!unlocked.has(wanted)) throw fail(409, 'Upload a record on that day to unwrap it');
    const open = await tx.campaignCalendarOpen.create({
      data: {
        campaignId: fresh.id,
        userId,
        day: wanted,
        kind: gift.kind,
        points: gift.kind === 'POINTS' ? Number(gift.points) || 0 : 0,
        labelEn: gift.labelEn,
        labelZh: gift.labelZh,
        claimStatus: gift.kind === 'GIFT_CARD' ? 'unclaimed' : 'none',
      },
    });
    if (gift.kind === 'POINTS') {
      await grantPoints(tx, userId, open.points, POINT_SOURCE_CALENDAR, open.id);
    }
    return { open, granted: gift.kind === 'POINTS' };
  }, { maxWait: 10000, timeout: 15000 });
}

function cleanEmail(value) {
  const email = String(value || '').replace(/\s+/g, '').trim().toLowerCase().slice(0, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

async function claimGift(userId, openId, body, now = new Date()) {
  const open = await prisma.campaignCalendarOpen.findFirst({
    where: { id: openId, userId },
    include: { campaign: true },
  });
  if (!open || open.campaign.template !== 'CALENDAR') throw fail(404, 'Gift not found');
  if (open.kind !== 'GIFT_CARD') throw fail(400, 'This gift does not need a claim');
  if (open.claimStatus === 'processing' || open.claimStatus === 'fulfilled') throw fail(409, 'This gift is already claimed');
  if (now > new Date(open.campaign.endsAt)) throw fail(409, 'The claim window has closed');
  const email = cleanEmail(body?.email);
  if (!email) throw fail(400, 'An email address is required');
  const row = await prisma.campaignCalendarOpen.updateMany({
    where: { id: open.id, userId, claimStatus: 'unclaimed' },
    data: { claimStatus: 'processing', claim: { email } },
  });
  if (row.count !== 1) throw fail(409, 'This gift is already claimed');
  return { ...open, claimStatus: 'processing', claim: { email } };
}

async function opsCalendarState(campaign) {
  const opens = await prisma.campaignCalendarOpen.findMany({
    where: { campaignId: campaign.id },
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  return { opens };
}

async function fulfillOpen(campaign, openId) {
  const open = await prisma.campaignCalendarOpen.findFirst({ where: { id: openId, campaignId: campaign.id } });
  if (!open) throw fail(404, 'Gift not found');
  if (open.claimStatus !== 'processing') throw fail(409, 'Only a submitted claim can be marked sent');
  return prisma.campaignCalendarOpen.update({
    where: { id: open.id },
    data: { claimStatus: 'fulfilled' },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
}

module.exports = {
  calendarState,
  openDay,
  claimGift,
  opsCalendarState,
  fulfillOpen,
};
