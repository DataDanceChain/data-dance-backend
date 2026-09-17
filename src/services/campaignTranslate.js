const { callGeminiJson, defaultGeminiModel } = require('./lifeContextGemini');
const { LOCALES, LOCALE_NAMES, normalizeLocale, asMap, emptyMap } = require('../utils/campaignI18n');

function mergeLocaleMaps(...maps) {
  const out = emptyMap();
  maps.forEach((map) => {
    LOCALES.forEach((locale) => {
      if (map?.[locale] && !out[locale]) out[locale] = map[locale];
    });
  });
  return out;
}

const STRING_KEYS = ['title', 'blurb', 'pill', 'shareText', 'perkNote', 'question1', 'question2', 'question3'];

function cleanString(value, max) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 400);
}

function collectStrings(body) {
  const source = normalizeLocale(body.source || body.copySource) || 'en';
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
    const map = mergeLocaleMaps(asMap(parsed?.[key]), asMap(nested[key]));
    if (!strings[key]) {
      delete bundle[key];
      return;
    }
    map[source] = strings[key];
    bundle[key] = map;
  });
  const prizeSource = Array.isArray(parsed?.prizeLabels) ? parsed.prizeLabels : nested.prizeLabels;
  bundle.prizeLabels = prizeLabels.map((label, index) => {
    const map = asMap(Array.isArray(prizeSource) ? prizeSource[index] : prizeSource?.[index]);
    map[source] = label;
    return map;
  });
  return bundle;
}

function translatePrompt(source, strings, prizeLabels) {
  const targets = LOCALES.filter((locale) => locale !== source);
  return [
    'Translate Wallet campaign copy for DataDance.',
    `Source language: ${LOCALE_NAMES[source] || source} (${source}).`,
    `Fill these locales: ${targets.map((locale) => `${LOCALE_NAMES[locale]} (${locale})`).join(', ')}.`,
    'Keep meaning, tone, and length close to the source.',
    'Keep brand and product names: DataDance, Wallet, Airbnb, Booking, Amazon, Connect, Life Capsule.',
    'zh is Simplified Chinese. zh-TW is Traditional Chinese used in Taiwan, not a character-by-character conversion if a natural Taiwan phrase is better.',
    'ja is natural Japanese, not Chinese characters copied over.',
    'Do not add claims, discounts, or points that are not in the source.',
    'Return JSON only at the top level with keys title, blurb, pill, shareText, perkNote, question1, question2, question3.',
    'Do not wrap those keys inside strings or source.',
    'Each value must be an object with keys en, zh, zh-TW, ja. zh-TW must use Traditional Chinese characters.',
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
