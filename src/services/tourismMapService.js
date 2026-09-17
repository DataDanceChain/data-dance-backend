const prisma = require('../utils/prisma');
const { rewardEligibleUploadWhere } = require('../utils/firstValidUpload');
const { resolveStayBonusRules } = require('../utils/stayBonus');
const { isStayBonusEligibleItem } = require('../utils/summerTravelEligibility');
const { queryStayPlace, nightsFromStayPayload } = require('../utils/stayPlaces');
const { resolveStayPlace, titleCase } = require('../utils/stayGeocode');

const PREVIEW_DESTINATIONS = [
  { label: 'Tokyo', country: 'Japan', lat: 35.6762, lng: 139.6503, nights: 4, stays: 1 },
  { label: 'Los Angeles', country: 'United States', lat: 34.0522, lng: -118.2437, nights: 3, stays: 1 },
  { label: 'Barcelona', country: 'Spain', lat: 41.3874, lng: 2.1686, nights: 5, stays: 1 },
  { label: 'Bangkok', country: 'Thailand', lat: 13.7563, lng: 100.5018, nights: 3, stays: 1 },
  { label: 'Paris', country: 'France', lat: 48.8566, lng: 2.3522, nights: 2, stays: 1 },
  { label: 'Hong Kong', country: 'Hong Kong', lat: 22.3193, lng: 114.1694, nights: 2, stays: 1 },
];

function pickRows(rows, rules) {
  const eligible = rules ? rows.filter((row) => isStayBonusEligibleItem(row, rules)) : [];
  if (eligible.length) return eligible;
  return rows.filter((row) => queryStayPlace(row.payload, row.metadata));
}

function packPayload(destinations, { preview, sites, stayStartDate, stayEndDate }) {
  const countries = new Set(destinations.map((item) => item.country).filter(Boolean));
  return {
    title: preview ? 'SUMMER PREVIEW' : 'MY SUMMER 2026',
    hasStays: destinations.length > 0,
    preview,
    destinations,
    stats: {
      destinationCount: destinations.length,
      countryCount: countries.size,
      nights: destinations.reduce((sum, item) => sum + item.nights, 0),
      stayCount: destinations.reduce((sum, item) => sum + item.stays, 0),
    },
    sites,
    stayStartDate,
    stayEndDate,
  };
}

async function getTourismMap(userId) {
  const rules = await resolveStayBonusRules();
  const sites = rules?.sites?.length ? rules.sites : ['airbnb', 'booking'];
  const rows = await prisma.crawlerData.findMany({
    where: rewardEligibleUploadWhere({
      userId,
      source: { in: sites },
    }),
    select: { id: true, source: true, payload: true, metadata: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 400,
  });
  const chosen = pickRows(rows, rules);
  const grouped = new Map();
  for (const row of chosen) {
    const hint = queryStayPlace(row.payload, row.metadata);
    if (!hint) continue;
    const geo = await resolveStayPlace(hint);
    const place = hint.query || '';
    const key = geo ? `${geo.label}|${geo.country}` : place.toLowerCase();
    const current = grouped.get(key) || {
      label: geo?.label || titleCase(place.split(',')[0]),
      country: geo?.country || '',
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
      nights: 0,
      stays: 0,
    };
    current.nights += nightsFromStayPayload(row.payload);
    current.stays += 1;
    grouped.set(key, current);
  }
  const destinations = [...grouped.values()].sort((a, b) => b.nights - a.nights);
  const meta = {
    sites,
    stayStartDate: rules?.stayStartDate || null,
    stayEndDate: rules?.stayEndDate || null,
  };
  if (destinations.length) return packPayload(destinations, { preview: false, ...meta });
  return packPayload(PREVIEW_DESTINATIONS, { preview: true, ...meta });
}

module.exports = {
  getTourismMap,
};
