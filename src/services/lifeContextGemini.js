const axios = require('axios');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_ALIASES = {
  'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite-001': 'gemini-2.5-flash-lite',
};

function geminiApiKey() {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    const error = new Error('Gemini is not configured on this server.');
    error.code = 'NO_GEMINI';
    throw error;
  }
  return key;
}

function resolveGeminiModel(model) {
  const id = String(model || '').trim();
  return MODEL_ALIASES[id] || id;
}

function defaultGeminiModel() {
  return resolveGeminiModel(process.env.GEMINI_DEFAULT_MODEL || 'gemini-2.5-flash-lite');
}

function languageHint(locale) {
  const code = String(locale || 'en').toLowerCase();
  if (code.startsWith('zh-tw') || code.startsWith('zh-hant')) return 'Traditional Chinese';
  if (code.startsWith('zh')) return 'Simplified Chinese';
  if (code.startsWith('ja')) return 'Japanese';
  return 'English';
}

function stripFence(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function cleanLine(value, max) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 2400);
}

function asList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanLine(item, 220))
    .filter(Boolean)
    .slice(0, limit);
}

function asDomain(value) {
  if (typeof value === 'string') {
    return { read: cleanLine(value, 800), evidence: [] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { read: '', evidence: [] };
  }
  return {
    read: cleanLine(value.read || value.text || '', 800),
    evidence: asList(value.evidence, 6),
  };
}

function composePaste(refined) {
  const lines = [];
  if (refined.portrait) lines.push(refined.portrait);
  else if (refined.summary) lines.push(refined.summary);
  if (refined.handoff.length) {
    lines.push('', 'When helping:');
    for (const item of refined.handoff) lines.push(`- ${item}`);
  }
  if (refined.focus.length) lines.push('', `Focus: ${refined.focus.join(' · ')}`);
  if (refined.unknowns.length) lines.push('', `Unknown: ${refined.unknowns.join('; ')}`);
  lines.push('', 'Do not invent employers, family, home city, addresses, prices, or order IDs.');
  return lines.join('\n').trim();
}

function asRefined(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const shopping = asDomain(value.shopping);
  const travel = asDomain(value.travel);
  const events = asDomain(value.events);
  const refined = {
    summary: cleanLine(value.summary, 600),
    portrait: cleanLine(value.portrait || value.background, 1600),
    paste: cleanLine(value.paste, 3200),
    handoff: asList(value.handoff, 12),
    focus: asList(value.focus, 6),
    shopping: shopping.read,
    travel: travel.read,
    events: events.read,
    shoppingEvidence: shopping.evidence,
    travelEvidence: travel.evidence,
    eventEvidence: events.evidence,
    unknowns: asList(value.unknowns, 8),
  };
  if (!refined.portrait && !refined.summary && !refined.handoff.length) return null;
  if (!refined.portrait) refined.portrait = refined.summary;
  if (!refined.summary) refined.summary = refined.portrait;
  refined.paste = composePaste(refined);
  refined.background = refined.paste;
  if (Number.isFinite(Number(value.cleanKept))) refined.cleanKept = Number(value.cleanKept);
  if (Number.isFinite(Number(value.cleanDropped))) refined.cleanDropped = Number(value.cleanDropped);
  if (Array.isArray(value.cleanDroppedSamples)) {
    refined.cleanDroppedSamples = value.cleanDroppedSamples
      .map((item) => ({
        id: cleanLine(item?.id, 80),
        title: cleanLine(item?.title, 160),
        reason: cleanLine(item?.reason, 160),
      }))
      .slice(0, 8);
  }
  return refined;
}

function refinePrompt(language, brief) {
  return [
    `Distill lifestyle traces into portable background for other LLMs, written in ${language}.`,
    'This follows the Life Capsule machine layer: handoff first, then a second-person portrait, then per-domain reads with evidence, then open questions.',
    'Voice: second-person “you”. Insights about the person who owns these traces — not marketing, not fiction.',
    'Ground EVERYTHING only in the traces JSON. Prefer shoppingThemes, travelPlaces, eventThemes (word frequencies) and the sample titles.',
    'If brief.aboutMe is present, treat it as a short user-written supplement. You may use those facts; do not invent beyond them or the traces.',
    'If evidence is thin, write cautious shorter prose and name what was not visible.',
    'Do NOT treat platform names (Amazon, Booking, Airbnb, Luma, SHEIN, Temu) as the insight. Extract concrete nouns from titles and themes.',
    'Do not invent employers, family, home city, ages, or relationships.',
    'Do not mention prices, order IDs, emails, or wallet data.',
    'Return JSON only with this shape:',
    '{',
    '  "summary": "≤2 sentences. Distill snapshot another model can skim.",',
    '  "portrait": "2–4 sentences, second person. Integrated portrait of you.",',
    '  "handoff": ["5–12 one-line bullets another model can paste into a system prompt"],',
    '  "focus": ["3–5 concrete nouns or short phrases, never platform names"],',
    '  "shopping": { "read": "1–3 sentences or empty", "evidence": ["title fragments that support the read"] },',
    '  "travel": { "read": "1–3 sentences or empty", "evidence": [] },',
    '  "events": { "read": "1–3 sentences or empty", "evidence": [] },',
    '  "unknowns": ["what is missing or still a hypothesis"],',
    '  "paste": "one block: portrait + When helping (from handoff) + Focus + Unknown. Ready to paste as custom instructions."',
    '}',
    '',
    JSON.stringify(brief),
  ].join('\n');
}

function cleanPrompt(language, traces) {
  return [
    `Review crawled lifestyle records. Reply in ${language} only for the reason strings.`,
    'Drop ONLY obvious dirty rows: UI chrome, nav labels, cookie banners, site page titles, pagination, language switchers,',
    'placeholders (Product image, icon), titles that are only an order id / price / date, or empty cards.',
    'Keep real products, hotels, stays, and events even if the wording is messy or in another language.',
    'Do not drop a real item because it looks cheap, odd, or personal.',
    'Return JSON only: { "drop": [{ "id": "row-id", "reason": "short reason" }] }',
    'If nothing is dirty, return { "drop": [] }.',
    '',
    JSON.stringify(traces),
  ].join('\n');
}

async function callGeminiJson(prompt, model) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const response = await axios.post(
    url,
    { contents: [{ parts: [{ text: prompt }] }] },
    {
      timeout: 45000,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey(),
      },
      validateStatus: () => true,
    },
  );
  const data = response.data || {};
  if (response.status >= 400) {
    const error = new Error(data.error?.message || `Gemini HTTP ${response.status}`);
    error.code = 'GEMINI_FAILED';
    throw error;
  }
  const text = (data.candidates || [])
    .flatMap((row) => row.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();
  if (!text) {
    const error = new Error('Empty Gemini response');
    error.code = 'GEMINI_FAILED';
    throw error;
  }
  try {
    return JSON.parse(stripFence(text));
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    const error = new Error('Gemini returned unreadable JSON');
    error.code = 'GEMINI_FAILED';
    throw error;
  }
}

async function cleanCrawlerTraces(traces, locale) {
  const model = defaultGeminiModel();
  const language = languageHint(locale);
  const drop = [];
  const chunkSize = 60;
  for (let i = 0; i < traces.length; i += chunkSize) {
    const chunk = traces.slice(i, i + chunkSize);
    try {
      const parsed = await callGeminiJson(cleanPrompt(language, chunk), model);
      for (const item of parsed.drop || []) {
        if (!item?.id) continue;
        drop.push({
          id: String(item.id),
          reason: cleanLine(item.reason || 'dirty', 160),
        });
      }
    } catch {
      // Keep heuristic-cleaned rows if one batch fails.
    }
  }
  const banned = new Set(drop.map((row) => row.id));
  return {
    keep: traces.filter((row) => !banned.has(row.id)),
    drop,
    model,
  };
}

async function generateRefinedPortrait(brief, locale) {
  const model = defaultGeminiModel();
  const language = languageHint(locale);
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const response = await axios.post(
    url,
    { contents: [{ parts: [{ text: refinePrompt(language, brief) }] }] },
    {
      timeout: 45000,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey(),
      },
      validateStatus: () => true,
    },
  );

  const data = response.data || {};
  if (response.status >= 400) {
    const message = data.error?.message || `Gemini HTTP ${response.status}`;
    const error = new Error(message);
    error.code = 'GEMINI_FAILED';
    throw error;
  }

  const text = (data.candidates || [])
    .flatMap((row) => row.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();
  if (!text) {
    const error = new Error('Empty Gemini response');
    error.code = 'GEMINI_FAILED';
    throw error;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  const refined = asRefined(parsed);
  if (!refined) {
    const error = new Error('Gemini returned an unreadable portrait.');
    error.code = 'GEMINI_FAILED';
    throw error;
  }

  return { refined, model };
}

module.exports = {
  asRefined,
  callGeminiJson,
  cleanCrawlerTraces,
  defaultGeminiModel,
  generateRefinedPortrait,
  languageHint,
  refinePrompt,
};
