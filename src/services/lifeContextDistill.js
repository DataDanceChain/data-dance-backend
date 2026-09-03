const prisma = require('../utils/prisma');
const { DEFAULT_BOUNDARIES } = require('../constants/lifeContext');
const { cleanCrawlerTraces, generateRefinedPortrait } = require('./lifeContextGemini');
const { getSettings, saveRefined } = require('./lifeContextSettings');

const MAX_ROWS = 400;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'your', 'this', 'that', 'pack', 'set',
  'size', 'new', 'black', 'white', 'of', 'in', 'to', 'on', 'a', 'an',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\d{3}-\d{7}-\d{7}/g, ' ')
    .replace(/\b(?:order|confirmation|booking|reservation)\s*(?:id|#|no\.?|number)?\s*[:#-]?\s*[\w-]{4,}\b/gi, ' ')
    .replace(/[€£$¥￥]\s?[\d,.]+/g, ' ')
    .replace(/\b(?:usd|eur|gbp|cny|hkd|sgd|jpy)\s*[\d,.]+\b/gi, ' ')
    .replace(/\b[\d,.]+\s*(?:usd|eur|gbp|cny|hkd|sgd|jpy)\b/gi, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cityFrom(payload, metadata) {
  const p = asObject(payload);
  const m = asObject(metadata);
  const raw =
    p.city ||
    p.location ||
    p.destination ||
    p.hotelCity ||
    p.area ||
    p.region ||
    p.country ||
    m.city ||
    m.location ||
    '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

function titleFrom(payload) {
  const p = asObject(payload);
  return cleanTitle(
    p.productTitle || p.title || p.name || p.bookingName || p.hotelName || p.listingTitle || p.eventName || '',
  );
}

function themeTokens(title) {
  return title
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 3);
}

function topCounts(values, limit) {
  const map = new Map();
  for (const value of values) {
    const key = String(value || '').trim();
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function monthKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function describeCadence(timestamps) {
  const months = topCounts(timestamps.map(monthKey).filter(Boolean), 12);
  if (months.length === 0) return 'No dated traces yet.';
  if (months.length === 1) return `Activity clustered in ${months[0].label}.`;
  const peak = months[0];
  const quiet = months[months.length - 1];
  return `Bursts around ${peak.label} (${peak.count} traces), quieter near ${quiet.label}.`;
}

function scorePrecision(portrait) {
  const sources = portrait.platforms.length;
  const records = portrait.recordCount;
  const themes =
    portrait.shoppingThemes.length + portrait.travelPlaces.length + portrait.eventThemes.length;
  const score = Math.round(
    Math.min(100, Math.min(sources, 4) * 12 + Math.min(records, 80) * 0.4 + Math.min(themes, 12) * 1.7),
  );
  const labels = portrait.platforms.map((row) => row.label);
  const missing = [];
  if (!labels.includes('amazon')) missing.push('shopping');
  if (!labels.includes('airbnb') && !labels.includes('booking')) missing.push('travel');
  if (!labels.includes('luma')) missing.push('events');

  let band = 'empty';
  if (score >= 86) band = 'sharp';
  else if (score >= 61) band = 'precise';
  else if (score >= 31) band = 'focus';
  else if (score > 0) band = 'sketch';

  return { score, band, missing };
}

function emptyPortrait() {
  const portrait = {
    publicProfile: { displayName: '', handle: '', publicBio: '' },
    platforms: [],
    shoppingThemes: [],
    travelPlaces: [],
    eventThemes: [],
    sampleTitles: [],
    cadence: 'No lifestyle traces synced yet.',
    recordCount: 0,
    lastSyncedAt: null,
  };
  return { ...portrait, precision: scorePrecision(portrait) };
}

function distillRows(user, rows) {
  const platforms = topCounts(rows.map((row) => row.source), 8);
  const shopping = rows.filter((row) => row.source === 'amazon');
  const travel = rows.filter((row) => row.source === 'airbnb' || row.source === 'booking');
  const events = rows.filter((row) => row.source === 'luma');

  const shoppingThemes = topCounts(
    shopping.flatMap((row) => themeTokens(titleFrom(row.payload))),
    8,
  );
  const travelPlaces = topCounts(
    travel.map((row) => cityFrom(row.payload, row.metadata)).filter(Boolean),
    8,
  );
  const eventThemes = topCounts(
    events.flatMap((row) => themeTokens(titleFrom(row.payload))),
    8,
  );
  const sampleTitles = rows
    .map((row) => titleFrom(row.payload))
    .filter(Boolean)
    .slice(0, 8);

  const portrait = {
    publicProfile: {
      displayName: user.name || '',
      handle: user.xUsername ? `@${user.xUsername}` : '',
      publicBio: user.description || '',
    },
    platforms,
    shoppingThemes,
    travelPlaces,
    eventThemes,
    sampleTitles,
    cadence: describeCadence(rows.map((row) => row.timestamp || row.createdAt)),
    recordCount: rows.length,
    lastSyncedAt: rows[0] ? (rows[0].createdAt || rows[0].timestamp) : null,
  };
  return { ...portrait, precision: scorePrecision(portrait) };
}

async function loadPortraitRows(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, description: true, xUsername: true },
  });
  if (!user) return { user: null, rows: [], portrait: emptyPortrait() };

  const rows = await prisma.crawlerData.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
    select: {
      id: true,
      source: true,
      type: true,
      timestamp: true,
      createdAt: true,
      payload: true,
      metadata: true,
    },
  });

  return { user, rows, portrait: distillRows(user, rows) };
}

async function loadPortrait(userId) {
  const { portrait } = await loadPortraitRows(userId);
  return portrait;
}

async function loadVault(userId) {
  const groups = await prisma.crawlerData.groupBy({
    by: ['source'],
    where: { userId },
    _count: { source: true },
    _max: { createdAt: true },
  });
  const sources = groups
    .map((row) => ({
      source: row.source,
      count: row._count.source,
      lastAt: row._max.createdAt,
    }))
    .sort((a, b) => b.count - a.count);
  return {
    sources,
    total: sources.reduce((sum, row) => sum + row.count, 0),
    lastAt: sources.reduce((latest, row) => {
      if (!row.lastAt) return latest;
      if (!latest || row.lastAt > latest) return row.lastAt;
      return latest;
    }, null),
  };
}

function isObviouslyDirtyTitle(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 4) return 'empty or too short';
  if (
    /^(your orders|buy again|add to cart|sign in|log in|account|cart|search|next|previous|see all|trips|amazon\.com|booking\.com|登录|购物车|首页)$/i.test(
      text,
    )
  ) {
    return 'page chrome';
  }
  if (/^order\s/i.test(text) && text.split(/\s+/).length <= 3) return 'order id only';
  return '';
}

async function refinePortrait(userId, locale) {
  const { user, rows } = await loadPortraitRows(userId);
  if (!rows.length) {
    const error = new Error('Share data on Earn before extracting a portrait.');
    error.code = 'NO_TRACES';
    throw error;
  }
  const traces = rows.map((row, index) => ({
    id: row.id || `row-${index}`,
    source: row.source || 'other',
    title: titleFrom(row.payload),
  }));
  const obviousDrop = [];
  const candidates = [];
  for (const row of traces) {
    const reason = isObviouslyDirtyTitle(row.title);
    if (reason) obviousDrop.push({ id: row.id, reason });
    else candidates.push(row);
  }
  const cleaned = await cleanCrawlerTraces(candidates, locale);
  const keepIds = new Set(cleaned.keep.map((row) => row.id));
  const cleanedRows = rows.filter((row, index) => keepIds.has(row.id || `row-${index}`));
  const workingRows = cleanedRows.length ? cleanedRows : rows;
  const portrait = distillRows(user, workingRows);
  const settings = await getSettings(userId);
  const { refined, model } = await generateRefinedPortrait(
    { ...buildRefineBrief(portrait, workingRows), aboutMe: (settings.aboutMe || '').trim() },
    locale,
  );
  refined.cleanKept = workingRows.length;
  refined.cleanDropped = traces.length - workingRows.length;
  const titleById = new Map(traces.map((row) => [row.id, row.title]));
  refined.cleanDroppedSamples = [...obviousDrop, ...cleaned.drop].slice(0, 8).map((item) => ({
    id: item.id,
    title: titleById.get(item.id) || '',
    reason: item.reason,
  }));
  return saveRefined(userId, refined, model);
}

function buildRefineBrief(portrait, rows) {
  const titlesBySource = {};
  for (const row of rows) {
    const source = row.source || 'other';
    if (!titlesBySource[source]) titlesBySource[source] = [];
    const title = titleFrom(row.payload);
    if (title && titlesBySource[source].length < 24) titlesBySource[source].push(title);
  }
  return {
    cadence: portrait.cadence,
    sources: portrait.platforms,
    shoppingThemes: portrait.shoppingThemes,
    travelPlaces: portrait.travelPlaces,
    eventThemes: portrait.eventThemes,
    titlesBySource,
    titles: rows.map((row) => titleFrom(row.payload)).filter(Boolean).slice(0, 80),
    kept: rows.length,
  };
}

function renderPublicProfile(portrait) {
  const p = portrait.publicProfile;
  return [
    '# Public profile',
    '',
    `- Display name: ${p.displayName || '(not set)'}`,
    `- Handle: ${p.handle || '(not set)'}`,
    '',
    p.publicBio || '_No public bio yet._',
    '',
    portrait.platforms.length
      ? `Connected life sources: ${portrait.platforms.map((x) => x.label).join(', ')}.`
      : 'No life sources connected yet.',
  ].join('\n');
}

function renderBoundaries(settings, portrait) {
  const custom = (settings?.customBoundaries || '').trim() || DEFAULT_BOUNDARIES;
  const parts = ['# Sharing boundaries', '', custom];
  if (settings?.privacyLevel) {
    parts.push('', `_Active share level: ${settings.privacyLevel}._`);
  }
  if (portrait?.recordCount) {
    parts.push('', `_Portrait built from ${portrait.recordCount} distilled traces (no raw receipts)._`);
  }
  return parts.join('\n');
}

function formatThemes(rows, empty) {
  if (!rows.length) return empty;
  return rows.map((row) => `- ${row.label} (${row.count})`).join('\n');
}

function renderLifeCapsule(settings, portrait) {
  const level = settings?.privacyLevel || 'transparent';
  const profile = renderPublicProfile(portrait);
  if (level === 'public') {
    return [
      profile,
      '',
      '## Life capsule',
      '',
      portrait.recordCount
        ? 'A lifestyle portrait is ready, but the share level is **public**. Only identity and connected sources are visible.'
        : 'No distilled lifestyle portrait yet. Ask the user to share Amazon, Airbnb, Booking, or Luma traces in Data Dance.',
    ].join('\n');
  }

  const refined = settings?.refined;
  const aboutMe = (settings?.aboutMe || '').trim();
  const body = [
    profile,
    '',
  ];
  if (aboutMe) {
    body.push('## About me (written by the user)', '', aboutMe, '');
  }
  if (refined?.handoff?.length) {
    body.push('## Handoff bullets for other LLMs', '', ...refined.handoff.map((item) => `- ${item}`), '');
  }
  if (refined?.portrait || refined?.background) {
    body.push('## Integrated portrait of you', '', refined.portrait || refined.background, '');
  }
  if (refined?.focus?.length) {
    body.push('## Focus', '', refined.focus.map((item) => `- ${item}`).join('\n'), '');
  }
  if (refined?.paste && refined.paste !== refined.portrait) {
    body.push('## Paste-ready background', '', refined.paste, '');
  }
  if (refined?.summary && refined.summary !== refined.portrait) {
    body.push('## Snapshot', '', refined.summary, '');
  }
  if (refined?.unknowns?.length) {
    body.push('## Open questions', '', ...refined.unknowns.map((item) => `- ${item}`), '');
  }
  body.push(
    '## Rhythm',
    '',
    portrait.cadence,
    '',
    '## Shopping themes',
    '',
    formatThemes(portrait.shoppingThemes, '_No shopping traces._'),
    '',
    '## Travel places',
    '',
    formatThemes(portrait.travelPlaces, '_No travel traces._'),
    '',
    '## Event themes',
    '',
    formatThemes(portrait.eventThemes, '_No event traces._'),
  );

  if (level === 'intimate' && portrait.sampleTitles.length) {
    body.push('', '## Example titles (no prices or IDs)', '', ...portrait.sampleTitles.map((t) => `- ${t}`));
  }

  body.push(
    '',
    `_Shared as ${level} · ${portrait.recordCount} traces · Gemini portrait when extracted._`,
  );
  return body.join('\n');
}

function searchLifeSignals(settings, portrait, query) {
  const q = String(query || '').trim();
  if (!q) return 'Pass a short question or keyword, for example “travel”, “gifts”, or “Kyoto”.';
  const level = settings?.privacyLevel || 'transparent';
  const hay = [];
  hay.push(...portrait.platforms.map((x) => x.label));
  if (level !== 'public') {
    if (settings?.aboutMe) hay.push(settings.aboutMe);
    hay.push(...portrait.shoppingThemes.map((x) => x.label));
    hay.push(...portrait.travelPlaces.map((x) => x.label));
    hay.push(...portrait.eventThemes.map((x) => x.label));
    hay.push(portrait.cadence);
    if (settings?.refined) {
      hay.push(
        settings.refined.summary,
        settings.refined.portrait,
        settings.refined.paste || settings.refined.background,
        settings.refined.shopping,
        settings.refined.travel,
        settings.refined.events,
        ...(settings.refined.handoff || []),
        ...(settings.refined.focus || []),
        ...(settings.refined.unknowns || []),
        ...(settings.refined.shoppingEvidence || []),
        ...(settings.refined.travelEvidence || []),
        ...(settings.refined.eventEvidence || []),
      );
    }
  }
  if (level === 'intimate') hay.push(...portrait.sampleTitles);

  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const hits = hay.filter((line) => terms.some((term) => String(line).toLowerCase().includes(term)));
  if (!hits.length) {
    return `No lifestyle signals matched “${q}” at share level ${level}.`;
  }
  return [`# Search · ${q}`, '', `Share level: ${level}`, '', ...hits.slice(0, 12).map((h) => `- ${h}`)].join('\n');
}

module.exports = {
  loadPortrait,
  loadPortraitRows,
  loadVault,
  refinePortrait,
  buildRefineBrief,
  distillRows,
  scorePrecision,
  renderPublicProfile,
  renderBoundaries,
  renderLifeCapsule,
  searchLifeSignals,
  emptyPortrait,
};
