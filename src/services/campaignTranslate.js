const { callGeminiJson, defaultGeminiModel } = require('./lifeContextGemini');
const {
  LOCALES,
  LOCALE_NAMES,
  normalizeLocale,
  isTraditionalTag,
  emptyMap,
  mergeMaps,
} = require('../utils/campaignI18n');

const STRING_KEYS = ['title', 'blurb', 'pill', 'shareText', 'perkNote', 'question1', 'question2', 'question3'];

function cleanString(value, max) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 400);
}

/** Source copy in Simplified Chinese: the `zh` key, which every product map reads as a zh-TW fallback. */
const SIMPLIFIED_SOURCE = 'zh';

/**
 * The source language of the copy. A Chinese tag that does not name Traditional script (zh, zh-CN,
 * zh-Hans, ...) is Simplified copy: it is not the zh-TW text, so zh-TW stays a translation target.
 */
function sourceLocale(raw) {
  const locale = normalizeLocale(raw) || 'en';
  if (locale === 'zh-TW' && !isTraditionalTag(raw)) return SIMPLIFIED_SOURCE;
  return locale;
}

function sourceName(source) {
  return source === SIMPLIFIED_SOURCE ? 'Simplified Chinese' : LOCALE_NAMES[source] || source;
}

function collectStrings(body) {
  const source = sourceLocale(body.source || body.copySource);
  const raw = body.strings && typeof body.strings === 'object' ? body.strings : body;
  const strings = {};
  STRING_KEYS.forEach((key) => {
    const text = cleanString(raw[key], key === 'blurb' || key === 'perkNote' || key === 'shareText' ? 280 : 160);
    if (text) strings[key] = text;
  });
  const prizeRaw = Array.isArray(body.prizeLabels)
    ? body.prizeLabels
    : Array.isArray(raw.prizeLabels)
      ? raw.prizeLabels
      : [];
  const prizeLabels = prizeRaw.map((item) => cleanString(item, 80)).filter(Boolean).slice(0, 8);
  if (!strings.title) {
    const error = new Error('Write a title in the source language first');
    error.code = 'BAD_TRANSLATE';
    throw error;
  }
  return { source, strings, prizeLabels };
}

function emptyBundle() {
  const bundle = {};
  STRING_KEYS.forEach((key) => {
    bundle[key] = emptyMap();
  });
  return bundle;
}

function applyParsed(parsed, source, strings, prizeLabels) {
  const nested = parsed?.strings && typeof parsed.strings === 'object' ? parsed.strings : {};
  const bundle = emptyBundle();
  STRING_KEYS.forEach((key) => {
    if (!strings[key]) {
      delete bundle[key];
      return;
    }
    bundle[key] = withSource(source, strings[key], parsed?.[key], nested[key]);
  });
  const prizeSource = Array.isArray(parsed?.prizeLabels) ? parsed.prizeLabels : nested.prizeLabels;
  bundle.prizeLabels = prizeLabels.map((label, index) =>
    withSource(source, label, Array.isArray(prizeSource) ? prizeSource[index] : prizeSource?.[index]),
  );
  return bundle;
}

/**
 * The translated maps with the source text kept as written. A product-language source always
 * wins for its own locale; Simplified source text goes in first, so a Traditional translation wins
 * zh-TW over it and the Simplified text is only the fallback when the model returns none.
 */
function withSource(source, text, ...translated) {
  if (source === SIMPLIFIED_SOURCE) return mergeMaps({ [source]: text }, ...translated);
  const map = mergeMaps(...translated);
  map[source] = text;
  return map;
}

function translatePrompt(source, strings, prizeLabels) {
  const targets = LOCALES.filter((locale) => locale !== source);
  return [
    'Translate Wallet campaign copy for DataDance.',
    `Source language: ${sourceName(source)} (${source}).`,
    `Fill these locales: ${targets.map((locale) => `${LOCALE_NAMES[locale]} (${locale})`).join(', ')}.`,
    'Keep meaning, tone, and length close to the source.',
    'Keep brand and product names: DataDance, Wallet, Airbnb, Booking, Amazon, Connect, Life Capsule.',
    'zh-TW is Traditional Chinese used in Taiwan, not a character-by-character conversion if a natural Taiwan phrase is better.',
    source === SIMPLIFIED_SOURCE ? 'The source is Simplified Chinese: write zh-TW in Traditional Chinese characters, never the Simplified text.' : '',
    'ja is natural Japanese, not Chinese characters copied over.',
    'ko is natural Korean.',
    'Do not add claims, discounts, or points that are not in the source.',
    'Return JSON only at the top level with keys title, blurb, pill, shareText, perkNote, question1, question2, question3.',
    'Do not wrap those keys inside strings or source.',
    `Each value must be an object with keys ${LOCALES.join(', ')}. zh-TW must use Traditional Chinese characters.`,
    prizeLabels.length ? 'prizeLabels is a top-level array of those locale objects, same order.' : '',
    '',
    JSON.stringify({ source, strings, prizeLabels }),
  ]
    .filter(Boolean)
    .join('\n');
}

async function translateCampaignCopy(body) {
  const { source, strings, prizeLabels } = collectStrings(body);
  const parsed = await callGeminiJson(translatePrompt(source, strings, prizeLabels), defaultGeminiModel());
  return applyParsed(parsed, source, strings, prizeLabels);
}

module.exports = {
  STRING_KEYS,
  collectStrings,
  applyParsed,
  translateCampaignCopy,
};
