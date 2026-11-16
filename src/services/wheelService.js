const prisma = require('../utils/prisma');
const { SHOP_SOURCES, SOCIAL_SOURCES } = require('../constants/crawlerSources');
const { isActiveNow, POINT_SOURCE_WHEEL, toPublicCard } = require('../utils/campaignRules');
const { availablePrizes, drawsFromCounts, pickWeighted } = require('../utils/wheelRules');
const { grantPoints, listActiveRows } = require('./campaignEffects');

const DEFAULT_SHOP_SITES = [...SHOP_SOURCES.filter((site) => site !== 'generic'), 'amazon'];
const DEFAULT_SOCIAL_SITES = SOCIAL_SOURCES.filter((site) => site !== 'discord');

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function wheelRules(campaign) {
  const config = campaign?.config && typeof campaign.config === 'object' ? campaign.config : {};
  const playEndsAt = new Date(config.playEndsAt || campaign?.endsAt || 0);
  return {
    playEndsAt,
    shopPer: Number(config.shopPer) || 5,
    socialPer: Number(config.socialPer) || 10,
    socialMaxDraws: Number(config.socialMaxDraws) || 5,
    shopSites: Array.isArray(config.shopSites) && config.shopSites.length ? config.shopSites : DEFAULT_SHOP_SITES,
    socialSites: Array.isArray(config.socialSites) && config.socialSites.length ? config.socialSites : DEFAULT_SOCIAL_SITES,
    prizes: Array.isArray(config.prizes) ? config.prizes : [],
    testBonusDraws: config.testBonusDraws && typeof config.testBonusDraws === 'object' ? config.testBonusDraws : {},
  };
}

function bonusDrawsFor(rules, userId) {
  const raw = Math.floor(Number(rules.testBonusDraws?.[userId]) || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, 20);
}

function claimEndsAt(campaign) {
  return new Date(campaign.endsAt);
}

function playing(campaign, now = new Date()) {
  return now <= wheelRules(campaign).playEndsAt;
}

async function findWheel(now = new Date()) {
  const rows = await listActiveRows(null, now, 'WHEEL');
  return rows.find((row) => isActiveNow(row, now)) || null;
}

async function countProgress(client, userId, campaign) {
  const rules = wheelRules(campaign);
  const db = client || prisma;
  const window = { gte: campaign.startsAt, lte: rules.playEndsAt };
  const [shopCount, socialCount, settings] = await Promise.all([
    db.crawlerData.count({ where: { userId, source: { in: rules.shopSites }, createdAt: window } }),
    db.crawlerData.count({ where: { userId, source: { in: rules.socialSites }, createdAt: window } }),
    db.lifeContextSettings.findUnique({ where: { userId }, select: { refinedAt: true } }),
  ]);
  const refinedAt = settings?.refinedAt ? new Date(settings.refinedAt) : null;
  const portrait = Boolean(refinedAt && refinedAt >= new Date(campaign.startsAt) && refinedAt <= rules.playEndsAt);
  const draws = drawsFromCounts({
    shopCount,
    socialCount,
    portrait,
    shopPer: rules.shopPer,
    socialPer: rules.socialPer,
    socialMaxDraws: rules.socialMaxDraws,
  });
  const bonusDraws = bonusDrawsFor(rules, userId);
  return {
    shopCount,
    socialCount,
    portrait,
    ...draws,
    bonusDraws,
    earned: draws.earned + bonusDraws,
    rules,
  };
}

function awardedMap(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.prizeId, row._count._all);
  return map;
}

function presentClaim(spin, endsAt, now) {
  const expired = spin.claimStatus === 'unclaimed' && now > endsAt;
  return {
    id: spin.id,
    prizeId: spin.prizeId,
    prizeKind: spin.prizeKind,
    points: spin.points,
    labelEn: spin.labelEn,
    labelZh: spin.labelZh,
    claimStatus: expired ? 'forfeited' : spin.claimStatus,
    claim: spin.claim || null,
    createdAt: spin.createdAt,
  };
}

function prizeView(prize, awarded) {
  const taken = awarded.get(prize.id) || 0;
  return {
    id: prize.id,
    kind: prize.kind,
    points: Number(prize.points) || 0,
    labelEn: prize.labelEn,
    labelZh: prize.labelZh,
    labelJa: prize.labelJa || '',
    labelZhTw: prize.labelZhTw || '',
    labelKo: prize.labelKo || '',
    remaining: prize.quantity == null ? null : Math.max(0, prize.quantity - taken),
  };
}

async function wheelState(userId, now = new Date()) {
  const campaign = await findWheel(now);
  if (!campaign) {
    return { campaign: null, phase: 'none', canSpin: false, drawsLeft: 0, progress: null, prizes: [], spins: [] };
  }
  const endsAt = claimEndsAt(campaign);
  const [progress, used, grouped, spins] = await Promise.all([
    countProgress(prisma, userId, campaign),
    prisma.campaignSpin.count({ where: { campaignId: campaign.id, userId } }),
    prisma.campaignSpin.groupBy({
      by: ['prizeId'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    }),
    prisma.campaignSpin.findMany({
      where: { campaignId: campaign.id, userId },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const awarded = awardedMap(grouped);
  const drawsLeft = Math.max(0, progress.earned - used);
  const open = playing(campaign, now);
  return {
    campaign: { ...toPublicCard(campaign), legalText: campaign.legalText || '' },
    phase: open ? 'open' : 'claim',
    canSpin: open && drawsLeft > 0,
    drawsLeft,
    progress: {
      shopCount: progress.shopCount,
      shopPer: progress.rules.shopPer,
      shopToward: progress.shopCount % progress.rules.shopPer,
      shopDraws: progress.shopDraws,
      socialCount: progress.socialCount,
      socialPer: progress.rules.socialPer,
      socialDraws: progress.socialDraws,
      socialMaxDraws: progress.rules.socialMaxDraws,
      portrait: progress.portrait,
    },
    prizes: progress.rules.prizes.map((prize) => prizeView(prize, awarded)),
    spins: spins.map((spin) => presentClaim(spin, endsAt, now)),
  };
}

async function spinWheel(userId, now = new Date()) {
  const campaign = await findWheel(now);
  if (!campaign) throw fail(404, 'No giveaway is open');
  if (!playing(campaign, now)) throw fail(409, 'The wheel is closed');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Campaign" WHERE id = ${campaign.id} FOR NO KEY UPDATE`;
    const fresh = await tx.campaign.findUnique({ where: { id: campaign.id } });
    if (!fresh || !isActiveNow(fresh, now) || !playing(fresh, now)) throw fail(409, 'The wheel is closed');
    const progress = await countProgress(tx, userId, fresh);
    const used = await tx.campaignSpin.count({ where: { campaignId: fresh.id, userId } });
    if (used >= progress.earned) throw fail(409, 'No draws left');
    const grouped = await tx.campaignSpin.groupBy({
      by: ['prizeId'],
      where: { campaignId: fresh.id },
      _count: { _all: true },
    });
    const priorGift = await tx.campaignSpin.findFirst({
      where: { campaignId: fresh.id, userId, prizeKind: { not: 'POINTS' } },
      select: { id: true },
    });
    const candidates = availablePrizes(progress.rules.prizes, awardedMap(grouped), Boolean(priorGift));
    const prize = pickWeighted(candidates);
    if (!prize) throw fail(409, 'No prizes are left');
    const spin = await tx.campaignSpin.create({
      data: {
        campaignId: fresh.id,
        userId,
        prizeId: prize.id,
        prizeKind: prize.kind,
        points: prize.kind === 'POINTS' ? prize.points : 0,
        labelEn: prize.labelEn,
        labelZh: prize.labelZh,
        claimStatus: prize.kind === 'POINTS' ? 'none' : 'unclaimed',
      },
    });
    if (prize.kind === 'POINTS') {
      await grantPoints(tx, userId, prize.points, POINT_SOURCE_WHEEL, spin.id);
    }
    return {
      spin: presentClaim(spin, claimEndsAt(fresh), now),
      drawsLeft: progress.earned - used - 1,
    };
  }, { maxWait: 10000, timeout: 15000 });
}

function cleanClaim(body) {
  const text = (value, max) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const name = text(body?.name, 80);
  const email = text(body?.email, 254).toLowerCase();
  const country = text(body?.country, 80);
  const walletAddress = text(body?.walletAddress, 120);
  const note = text(body?.note, 200);
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !country) return null;
  return { name, email, country, walletAddress, note };
}

async function claimSpin(userId, spinId, body, now = new Date()) {
  const spin = await prisma.campaignSpin.findFirst({
    where: { id: spinId, userId },
    include: { campaign: true },
  });
  if (!spin || spin.campaign.template !== 'WHEEL') throw fail(404, 'Prize not found');
  if (spin.prizeKind === 'POINTS' || spin.claimStatus === 'none') throw fail(400, 'Points prizes are already in My Points');
  if (spin.claimStatus === 'processing' || spin.claimStatus === 'fulfilled') throw fail(409, 'This prize is already claimed');
  if (now > claimEndsAt(spin.campaign)) throw fail(409, 'The claim window has closed');
  const claim = cleanClaim(body);
  if (!claim) throw fail(400, 'Name, email, and country are required');
  if (spin.prizeKind === 'USDT' && claim.walletAddress.length < 8) throw fail(400, 'A USDT address is required');
  const row = await prisma.campaignSpin.updateMany({
    where: { id: spin.id, userId, claimStatus: 'unclaimed' },
    data: { claimStatus: 'processing', claim },
  });
  if (row.count !== 1) throw fail(409, 'This prize is already claimed');
  return presentClaim({ ...spin, claimStatus: 'processing', claim }, claimEndsAt(spin.campaign), now);
}

async function opsWheelState(campaign) {
  const rules = wheelRules(campaign);
  const endsAt = claimEndsAt(campaign);
  const now = new Date();
  const [spins, grouped] = await Promise.all([
    prisma.campaignSpin.findMany({
      where: { campaignId: campaign.id },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true, name: true } } },
    }),
    prisma.campaignSpin.groupBy({
      by: ['prizeId'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    }),
  ]);
  const awarded = awardedMap(grouped);
  return {
    spins: spins.map((spin) => ({ ...presentClaim(spin, endsAt, now), user: spin.user })),
    stock: rules.prizes.map((prize) => ({
      id: prize.id,
      kind: prize.kind,
      labelEn: prize.labelEn,
      quantity: prize.quantity == null ? null : prize.quantity,
      awarded: awarded.get(prize.id) || 0,
    })),
  };
}

async function fulfillSpin(campaign, spinId) {
  const spin = await prisma.campaignSpin.findFirst({ where: { id: spinId, campaignId: campaign.id } });
  if (!spin) throw fail(404, 'Prize not found');
  if (spin.claimStatus !== 'processing') throw fail(409, 'Only a submitted claim can be marked sent');
  return prisma.campaignSpin.update({
    where: { id: spin.id },
    data: { claimStatus: 'fulfilled' },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
}

module.exports = {
  wheelState,
  spinWheel,
  claimSpin,
  opsWheelState,
  fulfillSpin,
  findWheel,
};
