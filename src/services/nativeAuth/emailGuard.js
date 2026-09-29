/**
 * E-mail address guard for POST /email/start (design §3.3 step 1, F8).
 *
 *   guardEmail(raw) → { email, domain }   or throws NativeAuthError('INVALID_EMAIL')
 *
 * 1. Normalise (trim, lower-case, IDN domain → ASCII) and validate the syntax (≤254 characters,
 *    local part ≤64, dot-atom local part, a domain of at least two DNS labels).
 * 2. Refuse a domain on the bundled disposable list (data/disposableDomains.json, CC0, from
 *    github.com/disposable-email-domains), including any subdomain of a listed domain.
 * 3. Require that the domain can receive mail: an MX record that is not a null MX (RFC 7505), or
 *    failing that an A/AAAA record (RFC 5321 §5.1 implicit MX). 2 s DNS budget; answers cached 1 h.
 *    A DNS outage (timeout, SERVFAIL, refused) is not the user's fault: the address passes and the
 *    answer is not cached, so an outage never blocks sign-in.
 *
 * Nothing here looks at accounts, so the answer is the same for known and unknown addresses.
 */
const dns = require('dns');
const { domainToASCII } = require('url');
const { NativeAuthError } = require('../../controllers/nativeAuth/respond');
const { createLogger } = require('../../utils/logger');
const disposable = require('./data/disposableDomains.json');

const logger = createLogger('nativeAuth');

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const DNS_TIMEOUT_MS = 2000;
const DNS_CACHE_TTL_MS = 60 * 60 * 1000;
const DNS_CACHE_MAX = 10000;

const DISPOSABLE = new Set(disposable.domains);
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Answers that mean "this name has no such record" (cacheable), as opposed to an outage. */
const NO_RECORD_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

function invalid() {
  return new NativeAuthError('INVALID_EMAIL', { message: 'Enter a valid e-mail address.' });
}

/** Normalised address or null. Pure: no DNS. */
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) return null;
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at !== trimmed.indexOf('@')) return null;
  const local = trimmed.slice(0, at);
  const rawDomain = trimmed.slice(at + 1).replace(/\.$/, '');
  if (local.length > MAX_LOCAL_LENGTH || !LOCAL_PART.test(local)) return null;
  const domain = domainToASCII(rawDomain);
  if (!domain || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !TLD.test(labels[labels.length - 1])) return null;
  const email = `${local}@${domain}`;
  return email.length > MAX_EMAIL_LENGTH ? null : email;
}

function domainOf(email) {
  return email.slice(email.indexOf('@') + 1);
}

/** The domain or any parent of it (below the TLD) is on the disposable list. */
function isDisposableDomain(domain) {
  const labels = String(domain || '').toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (DISPOSABLE.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------------------------

function defaultResolver() {
  return new dns.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
}

const dnsCache = new Map();

function cacheGet(domain, now) {
  const hit = dnsCache.get(domain);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) {
    dnsCache.delete(domain);
    return undefined;
  }
  return hit.value;
}

function cacheSet(domain, value, now) {
  dnsCache.delete(domain);
  dnsCache.set(domain, { value, expiresAt: now + DNS_CACHE_TTL_MS });
  while (dnsCache.size > DNS_CACHE_MAX) dnsCache.delete(dnsCache.keys().next().value);
}

function clearDnsCache() {
  dnsCache.clear();
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Records of one type, [] when the name has none, or throws on an outage. */
async function lookup(resolver, method, domain) {
  try {
    return await resolver[method](domain);
  } catch (err) {
    if (NO_RECORD_CODES.has(err && err.code)) return [];
    throw err;
  }
}

async function resolveDeliverability(domain, resolver) {
  const mx = await lookup(resolver, 'resolveMx', domain);
  if (mx.length) {
    // RFC 7505 null MX ("MX 0 ."): the domain states it accepts no mail.
    const real = mx.filter((record) => record && record.exchange && record.exchange !== '.');
    return real.length ? 'ok' : 'none';
  }
  if ((await lookup(resolver, 'resolve4', domain)).length) return 'ok';
  if ((await lookup(resolver, 'resolve6', domain)).length) return 'ok';
  return 'none';
}

/**
 * 'ok' (can receive mail), 'none' (cannot), or 'unknown' (DNS outage; not cached). The whole
 * lookup chain shares one DNS_TIMEOUT_MS budget.
 */
async function checkDomainDeliverable(domain, { resolver = defaultResolver(), now = Date.now(), timeoutMs = DNS_TIMEOUT_MS } = {}) {
  const cached = cacheGet(domain, now);
  if (cached) return cached;
  try {
    const value = await withTimeout(resolveDeliverability(domain, resolver), timeoutMs);
    cacheSet(domain, value, now);
    return value;
  } catch (err) {
    logger.warn('native_auth.email_dns_unavailable', { reason: String((err && err.code) || 'error') });
    return 'unknown';
  } finally {
    if (typeof resolver.cancel === 'function') resolver.cancel();
  }
}

/**
 * Normalise and check an address. Returns { email, domain }; throws INVALID_EMAIL for a malformed
 * address, a disposable domain, or a domain that cannot receive mail.
 */
async function guardEmail(raw, { resolver, now } = {}) {
  const email = normalizeEmail(raw);
  if (!email) throw invalid();
  const domain = domainOf(email);
  if (isDisposableDomain(domain)) throw invalid();
  const deliverable = await checkDomainDeliverable(domain, { resolver: resolver || defaultResolver(), now: now || Date.now() });
  if (deliverable === 'none') throw invalid();
  return { email, domain };
}

module.exports = {
  MAX_EMAIL_LENGTH,
  DNS_TIMEOUT_MS,
  DNS_CACHE_TTL_MS,
  normalizeEmail,
  domainOf,
  isDisposableDomain,
  checkDomainDeliverable,
  clearDnsCache,
  guardEmail,
};
