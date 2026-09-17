const LOCALES = ['en', 'zh', 'zh-TW', 'ja'];

const LOCALE_NAMES = {
  en: 'English',
  zh: 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese (Taiwan)',
  ja: 'Japanese',
};

function normalizeLocale(raw) {
  const text = String(raw || '')
    .trim()
    .replace('_', '-');
  const lower = text.toLowerCase();
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hant') || lower.startsWith('zh-hk')) return 'zh-TW';
  if (lower === 'ja' || lower.startsWith('ja-')) return 'ja';
  if (lower === 'zh' || lower.startsWith('zh-cn') || lower.startsWith('zh-hans') || lower.startsWith('zh-sg')) {
    return 'zh';
  }
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return '';
}

function emptyMap() {
  return { en: '', zh: '', 'zh-TW': '', ja: '' };
}

function asMap(value) {
  const out = emptyMap();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  Object.entries(value).forEach(([key, raw]) => {
    const locale = normalizeLocale(key);
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (locale && text) out[locale] = text;
  });
  return out;
}

function firstFilled(map) {
  return LOCALES.map((locale) => map[locale]).find(Boolean) || '';
}

function pickFromMap(map, language, fallback = '') {
  const locale = normalizeLocale(language) || 'en';
  const row = asMap(map);
  if (locale === 'ja') return row.ja || row.en || fallback;
  if (locale === 'zh-TW') return row['zh-TW'] || row.zh || row.en || fallback;
  if (locale === 'zh') return row.zh || row.en || fallback;
  return row.en || row.zh || fallback;
}

function readSuffixed(body, prefix) {
  const map = emptyMap();
  map.en = String(body[`${prefix}En`] || body[`${prefix}_en`] || '').replace(/\s+/g, ' ').trim();
  map.zh = String(body[`${prefix}Zh`] || body[`${prefix}_zh`] || '').replace(/\s+/g, ' ').trim();
  map.ja = String(body[`${prefix}Ja`] || body[`${prefix}_ja`] || '').replace(/\s+/g, ' ').trim();
  map['zh-TW'] = String(body[`${prefix}ZhTw`] || body[`${prefix}ZhTW`] || body[`${prefix}_zhTw`] || '').replace(/\s+/g, ' ').trim();
  return map;
}

function mergeMaps(...maps) {
  const out = emptyMap();
  maps.forEach((map) => {
    LOCALES.forEach((locale) => {
      if (map?.[locale] && !out[locale]) out[locale] = map[locale];
    });
  });
  return out;
}

function buildCampaignI18n(body = {}, core = {}) {
  const existing = body.i18n && typeof body.i18n === 'object' ? body.i18n : body.config?.i18n || {};
  const source = normalizeLocale(body.copySource || existing.source) || 'en';
  const title = mergeMaps(asMap(existing.title), readSuffixed(body, 'title'), {
    en: core.titleEn || '',
    zh: core.titleZh || '',
    ja: '',
    'zh-TW': '',
  });
  const blurb = mergeMaps(asMap(existing.blurb), readSuffixed(body, 'blurb'), {
    en: core.blurbEn || '',
    zh: core.blurbZh || '',
    ja: '',
    'zh-TW': '',
  });
  const pill = mergeMaps(asMap(existing.pill), readSuffixed(body, 'pill'), {
    en: core.pillEn || '',
    zh: core.pillZh || '',
    ja: '',
    'zh-TW': '',
  });
  const shareText = mergeMaps(asMap(existing.shareText), readSuffixed(body, 'shareText'), readSuffixed(body.config || {}, 'shareText'));
  const perkNote = mergeMaps(asMap(existing.perkNote), readSuffixed(body, 'perkNote'), readSuffixed(body.config || {}, 'perkNote'));
  const questions = [1, 2, 3].map((index) =>
    mergeMaps(asMap(existing[`question${index}`]), readSuffixed(body, `question${index}`), readSuffixed(body.config || {}, `question${index}`)),
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
  return pickFromMap(i18n[`question${index}`], language, String(language || '').toLowerCase().includes('zh') ? config[`question${index}Zh`] : config[`question${index}En`]);
}

module.exports = {
  LOCALES,
  LOCALE_NAMES,
  normalizeLocale,
  emptyMap,
  asMap,
  firstFilled,
  pickFromMap,
  buildCampaignI18n,
  pickQuestion,
};
