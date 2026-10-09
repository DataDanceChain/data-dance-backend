const KINDS = new Set(['app', 'page', 'redirect']);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEST_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function publicOrigin() {
  return String(process.env.TRACKED_LINK_ORIGIN || 'https://app.datadance.ai').replace(/\/$/, '');
}

function publicUrl(slug) {
  return `${publicOrigin()}/go/${slug}`;
}

function normalizeSlug(value) {
  return String(value || '').trim().toLowerCase();
}

function validSlug(slug) {
  return SLUG_PATTERN.test(slug) && slug.length >= 2 && slug.length <= 40;
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function normalizeTarget(kind, value) {
  if (kind === 'app') return { url: null };
  const raw = String(value || '').trim();
  if (!raw || raw.length > 500) return { error: 'A https link is required' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'A https link is required' };
  }
  if (parsed.protocol !== 'https:') return { error: 'A https link is required' };
  return { url: parsed.toString() };
}

/**
 * Where a visitor went next, as the public page reports it ('ios', 'android', 'target'). The
 * caller is anonymous, so only a short token is kept; anything else is stored as null.
 */
function normalizeDest(value) {
  const raw = String(value ?? '').trim();
  return DEST_PATTERN.test(raw) ? raw : null;
}

function referrerHost(header) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.slice(0, 120) || null;
  } catch {
    return null;
  }
}

module.exports = {
  KINDS,
  publicUrl,
  normalizeSlug,
  validSlug,
  cleanText,
  normalizeTarget,
  normalizeDest,
  referrerHost,
};
