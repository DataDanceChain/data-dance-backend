const { lookupCity } = require('../constants/cityCoordinates');

const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || process.env.REACT_APP_MAPBOX_TOKEN || '';

const cache = new Map();

function titleCase(value) {
  return String(value || '')
    .split(/[\s/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function cityFromFeature(feature) {
  if (!feature || typeof feature !== 'object') return null;
  const center = feature.center;
  if (!Array.isArray(center) || center.length < 2) return null;
  const types = Array.isArray(feature.place_type) ? feature.place_type : [];
  const context = Array.isArray(feature.context) ? feature.context : [];
  const contextOf = (prefix) =>
    context.find((item) => String(item.id || '').startsWith(prefix))?.text || '';
  const label =
    (types.includes('place') || types.includes('locality') ? feature.text : '') ||
    contextOf('place') ||
    contextOf('locality') ||
    contextOf('district') ||
    feature.text ||
    '';
  const country = contextOf('country') || (types.includes('country') ? feature.text : '');
  if (!label) return null;
  return {
    label,
    country: country || '',
    lat: Number(center[1]),
    lng: Number(center[0]),
  };
}

async function mapboxGeocode(path, params = {}) {
  const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${path}.json`);
  url.searchParams.set('access_token', MAPBOX_TOKEN);
  url.searchParams.set('limit', '1');
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return cityFromFeature(Array.isArray(json?.features) ? json.features[0] : null);
}

async function resolveStayPlace(hint) {
  if (!hint) return null;
  const cacheKey = `${hint.kind}:${hint.query || ''}:${hint.lat ?? ''}:${hint.lng ?? ''}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let hit = null;
  try {
    if (hint.kind === 'coords' && hint.lat != null && hint.lng != null) {
      hit = await mapboxGeocode(`${hint.lng},${hint.lat}`, { types: 'place,locality,region' });
    } else if (hint.query) {
      hit = lookupCity(hint.query);
      if (!hit) {
        const types = hint.kind === 'address' ? 'address,place,locality,region' : 'place,locality,region,country';
        hit = await mapboxGeocode(encodeURIComponent(hint.query), { types });
      }
    }
  } catch {
    hit = null;
  }

  cache.set(cacheKey, hit);
  return hit;
}

module.exports = {
  titleCase,
  cityFromFeature,
  resolveStayPlace,
};
