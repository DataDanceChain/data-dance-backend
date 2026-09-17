const {
  ACCEPTED_SOURCES,
  CORE_SOURCES,
  SHOP_SOURCES,
  SOCIAL_SOURCES,
  TRAVEL_SOURCES,
  LIFE_SOURCES,
  normalizeCrawlerSource,
} = require('../constants/crawlerSources');
const { buildCampaignI18n, firstFilled } = require('./campaignI18n');

const TEMPLATES = new Set([
  'HOME_CARD',
  'CONNECT_BOOST',
  'REFERRAL_BOOST',
  'REDEEM_SALE',
  'FIRST_ACTION_BONUS',
  'APPLY_COHORT',
  'RAFFLE',
  'STAY_BONUS',
]);
const EXCLUSIVE_TEMPLATES = new Set([
  'REFERRAL_BOOST',
  'REDEEM_SALE',
  'FIRST_ACTION_BONUS',
  'APPLY_COHORT',
  'RAFFLE',
  'STAY_BONUS',
]);
const STAY_SITES = new Set(['airbnb', 'booking', ...TRAVEL_SOURCES]);
const STATUSES = new Set(['DRAFT', 'SCHEDULED', 'LIVE', 'ENDED']);
const CTA_KINDS = new Set(['ROUTE', 'CONNECT', 'EXTERNAL', 'SHARE']);
const ROUTES = new Set([
  '/user/index',
  '/user/summer-travel',
  '/user/new-user-bonus',
  '/user/daily-points',
  '/user/referral',
  '/user/points',
  '/user/life-capsule',
  '/user/apply',
  '/user/raffle',
  '/user/tourism-map',
]);
const CONNECT_SITES = new Set(
  ACCEPTED_SOURCES.filter((source) => source && source !== 'generic'),
);
const FIRST_ACTIONS = new Set(['first_distillation']);
const EXTERNAL_HOSTS = ['datadance.ai', 'x.com', 'twitter.com'];
const POINT_SOURCE_CONNECT_BOOST = 'CAMPAIGN_CONNECT_BOOST';
const POINT_SOURCE_REFERRAL_BOOST = 'CAMPAIGN_REFERRAL_BOOST';
const POINT_SOURCE_FIRST_ACTION = 'CAMPAIGN_FIRST_ACTION';
const POINT_SOURCE_RAFFLE = 'CAMPAIGN_RAFFLE';

const SITE_GROUPS = [
  { id: 'core', label: 'Core', sites: CORE_SOURCES },
  { id: 'shop', label: 'Shops', sites: SHOP_SOURCES.filter((site) => site !== 'generic') },
  { id: 'travel', label: 'Travel', sites: TRAVEL_SOURCES },
  { id: 'life', label: 'Life', sites: LIFE_SOURCES },
  { id: 'social', label: 'Social', sites: SOCIAL_SOURCES },
];

function stripText(value, max) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeSlug(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length >= 3 && slug.length <= 64;
}

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  return EXTERNAL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < min || i > max) return null;
  return i;
}

function asMultiplier(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 10) / 10;
  if (rounded < 1.1 || rounded > 3) return null;
  return rounded;
}

function validateCta(kind, value) {
  if (!CTA_KINDS.has(kind)) return 'Choose a CTA type';
  const raw = String(value || '').trim();
  if (kind === 'SHARE') {
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:') return 'Share links must use https';
      if (!hostAllowed(url.hostname)) return 'That share host is not allowed';
      return null;
    } catch {
      return 'Share link is not a valid URL';
    }
  }
  if (!raw) return 'CTA target is required';
  if (kind === 'ROUTE') {
    return ROUTES.has(raw) ? null : 'That Wallet route is not allowed';
  }
  if (kind === 'CONNECT') {
    const site = normalizeCrawlerSource(raw);
    return CONNECT_SITES.has(site) ? null : 'That Connect site is not allowed';
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return 'External links must use https';
    if (!hostAllowed(url.hostname)) return 'That external host is not allowed';
    return null;
  } catch {
    return 'External link is not a valid URL';
  }
}

function parseHomeConfig(body) {
  const ctaKind = String(body.ctaKind || 'ROUTE').trim();
  const ctaValue = String(body.ctaValue || '').trim();
  const ctaError = validateCta(ctaKind, ctaValue);
  if (ctaError) return { error: ctaError };
  const coverImageUrl = stripText(body.coverImageUrl, 500);
  if (coverImageUrl) {
    try {
      const url = new URL(coverImageUrl);
      if (url.protocol !== 'https:' || !hostAllowed(url.hostname)) {
        return { error: 'Cover image must be an https DataDance or X URL' };
      }
    } catch {
      return { error: 'Cover image is not a valid URL' };
    }
  }
  return {
    ctaKind,
    ctaValue,
    coverImageUrl: coverImageUrl || null,
    config: {
      shareTextEn: stripText(body.shareTextEn || body.config?.shareTextEn, 280) || null,
      shareTextZh: stripText(body.shareTextZh || body.config?.shareTextZh, 280) || null,
      shareTextJa: stripText(body.shareTextJa || body.config?.shareTextJa, 280) || null,
      shareTextZhTw: stripText(body.shareTextZhTw || body.config?.shareTextZhTw, 280) || null,
    },
  };
}

function parseConnectBoostConfig(body) {
  const rawSites = Array.isArray(body.sites)
    ? body.sites
    : Array.isArray(body.config?.sites)
      ? body.config.sites
      : [];
  const sites = [...new Set(rawSites.map((site) => normalizeCrawlerSource(site)).filter((site) => CONNECT_SITES.has(site)))];
  if (sites.length === 0) return { error: 'Choose at least one Connect site' };
  const multiplier = asMultiplier(body.multiplier ?? body.config?.multiplier ?? 2);
  if (multiplier == null) return { error: 'Multiplier must be between 1.1× and 3×' };
  return {
    ctaKind: 'ROUTE',
    ctaValue: '/user/index',
    coverImageUrl: null,
    config: { sites, multiplier },
  };
}

function parseReferralBoostConfig(body) {
  const extraInviterPoints = asInt(body.extraInviterPoints ?? body.config?.extraInviterPoints, 1, 500);
  if (extraInviterPoints == null) return { error: 'Extra inviter points must be 1–500' };
  const extraInviteePoints = asInt(body.extraInviteePoints ?? body.config?.extraInviteePoints ?? 0, 0, 200);
  if (extraInviteePoints == null) return { error: 'Extra invitee points must be 0–200' };
  return {
    ctaKind: 'ROUTE',
    ctaValue: '/user/referral',
    coverImageUrl: null,
    config: { extraInviterPoints, extraInviteePoints },
  };
}

function parseRedeemSaleConfig(body) {
  const percentOff = asInt(body.percentOff ?? body.config?.percentOff, 1, 20);
  if (percentOff == null) return { error: 'Discount must be 1–20 percent' };
  return {
    ctaKind: 'ROUTE',
    ctaValue: '/user/points',
    coverImageUrl: null,
    config: { percentOff },
  };
}

function parseFirstActionConfig(body) {
  const action = String(body.action || body.config?.action || '').trim();
  if (!FIRST_ACTIONS.has(action)) return { error: 'Choose a first-action type' };
  const points = asInt(body.points ?? body.config?.points, 1, 100);
  if (points == null) return { error: 'Bonus points must be 1–100' };
  return {
    ctaKind: 'ROUTE',
    ctaValue: '/user/life-capsule',
    coverImageUrl: null,
    config: { action, points },
  };
}

function questionPair(en, zh, ja, zhTw) {
  const questionEn = stripText(en, 160);
  const questionZh = stripText(zh, 160);
  const questionJa = stripText(ja, 160);
  const questionZhTw = stripText(zhTw, 160);
  const any = questionEn || questionZh || questionJa || questionZhTw;
  if (!any) return null;
  return { en: questionEn || any, zh: questionZh || any };
}

function parseApplyConfig(body) {
  const seatCap = asInt(body.seatCap ?? body.config?.seatCap, 1, 200);
  if (seatCap == null) return { error: 'Seat cap must be 1–200' };
  const questions = [1, 2, 3].map((index) =>
    questionPair(
      body[`question${index}En`] ?? body.config?.[`question${index}En`],
      body[`question${index}Zh`] ?? body.config?.[`question${index}Zh`],
      body[`question${index}Ja`] ?? body.config?.[`question${index}Ja`],
      body[`question${index}ZhTw`] ?? body.config?.[`question${index}ZhTw`],
    ),
  );
  if (questions.some((item) => !item)) return { error: 'All three questions need text in at least one language' };
  return {
    ctaKind: 'ROUTE',
    ctaValue: '/user/apply',
    coverImageUrl: null,
    config: {
      seatCap,
      question1En: questions[0].en,
      question1Zh: questions[0].zh,
      question2En: questions[1].en,
      question2Zh: questions[1].zh,
      question3En: questions[2].en,
      question3Zh: questions[2].zh,
      perkNoteEn: stripText(body.perkNoteEn ?? body.config?.perkNoteEn, 280),
      perkNoteZh: stripText(body.perkNoteZh ?? body.config?.perkNoteZh, 280),
      perkNoteJa: stripText(body.perkNoteJa ?? body.config?.perkNoteJa, 280),
      perkNoteZhTw: stripText(body.perkNoteZhTw ?? body.config?.perkNoteZhTw, 280),
      question1Ja: stripText(body.question1Ja ?? body.config?.question1Ja, 160),
      question1ZhTw: stripText(body.question1ZhTw ?? body.config?.question1ZhTw, 160),
      question2Ja: stripText(body.question2Ja ?? body.config?.question2Ja, 160),
      question2ZhTw: stripText(body.question2ZhTw ?? body.config?.question2ZhTw, 160),
      question3Ja: stripText(body.question3Ja ?? body.config?.question3Ja, 160),
      question3ZhTw: stripText(body.question3ZhTw ?? body.config?.question3ZhTw, 160),
    },
  };
}

function parseRafflePrizes(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return null;
  const prizes = [];
  for (const row of raw) {
    const kind = String(row?.kind || '').trim().toUpperCase();
    if (kind !== 'POINTS' && kind !== 'MANUAL') return null;
    const count = asInt(row.count, 1, 50);
    if (count == null) return null;
    const labelEn = stripText(row.labelEn, 80);
    const labelZh = stripText(row.labelZh, 80);
    const labelJa = stripText(row.labelJa, 80);
    const labelZhTw = stripText(row.labelZhTw, 80);
    const anyLabel = labelEn || labelZh || labelJa || labelZhTw;
    if (!anyLabel) return null;
    const points = kind === 'POINTS' ? asInt(row.points, 1, 500) : 0;
    if (kind === 'POINTS' && points == null) return null;
    prizes.push({
      kind,
      count,
      points: points || 0,
      labelEn: labelEn || anyLabel,
      labelZh: labelZh || anyLabel,
      labelJa: labelJa || '',
      labelZhTw: labelZhTw || '',
    });
  }
  return prizes;
}

function parseStayBonusConfig(body) {
  const rawSites = Array.isArray(body.sites)
    ? body.sites
    : Array.isArray(body.config?.sites)
      ? body.config.sites
      : [];
  const sites = [...new Set(rawSites.map((site) => normalizeCrawlerSource(site)).filter((site) => STAY_SITES.has(site)))];
  if (sites.length === 0) return { error: 'Choose at least one stay source (Booking, Airbnb, or a travel site)' };
  const stayStartDate = String(body.stayStartDate || body.config?.stayStartDate || '').trim();
  const stayEndDate = String(body.stayEndDate || body.config?.stayEndDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stayStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(stayEndDate)) {
    return { error: 'Stay window must be YYYY-MM-DD dates' };
  }
  if (stayEndDate < stayStartDate) return { error: 'Stay end date must be on or after the start date' };
  const bonusPerItem = asInt(body.bonusPerItem ?? body.config?.bonusPerItem ?? 10, 1, 100);
  if (bonusPerItem == null) return { error: 'Bonus per stay must be 1–100' };
  const pointsPerOrder = asInt(body.pointsPerOrder ?? body.config?.pointsPerOrder ?? bonusPerItem + 10, 1, 200);
  if (pointsPerOrder == null) return { error: 'Points per stay must be 1–200' };
  const inviterPoints = asInt(body.inviterPoints ?? body.config?.inviterPoints ?? 300, 1, 500);
  if (inviterPoints == null) return { error: 'Inviter points must be 1–500' };
  const inviteePoints = asInt(body.inviteePoints ?? body.config?.inviteePoints ?? 100, 0, 200);
  if (inviteePoints == null) return { error: 'Invitee points must be 0–200' };
  return {
    ctaKind: 'ROUTE',
    ctaValue: '/user/summer-travel',
    coverImageUrl: null,
    config: {
      sites,
      stayStartDate,
      stayEndDate,
      bonusPerItem,
      pointsPerOrder,
      inviterPoints,
      inviteePoints,
    },
  };
}

function parseRaffleConfig(body) {
  const baseTickets = asInt(body.baseTickets ?? body.config?.baseTickets ?? 1, 0, 3);
  if (baseTickets == null) return { error: 'Base tickets must be 0–3' };
  const ticketOnValidInvite = asInt(body.ticketOnValidInvite ?? body.config?.ticketOnValidInvite ?? 1, 0, 1);
  if (ticketOnValidInvite == null) return { error: 'Invite tickets must be 0 or 1' };
  const maxTickets = asInt(body.maxTickets ?? body.config?.maxTickets ?? 5, 1, 10);
  if (maxTickets == null) return { error: 'Max tickets must be 1–10' };
  if (maxTickets < Math.max(baseTickets, 1)) return { error: 'Max tickets must be at least the base tickets' };
  const prizes = parseRafflePrizes(body.prizes ?? body.config?.prizes);
  if (!prizes) return { error: 'Add 1–8 prizes with a kind, count, and a label in at least one language' };
  return {
    ctaKind: 'ROUTE',
    ctaValue: '/user/raffle',
    coverImageUrl: null,
    config: { baseTickets, ticketOnValidInvite, maxTickets, prizes },
  };
}

function parseTemplateFields(template, body) {
  if (template === 'HOME_CARD') return parseHomeConfig(body);
  if (template === 'CONNECT_BOOST') return parseConnectBoostConfig(body);
  if (template === 'REFERRAL_BOOST') return parseReferralBoostConfig(body);
  if (template === 'REDEEM_SALE') return parseRedeemSaleConfig(body);
  if (template === 'FIRST_ACTION_BONUS') return parseFirstActionConfig(body);
  if (template === 'APPLY_COHORT') return parseApplyConfig(body);
  if (template === 'RAFFLE') return parseRaffleConfig(body);
  if (template === 'STAY_BONUS') return parseStayBonusConfig(body);
  return { error: 'Unknown campaign template' };
}

function parseDraft(body = {}) {
  const slug = normalizeSlug(body.slug);
  if (!isValidSlug(slug)) {
    return { error: 'Slug must be lowercase letters, numbers, and hyphens' };
  }
  const template = String(body.template || 'HOME_CARD').trim();
  if (!TEMPLATES.has(template)) return { error: 'Unknown campaign template' };
  const startsAt = parseDate(body.startsAt);
  const endsAt = parseDate(body.endsAt);
  if (!startsAt || !endsAt) return { error: 'Start and end times are required' };
  if (endsAt <= startsAt) return { error: 'End time must be after start time' };
  const i18n = buildCampaignI18n(body, {
    titleEn: stripText(body.titleEn, 80),
    titleZh: stripText(body.titleZh, 80),
    blurbEn: stripText(body.blurbEn, 200),
    blurbZh: stripText(body.blurbZh, 200),
    pillEn: stripText(body.pillEn, 40),
    pillZh: stripText(body.pillZh, 40),
  });
  const titleEn = i18n.title.en || firstFilled(i18n.title);
  const titleZh = i18n.title.zh || firstFilled(i18n.title);
  const blurbEn = i18n.blurb.en || firstFilled(i18n.blurb);
  const blurbZh = i18n.blurb.zh || firstFilled(i18n.blurb);
  if (!firstFilled(i18n.title) || !firstFilled(i18n.blurb)) {
    return { error: 'A title and blurb are required in at least one language' };
  }
  const parsed = parseTemplateFields(template, body);
  if (parsed.error) return parsed;
  return {
    data: {
      slug,
      internalName: stripText(body.internalName, 80) || titleEn,
      titleEn,
      titleZh,
      blurbEn,
      blurbZh,
      pillEn: i18n.pill.en || stripText(body.pillEn, 40) || null,
      pillZh: i18n.pill.zh || stripText(body.pillZh, 40) || null,
      template,
      startsAt,
      endsAt,
      timezone: stripText(body.timezone, 64) || 'UTC',
      ctaKind: parsed.ctaKind,
      ctaValue: parsed.ctaValue,
      purpose: stripText(body.purpose, 500),
      legalText: stripText(body.legalText, 4000),
      coverImageUrl: parsed.coverImageUrl,
      config: { ...parsed.config, i18n },
    },
  };
}

function assertPublishable(data) {
  if (!data.purpose || data.purpose.length < 8) {
    return 'Purpose is required before this campaign can go live';
  }
  if (!data.legalText || data.legalText.length < 20) {
    return 'Legal plain text is required before this campaign can go live';
  }
  return null;
}

function isActiveNow(row, now = new Date()) {
  if (row.status !== 'LIVE' && row.status !== 'SCHEDULED') return false;
  const start = parseDate(row.startsAt);
  const end = parseDate(row.endsAt);
  if (!start || !end) return false;
  return now >= start && now <= end;
}

function windowsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function sitesOf(row) {
  const sites = Array.isArray(row?.config?.sites) ? row.config.sites : [];
  return sites.map((site) => normalizeCrawlerSource(site));
}

function conflictMessage(existing, next) {
  if (next.template === 'CONNECT_BOOST') {
    if (existing.template !== 'CONNECT_BOOST') return null;
    const overlap = sitesOf(existing).filter((site) => sitesOf(next).includes(site));
    if (overlap.length) {
      return `Those sites already have a ${existing.status.toLowerCase()} boost (${existing.slug}): ${overlap.join(', ')}`;
    }
    return null;
  }
  if (EXCLUSIVE_TEMPLATES.has(next.template) && existing.template === next.template) {
    return `Another ${next.template.replace(/_/g, ' ').toLowerCase()} is already ${existing.status.toLowerCase()} (${existing.slug}) in this window`;
  }
  return null;
}

function findScheduleConflict(existingRows, next, excludeId) {
  return existingRows.find((row) => {
    if (row.id === excludeId) return false;
    if (row.status !== 'LIVE' && row.status !== 'SCHEDULED') return false;
    if (!windowsOverlap(row.startsAt, row.endsAt, next.startsAt, next.endsAt)) return false;
    return Boolean(conflictMessage(row, next));
  });
}

function mergeLocaleConfig(config, i18n) {
  const next = { ...config, i18n };
  const write = (prefix, map) => {
    if (map.en) next[`${prefix}En`] = map.en;
    if (map.zh) next[`${prefix}Zh`] = map.zh;
    if (map.ja) next[`${prefix}Ja`] = map.ja;
    if (map['zh-TW']) next[`${prefix}ZhTw`] = map['zh-TW'];
  };
  write('shareText', i18n.shareText);
  write('perkNote', i18n.perkNote);
  write('question1', i18n.question1);
  write('question2', i18n.question2);
  write('question3', i18n.question3);
  return next;
}

function applyCopyFields(existing, body = {}) {
  const current = existing.config && typeof existing.config === 'object' ? existing.config : {};
  const i18n = buildCampaignI18n(
    { ...body, i18n: body.i18n || body.config?.i18n || current.i18n },
    {
      titleEn: stripText(body.titleEn, 80) || existing.titleEn,
      titleZh: stripText(body.titleZh, 80) || existing.titleZh,
      blurbEn: stripText(body.blurbEn, 200) || existing.blurbEn,
      blurbZh: stripText(body.blurbZh, 200) || existing.blurbZh,
      pillEn: stripText(body.pillEn, 40) || existing.pillEn,
      pillZh: stripText(body.pillZh, 40) || existing.pillZh,
    },
  );
  if (!firstFilled(i18n.title) || !firstFilled(i18n.blurb)) {
    return { error: 'A title and blurb are required in at least one language' };
  }
  const config = mergeLocaleConfig(current, i18n);
  if (existing.template === 'RAFFLE' && Array.isArray(body.prizes) && Array.isArray(config.prizes)) {
    config.prizes = config.prizes.map((prize, index) => {
      const next = body.prizes[index] || {};
      return {
        ...prize,
        labelEn: stripText(next.labelEn, 80) || prize.labelEn,
        labelZh: stripText(next.labelZh, 80) || prize.labelZh,
        labelJa: stripText(next.labelJa, 80) || prize.labelJa || '',
        labelZhTw: stripText(next.labelZhTw, 80) || prize.labelZhTw || '',
      };
    });
  }
  return {
    data: {
      titleEn: i18n.title.en || firstFilled(i18n.title),
      titleZh: i18n.title.zh || firstFilled(i18n.title),
      blurbEn: i18n.blurb.en || firstFilled(i18n.blurb),
      blurbZh: i18n.blurb.zh || firstFilled(i18n.blurb),
      pillEn: i18n.pill.en || existing.pillEn || null,
      pillZh: i18n.pill.zh || existing.pillZh || null,
      config,
    },
  };
}

function toPublicCard(row) {
  const config = row.config && typeof row.config === 'object' ? row.config : {};
  const publicConfig =
    row.template === 'HOME_CARD'
      ? { shareTextEn: config.shareTextEn || null, shareTextZh: config.shareTextZh || null }
      : row.template === 'CONNECT_BOOST'
        ? { sites: Array.isArray(config.sites) ? config.sites : [], multiplier: Number(config.multiplier) || 1 }
        : row.template === 'REFERRAL_BOOST'
          ? {
              extraInviterPoints: Number(config.extraInviterPoints) || 0,
              extraInviteePoints: Number(config.extraInviteePoints) || 0,
            }
          : row.template === 'REDEEM_SALE'
            ? { percentOff: Number(config.percentOff) || 0 }
            : row.template === 'FIRST_ACTION_BONUS'
              ? { action: config.action || null, points: Number(config.points) || 0 }
              : row.template === 'APPLY_COHORT'
                ? {
                    seatCap: Number(config.seatCap) || 0,
                    question1En: config.question1En || '',
                    question1Zh: config.question1Zh || '',
                    question2En: config.question2En || '',
                    question2Zh: config.question2Zh || '',
                    question3En: config.question3En || '',
                    question3Zh: config.question3Zh || '',
                    perkNoteEn: config.perkNoteEn || '',
                    perkNoteZh: config.perkNoteZh || '',
                  }
                : row.template === 'RAFFLE'
                  ? {
                      baseTickets: Number(config.baseTickets) || 0,
                      ticketOnValidInvite: Number(config.ticketOnValidInvite) || 0,
                      maxTickets: Number(config.maxTickets) || 0,
                      prizes: Array.isArray(config.prizes) ? config.prizes : [],
                    }
                  : row.template === 'STAY_BONUS'
                    ? {
                        sites: Array.isArray(config.sites) ? config.sites : [],
                        stayStartDate: config.stayStartDate || null,
                        stayEndDate: config.stayEndDate || null,
                        bonusPerItem: Number(config.bonusPerItem) || 0,
                        pointsPerOrder: Number(config.pointsPerOrder) || 0,
                        inviterPoints: Number(config.inviterPoints) || 0,
                        inviteePoints: Number(config.inviteePoints) || 0,
                      }
                    : {};
  if (config.i18n) publicConfig.i18n = config.i18n;
  return {
    id: row.id,
    slug: row.slug,
    template: row.template,
    titleEn: row.titleEn,
    titleZh: row.titleZh,
    blurbEn: row.blurbEn,
    blurbZh: row.blurbZh,
    pillEn: row.pillEn,
    pillZh: row.pillZh,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    ctaKind: row.ctaKind,
    ctaValue: row.ctaValue,
    coverImageUrl: row.coverImageUrl || null,
    config: publicConfig,
  };
}

function salePoints(pointsRequired, percentOff) {
  const base = Number(pointsRequired);
  const off = Number(percentOff);
  if (!Number.isFinite(base) || base <= 0) return base;
  if (!Number.isFinite(off) || off <= 0) return Math.round(base);
  return Math.max(1, Math.ceil((base * (100 - off)) / 100));
}

module.exports = {
  TEMPLATES,
  STATUSES,
  CTA_KINDS,
  ROUTES,
  CONNECT_SITES,
  STAY_SITES,
  FIRST_ACTIONS,
  SITE_GROUPS,
  POINT_SOURCE_CONNECT_BOOST,
  POINT_SOURCE_REFERRAL_BOOST,
  POINT_SOURCE_FIRST_ACTION,
  POINT_SOURCE_RAFFLE,
  EXCLUSIVE_TEMPLATES,
  parseDraft,
  applyCopyFields,
  assertPublishable,
  isActiveNow,
  findScheduleConflict,
  conflictMessage,
  toPublicCard,
  validateCta,
  stripText,
  salePoints,
  normalizeCrawlerSource,
};
