/**
 * Connect Earn identity after the Wallet client extracts and cleans rows.
 * Catalog uploads (shop / social / travel / life) are title-first (order
 * id optional). Core Luma / Airbnb / Booking keep official ids when present;
 * client-smoothed generic fallbacks may use a title: key. Amazon stays
 * official-id only.
 */

const { isCatalogCrawlerSource, normalizeCrawlerSource } = require('../constants/crawlerSources');

const TITLE_BACKED_PREFIX = 'title:';
/** Prefix of a post's permalink key (per user, like every title: key). */
const POST_KEY_PREFIX = `${TITLE_BACKED_PREFIX}post:`;

/** Core hosts that may fall back to title: when the client sent a smoothed row. */
const TITLE_BACKED_SMOOTHED_CORE = new Set(['luma', 'airbnb', 'booking']);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function payloadTitle(payload) {
  const row = asRecord(payload);
  return normalizeText(
    row.productTitle ||
      row.title ||
      row.name ||
      row.bookingName ||
      row.hotelName ||
      row.listingTitle ||
      row.eventName ||
      row.caption ||
      row.text ||
      row.handle ||
      '',
  );
}

function payloadDate(payload) {
  const row = asRecord(payload);
  return normalizeText(
    row.date || row.orderDate || row.startDate || row.checkIn || row.dueDate || '',
  );
}

function hostFromMetadata(metadata) {
  const row = asRecord(metadata);
  const explicit = normalizeText(row.host).replace(/^www\./, '');
  if (explicit) return explicit;
  const url = String(row.sourceUrl || '');
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function isClientSmoothedRecord(item) {
  if (!item) return false;
  if (isCatalogCrawlerSource(item.source)) return true;
  const metadata = asRecord(item.metadata);
  return metadata.extract === 'generic' || metadata.cleaned === true;
}

/*
 * A social post's permalink, reduced to the id the platform itself uses for that post, so the same
 * post seen through another host (twitter.com, mobile.x.com), another handle spelling, or with a
 * comment / query suffix is one record. Only the social sources below use it, and only with a link
 * on that platform's own hosts: every other source keeps its order id or title identity. Each
 * canonical form reads back as itself, so a row that carries the canonical link gets the same key
 * as one that carries the original link. The web client derives the same forms
 * (src/crawler/connect/postUrl.ts); test/fixtures/postUrlCases.json is the table both sides run.
 */
const SHORTCODE = /^[A-Za-z0-9_-]{4,64}$/;
const NUMERIC_ID = /^\d{1,25}$/;
const FACEBOOK_ID = /^[A-Za-z0-9_-]{4,200}$/;

/**
 * The post id after a keyword segment, with its keyword: the handle form (/<handle>/<keyword>/<id>,
 * the first keyword after the first segment) first, and the canonical form (/<keyword>/<id>) only
 * when the handle form gives no id. null when neither does.
 */
function keywordPost(parts, keywords, idPattern) {
  const isKeyword = (part) => keywords.includes(String(part || '').toLowerCase());
  const after = (at) =>
    at >= 0 && idPattern.test(parts[at + 1] || '') ? { keyword: parts[at].toLowerCase(), id: parts[at + 1] } : null;
  return after(parts.findIndex((part, i) => i > 0 && isKeyword(part))) || (isKeyword(parts[0]) ? after(0) : null);
}

/**
 * A Facebook story's permalink, in the forms the web client sends: /<user>/posts/<id>,
 * /<user>/videos/<id>, /reel/<id>, /share/<kind>/<id>, and the query forms permalink.php and
 * story.php (story_fbid, with id= when it is an id too), photo.php (fbid) and watch/ (v). The id
 * is what the platform shows in the link, so the user segment and the query form are kept. A
 * profile, login or other page of the site is not a post.
 */
function facebookPostUrl(parts, url) {
  const isId = (value) => FACEBOOK_ID.test(value || '');
  const after = (keyword) => parts.findIndex((part, i) => i > 0 && part.toLowerCase() === keyword);
  const posts = after('posts');
  if (posts > 0 && isId(parts[posts + 1])) return `https://facebook.com/${parts[posts - 1]}/posts/${parts[posts + 1]}`;
  const videos = after('videos');
  if (videos > 0 && isId(parts[videos + 1])) return `https://facebook.com/${parts[videos - 1]}/videos/${parts[videos + 1]}`;
  const head = String(parts[0] || '').toLowerCase();
  if (head === 'reel' && isId(parts[1])) return `https://facebook.com/reel/${parts[1]}`;
  if (head === 'share' && parts[1] && isId(parts[2])) return `https://facebook.com/share/${parts[1]}/${parts[2]}`;
  const query = (name) => url.searchParams.get(name) || '';
  const story = query('story_fbid');
  if ((head === 'permalink.php' || head === 'story.php') && isId(story)) {
    const owner = query('id');
    return `https://facebook.com/${head}?story_fbid=${story}${isId(owner) ? `&id=${owner}` : ''}`;
  }
  const photo = query('fbid');
  if ((head === 'photo.php' || head === 'photo') && isId(photo)) return `https://facebook.com/photo.php?fbid=${photo}`;
  const video = query('v');
  if (head === 'watch' && isId(video)) return `https://facebook.com/watch/?v=${video}`;
  return '';
}

const SOCIAL_PERMALINKS = {
  x: {
    hosts: ['x.com', 'twitter.com'],
    canonical(parts) {
      // /<handle>/status/<id>, /i/web/status/<id>, /<handle>/statuses/<id> (older links)
      const at = parts.findIndex((part, i) => i > 0 && /^status(?:es)?$/i.test(part));
      const id = at > 0 ? parts[at + 1] : '';
      return NUMERIC_ID.test(id || '') ? `https://x.com/i/status/${id}` : '';
    },
  },
  instagram: {
    hosts: ['instagram.com'],
    canonical(parts) {
      // /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>, also behind /<handle>/. A shortcode
      // names one media item whichever of these paths shows it, and its case is significant.
      const at = parts.findIndex((part) => ['p', 'reel', 'reels', 'tv'].includes(part.toLowerCase()));
      const code = at >= 0 ? parts[at + 1] : '';
      return SHORTCODE.test(code || '') ? `https://instagram.com/p/${code}` : '';
    },
  },
  threads: {
    hosts: ['threads.net', 'threads.com'],
    canonical(parts) {
      // /@<handle>/post/<code>, and the canonical /post/<code> itself
      const post = keywordPost(parts, ['post'], SHORTCODE);
      return post ? `https://threads.net/post/${post.id}` : '';
    },
  },
  tiktok: {
    hosts: ['tiktok.com'],
    canonical(parts) {
      // /@<handle>/video/<id>, /@<handle>/photo/<id>, and the canonical /video/<id>, /photo/<id>
      const post = keywordPost(parts, ['video', 'photo'], NUMERIC_ID);
      return post ? `https://tiktok.com/${post.keyword}/${post.id}` : '';
    },
  },
  facebook: {
    // facebook.com and fb.com with any subdomain (web., business., ...), as the web client reads them
    hosts: ['facebook.com', 'fb.com'],
    anySubdomain: true,
    canonical: facebookPostUrl,
  },
};

/** Sources whose rows may carry a post permalink identity. */
const SOCIAL_PERMALINK_SOURCES = Object.keys(SOCIAL_PERMALINKS);

/**
 * True when `hostname` is one of the rule's hosts, bare or behind www. / m. / mobile. (or behind
 * any subdomain, for a rule with `anySubdomain`).
 */
function isPlatformHost(hostname, { hosts, anySubdomain = false }) {
  const host = String(hostname || '').toLowerCase().replace(/^(?:www|m|mobile)\./, '');
  return hosts.includes(host) || (anySubdomain && hosts.some((name) => host.endsWith(`.${name}`)));
}

/**
 * Canonical permalink of a social post row, or '' when the source is not one of the social
 * platforms above or the row holds no link on that platform's own hosts. A non-social source
 * always gets '', whatever links its rows hold.
 */
function socialPostUrl(source, payload) {
  const rule = SOCIAL_PERMALINKS[normalizeCrawlerSource(source)];
  if (!rule) return '';
  const row = asRecord(payload);
  for (const value of [row.href, row.id, row.orderId, row.orderid]) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > 2048) continue;
    let url;
    try {
      url = new URL(text);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (!isPlatformHost(url.hostname, rule)) continue;
    const canonical = rule.canonical(url.pathname.split('/').filter(Boolean), url);
    if (canonical) return canonical;
  }
  return '';
}

/**
 * True for a link on a Facebook host: facebook.com or fb.com, bare or behind any subdomain, with
 * or without a trailing dot, with or without its scheme. The same test as the web client's
 * isFacebookLink (src/crawler/connect/postUrl.ts); the facebookLinks list in
 * test/fixtures/postUrlCases.json is run by both sides.
 */
function isFacebookLink(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 2048) return false;
  for (const candidate of [text, `https://${text}`]) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (['facebook.com', 'fb.com'].some((name) => host === name || host.endsWith(`.${name}`))) return true;
  }
  return false;
}

/**
 * The record's own id, which identifies it across all users of the source; null when it has none.
 * A Facebook row's id is never a link on a Facebook host: a post link is its permalink key
 * (socialPostUrl, per user), and any other Facebook link is skipped, so such a row falls back to
 * its title key (per user) instead of one key shared by everyone who sent that link.
 */
function officialRecordId(source, payload) {
  const row = asRecord(payload);
  if (normalizeCrawlerSource(source) === 'facebook') {
    for (const value of [row.orderId, row.orderid, row.id, row.bookingId, row.tripId]) {
      if (!value) continue;
      const text = String(value).trim();
      if (!isFacebookLink(text)) return text || null;
    }
    return null;
  }
  if (source === 'amazon') return String(row.orderid || row.orderId || '').trim() || null;
  if (source === 'luma') return String(row.eventId || row.taskId || row.id || '').trim() || null;
  if (source === 'airbnb') return String(row.tripId || row.id || '').trim() || null;
  if (source === 'booking') return String(row.bookingId || row.id || '').trim() || null;
  if (isCatalogCrawlerSource(source)) {
    return (
      String(row.orderId || row.orderid || row.id || row.bookingId || row.tripId || '').trim() ||
      null
    );
  }
  return null;
}

function isTitleBackedSourceId(sourceId) {
  return typeof sourceId === 'string' && sourceId.startsWith(TITLE_BACKED_PREFIX);
}

function sourceIdentityKey(source, sourceId) {
  if (!sourceId) return '';
  return `${source}:${sourceId}`;
}

function allowsTitleBackedIdentity(source, metadata = {}) {
  if (isCatalogCrawlerSource(source)) return true;
  if (!TITLE_BACKED_SMOOTHED_CORE.has(source)) return false;
  return isClientSmoothedRecord({ source, metadata });
}

/** The title key of a row: `title:<host>:<title>:<date>`, or null when the row has no title. */
function titleSourceId(source, payload, metadata = {}) {
  const title = payloadTitle(payload);
  if (!title) return null;
  const date = payloadDate(payload);
  const host = hostFromMetadata(metadata) || source;
  return `${TITLE_BACKED_PREFIX}${host}:${title}:${date}`.slice(0, 190);
}

/**
 * Dedup key matching the client after clean: host + orderId / title / date.
 * Official ids stay unprefixed so already-stored Amazon (and other core)
 * sourceId values keep matching. Title-only catalog rows and smoothed
 * Luma / Airbnb / Booking generic fallbacks use a title: key unique per
 * host (not collapsed into amazon). A post on X / Instagram / Threads /
 * TikTok / Facebook uses its canonical permalink, also per user (title:
 * prefix): each user who saw the post may keep it once.
 */
function extractSourceId(source, payload, metadata = {}) {
  const postUrl = socialPostUrl(source, payload);
  if (postUrl) return `${POST_KEY_PREFIX}${postUrl}`.slice(0, 190);

  const official = officialRecordId(source, payload);
  if (official) return official;

  if (!allowsTitleBackedIdentity(source, metadata)) return null;

  return titleSourceId(source, payload, metadata);
}

/*
 * Transition, Facebook only. Facebook rows were keyed by their title (title:<host>:<title>:<date>)
 * before the permalink rule above, and App versions before 2.0.6 sent the profile page instead of
 * the post link, so those rows can only be found by that title key. For a Facebook upload keyed by
 * its permalink this returns the title key the same row had then; the upload is treated as already
 * stored when the same user holds a row under that key. Rows that do hold a post link are given
 * the permalink key by scripts/backfillSocialPostIdentity.js (part 1). '' for every other source
 * and for a Facebook row without a post link. Remove once rows under the older key no longer count.
 */
const LEGACY_TITLE_KEY_SOURCES = new Set(['facebook']);

function legacyPostTitleSourceId(source, payload, metadata = {}) {
  if (!LEGACY_TITLE_KEY_SOURCES.has(normalizeCrawlerSource(source))) return '';
  if (!socialPostUrl(source, payload)) return '';
  return titleSourceId(source, payload, metadata) || '';
}

/**
 * The same transition the other way round. An upload without the post link (App versions before
 * 2.0.6, or another uploader such as the browser extension) is keyed by its title, and the same
 * user may already hold that post under its permalink key (stored by 2.0.6, or given that key by
 * the backfill). Such an item is already stored when one of the user's rows under a permalink key
 * has this title key as its legacyPostTitleSourceId. True for the items that need that lookup:
 * Facebook items keyed by title, not by a permalink.
 */
function needsPermalinkTitleLookup(source, sourceId) {
  return (
    LEGACY_TITLE_KEY_SOURCES.has(normalizeCrawlerSource(source)) &&
    isTitleBackedSourceId(sourceId) &&
    !sourceId.startsWith(POST_KEY_PREFIX)
  );
}

function hasRecordIdentity(source, payload) {
  return Boolean(socialPostUrl(source, payload) || officialRecordId(source, payload) || payloadTitle(payload));
}

function calculateDataQuality(item) {
  const payload = asRecord(item?.payload);
  const metadata = asRecord(item?.metadata);
  const source = item?.source;
  const smoothed = isClientSmoothedRecord(item);
  let score = 0;
  const details = {
    hasOfficialId: false,
    hasMetadata: false,
    hasStandardFields: false,
    formatCompliance: false,
    clientSmoothed: smoothed,
  };

  const official = officialRecordId(source, payload);
  const title = payloadTitle(payload);
  if (official) {
    score += 40;
    details.hasOfficialId = true;
  } else if (smoothed && title) {
    // Client already dropped dirty chrome; title is the Earn identity.
    score += 40;
    details.hasOfficialId = true;
  }

  if (metadata.sourceUrl || metadata.host) score += 15;
  if (metadata.category) score += 10;
  details.hasMetadata = score >= 15;

  if (source === 'amazon' && item.type === 'product') {
    if (payload.title && payload.price) score += 15;
    if (payload.currency) score += 10;
    details.hasStandardFields = Boolean(payload.title && payload.price);
  } else if (source === 'luma') {
    if (payload.title) score += 15;
    if (payload.date || payload.dueDate) score += 10;
    details.hasStandardFields = Boolean(payload.title);
  } else if (source === 'airbnb' || source === 'booking' || isCatalogCrawlerSource(source)) {
    if (title || payload.listingTitle) score += 15;
    if (
      payload.date ||
      payload.orderDate ||
      payload.startDate ||
      payload.checkIn ||
      payload.price
    ) {
      score += 10;
    }
    details.hasStandardFields = Boolean(title);
  }

  try {
    if (item?.timestamp && new Date(item.timestamp).toISOString()) {
      score += 10;
      details.formatCompliance = true;
    }
  } catch {
    // Invalid timestamp format
  }

  return { score, details };
}

module.exports = {
  TITLE_BACKED_PREFIX,
  POST_KEY_PREFIX,
  asRecord,
  normalizeText,
  payloadTitle,
  payloadDate,
  hostFromMetadata,
  isClientSmoothedRecord,
  isFacebookLink,
  officialRecordId,
  SOCIAL_PERMALINK_SOURCES,
  socialPostUrl,
  isTitleBackedSourceId,
  sourceIdentityKey,
  extractSourceId,
  legacyPostTitleSourceId,
  needsPermalinkTitleLookup,
  hasRecordIdentity,
  calculateDataQuality,
};
