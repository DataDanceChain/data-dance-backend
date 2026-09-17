const prisma = require('../utils/prisma');
const {
  POINT_SOURCE_CONNECT_BOOST,
  POINT_SOURCE_FIRST_ACTION,
  POINT_SOURCE_RAFFLE,
  POINT_SOURCE_REFERRAL_BOOST,
  isActiveNow,
  normalizeCrawlerSource,
  toPublicCard,
} = require('../utils/campaignRules');

function db(client) {
  return client || prisma;
}

async function listActiveRows(client, now = new Date(), template) {
  const where = {
    status: { in: ['LIVE', 'SCHEDULED'] },
    startsAt: { lte: now },
    endsAt: { gte: now },
  };
  if (template) where.template = template;
  const rows = await db(client).campaign.findMany({
    where,
    orderBy: [{ status: 'desc' }, { startsAt: 'desc' }],
  });
  return rows.filter((row) => isActiveNow(row, now));
}

function pickFirst(rows) {
  return rows[0] || null;
}

async function listActivePublic(now = new Date()) {
  const rows = await listActiveRows(null, now);
  return rows.map(toPublicCard);
}

function connectBoostForSource(rows, source) {
  const site = normalizeCrawlerSource(source);
  return (
    rows.find((row) => {
      if (row.template !== 'CONNECT_BOOST') return false;
      const sites = Array.isArray(row.config?.sites) ? row.config.sites : [];
      return sites.map(normalizeCrawlerSource).includes(site);
    }) || null
  );
}

function extraConnectPoints(basePoints, multiplier) {
  const extra = Math.round(Number(basePoints) * (Number(multiplier) - 1));
  return extra > 0 ? extra : 0;
}

async function awardConnectBoosts(tx, userId, pointsBySource, now = new Date()) {
  const boosts = await listActiveRows(tx, now, 'CONNECT_BOOST');
  if (boosts.length === 0) return { extra: 0, awards: [] };
  const extras = new Map();
  for (const [source, basePoints] of Object.entries(pointsBySource || {})) {
    const campaign = connectBoostForSource(boosts, source);
    if (!campaign) continue;
    const extra = extraConnectPoints(basePoints, campaign.config?.multiplier);
    if (!extra) continue;
    extras.set(campaign.id, (extras.get(campaign.id) || 0) + extra);
  }
  const awards = [];
  for (const [campaignId, amount] of extras.entries()) {
    await tx.user.update({
      where: { id: userId },
      data: { totalPoints: { increment: amount } },
    });
    await tx.point.create({
      data: {
        userId,
        amount,
        source: POINT_SOURCE_CONNECT_BOOST,
        sourceId: campaignId,
      },
    });
    awards.push({ campaignId, amount });
  }
  return {
    extra: awards.reduce((sum, row) => sum + row.amount, 0),
    awards,
  };
}

async function awardReferralBoost(inviterId, inviteeId, now = new Date()) {
  const campaign = pickFirst(await listActiveRows(null, now, 'REFERRAL_BOOST'));
  if (!campaign) return { skipped: true, reason: 'inactive' };
  const extraInviter = Number(campaign.config?.extraInviterPoints) || 0;
  const extraInvitee = Number(campaign.config?.extraInviteePoints) || 0;
  if (extraInviter <= 0 && extraInvitee <= 0) return { skipped: true, reason: 'zero' };
  const already = await prisma.point.findFirst({
    where: {
      userId: inviterId,
      source: POINT_SOURCE_REFERRAL_BOOST,
      sourceId: `${campaign.id}:${inviteeId}`,
    },
    select: { id: true },
  });
  if (already) return { skipped: true, reason: 'already_processed' };
  await prisma.$transaction(async (tx) => {
    if (extraInviter > 0) {
      await tx.user.update({
        where: { id: inviterId },
        data: { totalPoints: { increment: extraInviter } },
      });
      await tx.point.create({
        data: {
          userId: inviterId,
          amount: extraInviter,
          source: POINT_SOURCE_REFERRAL_BOOST,
          sourceId: `${campaign.id}:${inviteeId}`,
        },
      });
    }
    if (extraInvitee > 0) {
      await tx.user.update({
        where: { id: inviteeId },
        data: { totalPoints: { increment: extraInvitee } },
      });
      await tx.point.create({
        data: {
          userId: inviteeId,
          amount: extraInvitee,
          source: POINT_SOURCE_REFERRAL_BOOST,
          sourceId: `${campaign.id}:${inviterId}`,
        },
      });
    }
  });
  return { skipped: false, campaignId: campaign.id, extraInviter, extraInvitee };
}

async function awardFirstActionBonus(userId, action, now = new Date()) {
  const rows = await listActiveRows(null, now, 'FIRST_ACTION_BONUS');
  const campaign = rows.find((row) => row.config?.action === action) || null;
  if (!campaign) return { skipped: true, reason: 'inactive' };
  const points = Number(campaign.config?.points) || 0;
  if (points <= 0) return { skipped: true, reason: 'zero' };
  const already = await prisma.point.findFirst({
    where: {
      userId,
      source: POINT_SOURCE_FIRST_ACTION,
      sourceId: `${action}:${campaign.id}`,
    },
    select: { id: true },
  });
  if (already) return { skipped: true, reason: 'already_processed' };
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { totalPoints: { increment: points } },
    });
    await tx.point.create({
      data: {
        userId,
        amount: points,
        source: POINT_SOURCE_FIRST_ACTION,
        sourceId: `${action}:${campaign.id}`,
      },
    });
  });
  return { skipped: false, campaignId: campaign.id, points };
}

function raffleRules(campaign) {
  const config = campaign?.config && typeof campaign.config === 'object' ? campaign.config : {};
  return {
    baseTickets: Number(config.baseTickets) || 0,
    ticketOnValidInvite: Number(config.ticketOnValidInvite) || 0,
    maxTickets: Number(config.maxTickets) || 1,
    prizes: Array.isArray(config.prizes) ? config.prizes : [],
  };
}

async function countWindowInvites(userId, campaign) {
  return db().referral.count({
    where: {
      inviterId: userId,
      createdAt: { gte: campaign.startsAt, lte: campaign.endsAt },
    },
  });
}

async function computeRaffleTickets(userId, campaign) {
  const rules = raffleRules(campaign);
  const invites = rules.ticketOnValidInvite > 0 ? await countWindowInvites(userId, campaign) : 0;
  const raw = rules.baseTickets + invites * rules.ticketOnValidInvite;
  return Math.max(0, Math.min(rules.maxTickets, raw));
}

async function upsertRaffleTickets(userId, campaign) {
  if (!campaign || campaign.template !== 'RAFFLE') return { tickets: 0 };
  const tickets = await computeRaffleTickets(userId, campaign);
  await prisma.campaignRaffleTicket.upsert({
    where: { campaignId_userId: { campaignId: campaign.id, userId } },
    update: { tickets },
    create: { campaignId: campaign.id, userId, tickets },
  });
  return { tickets };
}

async function syncRaffleTicketsForInviter(inviterId, now = new Date()) {
  const campaign = pickFirst(await listActiveRows(null, now, 'RAFFLE'));
  if (!campaign) return { skipped: true };
  return upsertRaffleTickets(inviterId, campaign);
}

function pickWeightedWinner(entries) {
  const total = entries.reduce((sum, row) => sum + row.tickets, 0);
  if (total <= 0) return null;
  let cursor = Math.random() * total;
  for (const row of entries) {
    cursor -= row.tickets;
    if (cursor <= 0) return row;
  }
  return entries[entries.length - 1] || null;
}

async function drawRaffle(campaign, actor) {
  if (!campaign || campaign.template !== 'RAFFLE') return { error: 'Not a raffle' };
  const rules = raffleRules(campaign);
  const existing = await prisma.campaignRaffleWin.findMany({
    where: { campaignId: campaign.id },
    select: { prizeIndex: true, userId: true },
  });
  const takenByPrize = new Map();
  for (const win of existing) {
    const list = takenByPrize.get(win.prizeIndex) || [];
    list.push(win.userId);
    takenByPrize.set(win.prizeIndex, list);
  }
  const holders = await prisma.campaignRaffleTicket.findMany({
    where: { campaignId: campaign.id, tickets: { gt: 0 } },
    select: { userId: true, tickets: true },
  });
  const created = [];
  await prisma.$transaction(async (tx) => {
    for (let prizeIndex = 0; prizeIndex < rules.prizes.length; prizeIndex += 1) {
      const prize = rules.prizes[prizeIndex];
      const already = takenByPrize.get(prizeIndex) || [];
      const seatsLeft = Math.max(0, Number(prize.count) - already.length);
      for (let seat = 0; seat < seatsLeft; seat += 1) {
        const blocked = new Set([...(takenByPrize.get(prizeIndex) || [])]);
        const pool = holders.filter((row) => !blocked.has(row.userId));
        const winner = pickWeightedWinner(pool);
        if (!winner) break;
        const win = await tx.campaignRaffleWin.create({
          data: {
            campaignId: campaign.id,
            userId: winner.userId,
            prizeIndex,
            prizeKind: prize.kind,
            points: prize.kind === 'POINTS' ? Number(prize.points) || 0 : 0,
            labelEn: prize.labelEn,
            labelZh: prize.labelZh,
            fulfilled: prize.kind === 'POINTS',
          },
        });
        already.push(winner.userId);
        takenByPrize.set(prizeIndex, already);
        if (prize.kind === 'POINTS' && win.points > 0) {
          await tx.user.update({
            where: { id: winner.userId },
            data: { totalPoints: { increment: win.points } },
          });
          await tx.point.create({
            data: {
              userId: winner.userId,
              amount: win.points,
              source: POINT_SOURCE_RAFFLE,
              sourceId: win.id,
            },
          });
        }
        created.push(win);
      }
    }
    await tx.campaignEvent.create({
      data: {
        campaignId: campaign.id,
        actor,
        action: 'raffle_draw',
        fromStatus: campaign.status,
        toStatus: campaign.status,
        note: `drew ${created.length} prize${created.length === 1 ? '' : 's'}`,
      },
    });
  });
  return { created };
}

module.exports = {
  listActiveRows,
  listActivePublic,
  connectBoostForSource,
  extraConnectPoints,
  awardConnectBoosts,
  awardReferralBoost,
  awardFirstActionBonus,
  computeRaffleTickets,
  upsertRaffleTickets,
  syncRaffleTicketsForInviter,
  drawRaffle,
  raffleRules,
};
