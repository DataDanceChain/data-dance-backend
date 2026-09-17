const prisma = require('./prisma');
const { normalizeCrawlerSource } = require('../constants/crawlerSources');
const {
  SUMMER_TRAVEL_2026,
  SUMMER_TRAVEL_2026_SLUG,
  SUMMER_TRAVEL_2026_RETIRED,
  isSummerTravel2026Active,
  assertCampaignActive,
} = require('../constants/referralCampaigns');
const { STAY_SITES, isActiveNow } = require('./campaignRules');

function parseYmd(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function sitesOf(row) {
  const sites = Array.isArray(row?.config?.sites) ? row.config.sites : [];
  return [...new Set(sites.map((site) => normalizeCrawlerSource(site)).filter((site) => STAY_SITES.has(site)))];
}

function rulesFromRow(row) {
  const bonusPerItem = Number(row.config?.bonusPerItem) || 10;
  const pointsPerOrder = Number(row.config?.pointsPerOrder) || bonusPerItem + 10;
  return {
    source: 'campaign',
    campaignId: row.id,
    slug: row.slug,
    titleEn: row.titleEn,
    titleZh: row.titleZh,
    blurbEn: row.blurbEn,
    blurbZh: row.blurbZh,
    sites: sitesOf(row),
    stayStartDate: parseYmd(row.config?.stayStartDate) || SUMMER_TRAVEL_2026.stayStartDate,
    stayEndDate: parseYmd(row.config?.stayEndDate) || SUMMER_TRAVEL_2026.stayEndDate,
    bonusPerItem,
    pointsPerOrder,
    inviterPoints: Number(row.config?.inviterPoints) || 0,
    inviteePoints: Number(row.config?.inviteePoints) || 0,
    startUtc: row.startsAt,
    endUtc: row.endsAt,
    isActive: true,
  };
}

function legacyRules() {
  return {
    source: 'legacy',
    campaignId: null,
    slug: SUMMER_TRAVEL_2026_SLUG,
    titleEn: 'Summer Travel Bonus',
    titleZh: '夏日出行奖励',
    blurbEn: 'Connect Booking or Airbnb and earn double points on 2026 summer stays.',
    blurbZh: '连接 Booking 或 Airbnb，2026 年夏季住宿双倍积分。',
    sites: ['airbnb', 'booking'],
    stayStartDate: SUMMER_TRAVEL_2026.stayStartDate,
    stayEndDate: SUMMER_TRAVEL_2026.stayEndDate,
    bonusPerItem: SUMMER_TRAVEL_2026.uploadBonusPerItem,
    pointsPerOrder: SUMMER_TRAVEL_2026.pointsPerOrderDisplay,
    inviterPoints: SUMMER_TRAVEL_2026.inviterPoints,
    inviteePoints: SUMMER_TRAVEL_2026.inviteePoints,
    startUtc: SUMMER_TRAVEL_2026.startUtc,
    endUtc: SUMMER_TRAVEL_2026.endUtc,
    isActive: true,
  };
}

async function findActiveStayBonusRow(now = new Date()) {
  const rows = await prisma.campaign.findMany({
    where: {
      template: 'STAY_BONUS',
      status: { in: ['LIVE', 'SCHEDULED'] },
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    orderBy: [{ status: 'desc' }, { startsAt: 'desc' }],
  });
  return rows.find((row) => isActiveNow(row, now)) || null;
}

async function resolveStayBonusRules(now = new Date()) {
  const row = await findActiveStayBonusRow(now);
  if (row) {
    const rules = rulesFromRow(row);
    return rules.sites.length ? rules : null;
  }
  if (!SUMMER_TRAVEL_2026_RETIRED && isSummerTravel2026Active(now)) {
    return legacyRules();
  }
  return null;
}

async function assertReferralCampaignUsable(slug, now = new Date()) {
  if (!slug) return;
  if (slug === SUMMER_TRAVEL_2026_SLUG) {
    if (SUMMER_TRAVEL_2026_RETIRED) {
      const err = new Error('Summer Travel Bonus campaign is not active.');
      err.code = 'CAMPAIGN_INACTIVE';
      throw err;
    }
    const rules = await resolveStayBonusRules(now);
    if (!rules?.isActive) {
      const err = new Error('Summer Travel Bonus campaign is not active.');
      err.code = 'CAMPAIGN_INACTIVE';
      throw err;
    }
    return;
  }
  assertCampaignActive(slug, now);
}

module.exports = {
  STAY_SITES,
  parseYmd,
  resolveStayBonusRules,
  findActiveStayBonusRow,
  assertReferralCampaignUsable,
};
