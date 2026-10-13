/**
 * Campaign copy in the product's languages. Every Chinese tag (zh, zh-CN, zh-Hans, zh-SG, zh-TW,
 * zh-Hant, zh-HK) is zh-TW. Simplified copy saved before (a `zh` key, titleZh) is only a fallback
 * for zh-TW: copy under a Traditional tag always wins over it.
 */
const LOCALES = ['en', 'zh-TW', 'ja', 'ko'];

const LOCALE_NAMES = {
  en: 'English',
  'zh-TW': 'Traditional Chinese (Taiwan)',
  ja: 'Japanese',
  ko: 'Korean',
};

function localeTag(raw) {
  return String(raw || '')
    .trim()
    .replace(/_/g, '-')
    .toLowerCase();
}

function normalizeLocale(raw) {
  const primary = localeTag(raw).split('-')[0];
  if (primary === 'zh') return 'zh-TW';
  if (primary === 'ja' || primary === 'ko' || primary === 'en') return primary;
  return '';
}

/** A Chinese tag that names Traditional script (zh-TW, zh-Hant, zh-HK, zh-MO and longer forms). */
function isTraditionalTag(raw) {
  return /^zh-(?:tw|hant|hk|mo)(?:-|$)/.test(localeTag(raw));
}

function emptyMap() {
  return { en: '', 'zh-TW': '', ja: '', ko: '' };
}

function cleanCopy(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * One locale map from several, keyed by any language tag: per locale the first filled value
 * wins. For zh-TW a Traditional-tagged value from any of the maps wins over a Simplified one.
 */
function mergeMaps(...maps) {
  const out = emptyMap();
  let simplified = '';
  maps.forEach((map) => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return;
    Object.entries(map).forEach(([key, raw]) => {
      const locale = normalizeLocale(key);
      const text = cleanCopy(raw);
      if (!locale || !text) return;
      if (locale === 'zh-TW' && !isTraditionalTag(key)) {
        if (!simplified) simplified = text;
        return;
      }
      if (!out[locale]) out[locale] = text;
    });
  });
  if (!out['zh-TW']) out['zh-TW'] = simplified;
  return out;
}

function asMap(value) {
  return mergeMaps(value);
}

function firstFilled(map) {
  return LOCALES.map((locale) => map[locale]).find(Boolean) || '';
}

function pickFromMap(map, language, fallback = '') {
  const locale = normalizeLocale(language) || 'en';
  const row = asMap(map);
  if (locale === 'en') return row.en || row['zh-TW'] || fallback;
  return row[locale] || row.en || fallback;
}

/** `${prefix}En`, `${prefix}ZhTw`, ... fields of a form body, keyed by their language tags. */
function readSuffixed(body, prefix) {
  const read = (...suffixes) => cleanCopy(suffixes.map((suffix) => body[`${prefix}${suffix}`]).find(Boolean));
  return {
    en: read('En', '_en'),
    'zh-TW': read('ZhTw', 'ZhTW', '_zhTw'),
    zh: read('Zh', '_zh'),
    ja: read('Ja', '_ja'),
    ko: read('Ko', '_ko'),
  };
}

function bodyHasPrefix(body, prefix) {
  return ['En', 'Zh', 'Ja', 'ZhTw', 'ZhTW', 'Ko'].some((suffix) =>
    Object.prototype.hasOwnProperty.call(body || {}, `${prefix}${suffix}`),
  );
}

function buildCampaignI18n(body = {}, core = {}) {
  const existing = body.i18n && typeof body.i18n === 'object' ? body.i18n : body.config?.i18n || {};
  const source = normalizeLocale(body.copySource || existing.source) || 'en';
  const title = mergeMaps(existing.title, readSuffixed(body, 'title'), {
    en: core.titleEn || '',
    zh: core.titleZh || '',
  });
  const blurb = mergeMaps(existing.blurb, readSuffixed(body, 'blurb'), {
    en: core.blurbEn || '',
    zh: core.blurbZh || '',
  });
  const pillExplicit = {
    en: core.pillEn || '',
    zh: core.pillZh || '',
  };
  const pill = bodyHasPrefix(body, 'pill')
    ? mergeMaps(readSuffixed(body, 'pill'), pillExplicit)
    : mergeMaps(existing.pill, readSuffixed(body, 'pill'), pillExplicit);
  const shareText = mergeMaps(existing.shareText, readSuffixed(body, 'shareText'), readSuffixed(body.config || {}, 'shareText'));
  const perkNote = mergeMaps(existing.perkNote, readSuffixed(body, 'perkNote'), readSuffixed(body.config || {}, 'perkNote'));
  const questions = [1, 2, 3].map((index) =>
    mergeMaps(existing[`question${index}`], readSuffixed(body, `question${index}`), readSuffixed(body.config || {}, `question${index}`)),
  );
  return {
    source,
    title,
    blurb,
    pill,
    shareText,
    perkNote,
    question1: questions[0],
    question2: questions[1],
    question3: questions[2],
  };
}

function pickQuestion(config, index, language) {
  const i18n = config?.i18n || {};
  const legacy =
    normalizeLocale(language) === 'zh-TW'
      ? config?.[`question${index}ZhTw`] || config?.[`question${index}Zh`]
      : config?.[`question${index}En`];
  return pickFromMap(i18n[`question${index}`], language, legacy);
}

module.exports = {
  LOCALES,
  LOCALE_NAMES,
  normalizeLocale,
  isTraditionalTag,
  emptyMap,
  asMap,
  mergeMaps,
  firstFilled,
  pickFromMap,
  buildCampaignI18n,
  pickQuestion,
};
