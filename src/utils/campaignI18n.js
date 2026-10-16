/**
 * Campaign copy in the product's languages. Every Chinese tag (zh, zh-CN, zh-Hans, zh-SG, zh-TW,
 * zh-Hant, zh-HK) reads as zh-TW. Copy written in Simplified Chinese (a `zh` key, titleZh) is kept
 * in its own `zh` slot and never stored under zh-TW: readers fall back to it for zh-TW only when
 * there is no Traditional copy.
 */
const LOCALES = ['en', 'zh-TW', 'ja', 'ko'];

/** The slot that holds Simplified Chinese copy, next to the product locales. */
const SIMPLIFIED = 'zh';

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

/**
 * The slot copy under this tag is stored in: zh-TW for a Traditional tag, `zh` for any other
 * Chinese tag (Simplified), en, ja or ko; '' for other languages.
 */
function copyKey(raw) {
  const locale = normalizeLocale(raw);
  if (locale === 'zh-TW' && !isTraditionalTag(raw)) return SIMPLIFIED;
  return locale;
}

/** The language a campaign's copy was written in: a product locale, or `zh` for Simplified. */
function sourceLocale(raw) {
  return copyKey(raw) || 'en';
}

function emptyMap() {
  return { en: '', 'zh-TW': '', ja: '', ko: '' };
}

function cleanCopy(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function isMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One stored locale map from several, keyed by any language tag: per slot the first filled
 * value wins, so callers list the maps from the highest priority down. Simplified copy goes to the
 * `zh` slot (present only when filled) and never fills zh-TW.
 */
function mergeMaps(...maps) {
  const out = emptyMap();
  let simplified = '';
  maps.forEach((map) => {
    if (!isMap(map)) return;
    Object.entries(map).forEach(([key, raw]) => {
      const slot = copyKey(key);
      const text = cleanCopy(raw);
      if (!slot || !text) return;
      if (slot === SIMPLIFIED) {
        if (!simplified) simplified = text;
        return;
      }
      if (!out[slot]) out[slot] = text;
    });
  });
  if (simplified) out[SIMPLIFIED] = simplified;
  return out;
}

/** A map to read from: the four locales, with zh-TW falling back to Simplified copy. */
function asMap(value) {
  const { [SIMPLIFIED]: simplified = '', ...row } = mergeMaps(value);
  if (!row['zh-TW']) row['zh-TW'] = simplified;
  return row;
}

function firstFilled(map) {
  return [...LOCALES, SIMPLIFIED].map((key) => map?.[key]).find(Boolean) || '';
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

/**
 * The one-language form fields (titleEn, titleZh, question1Zh, ...) are filled from columns that
 * hold another language's copy when their own is empty. Such a value coming back, for a slot the
 * stored map leaves empty, is that fallback and not copy for the slot, so it is not kept. A slot
 * found to echo in one form map is dropped from the later ones too (the same field, trimmed).
 */
function withoutFallbacks(fields, saved, echoed) {
  const out = {};
  Object.entries(fields).forEach(([key, raw]) => {
    const slot = copyKey(key);
    const text = cleanCopy(raw);
    const echo =
      Boolean(text) &&
      (slot === 'en' || slot === SIMPLIFIED) &&
      !saved[slot] &&
      (echoed.has(slot) || Object.entries(saved).some(([other, value]) => other !== slot && value === text));
    if (echo) echoed.add(slot);
    out[key] = echo ? '' : text;
  });
  return out;
}

/**
 * The i18n block saved with a campaign. Copy from the form outranks the stored block (body.i18n
 * or body.config.i18n), so an edit of a filled language is kept; a language the form leaves empty
 * keeps its stored copy. The source is stored by the translate rule, so a `zh` pick stays `zh`.
 */
function buildCampaignI18n(body = {}, core = {}) {
  const stored = isMap(body.i18n) ? body.i18n : isMap(body.config?.i18n) ? body.config.i18n : {};
  const config = isMap(body.config) ? body.config : {};
  const source = sourceLocale(body.copySource || stored.source);
  const copy = (key, forms, keepStored = true) => {
    const saved = mergeMaps(stored[key]);
    const echoed = new Set();
    const fresh = forms.map((form) => withoutFallbacks(form, saved, echoed));
    return keepStored ? mergeMaps(...fresh, saved) : mergeMaps(...fresh);
  };
  const title = copy('title', [readSuffixed(body, 'title'), { en: core.titleEn, zh: core.titleZh }]);
  const blurb = copy('blurb', [readSuffixed(body, 'blurb'), { en: core.blurbEn, zh: core.blurbZh }]);
  // A form that sends any pill field owns the pill: clearing it falls back to the end-date pill.
  const pill = copy('pill', [readSuffixed(body, 'pill'), { en: core.pillEn, zh: core.pillZh }], !bodyHasPrefix(body, 'pill'));
  const fromForm = (key) => copy(key, [readSuffixed(body, key), readSuffixed(config, key)]);
  return {
    source,
    title,
    blurb,
    pill,
    shareText: fromForm('shareText'),
    perkNote: fromForm('perkNote'),
    question1: fromForm('question1'),
    question2: fromForm('question2'),
    question3: fromForm('question3'),
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
  SIMPLIFIED,
  normalizeLocale,
  isTraditionalTag,
  copyKey,
  sourceLocale,
  emptyMap,
  asMap,
  mergeMaps,
  firstFilled,
  pickFromMap,
  buildCampaignI18n,
  pickQuestion,
};
