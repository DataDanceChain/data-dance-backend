/**
 * One structured log line per call to the public e-mail + password sign-up
 * (POST /api/auth/register). Decision 43 A: throttle it now, and find out whether anything
 * (business.datadance.ai, a script, a stale client) still calls it before deciding to close it.
 * Whoever has the server logs searches for `event: "auth_register_call"`.
 *
 * No personal data: never the address, the name, the password or the IP. Only the e-mail DOMAIN,
 * the calling page's host (Origin / Referer, host only), a short client tag from the User-Agent,
 * a few booleans about the request shape, and the HTTP status the call ended with — 429 included,
 * because this middleware runs in front of the limiters.
 */
const { createLogger } = require('../utils/logger');

const logger = createLogger('registerUsage');

const EVENT = 'auth_register_call';
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_DOMAIN_LENGTH = 100;
const MAX_CLIENT_LENGTH = 40;

/** "Jo@Example.COM " → "example.com"; anything that is not a plausible domain → "invalid"/"none". */
function emailDomain(email) {
  if (email === undefined || email === null || email === '') return 'none';
  const value = String(email).trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return 'invalid';
  const domain = value.slice(at + 1);
  if (!domain || domain.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(domain)) return 'invalid';
  return domain;
}

/** Host of an Origin / Referer header ("https://business.datadance.ai/x?y" → "business.datadance.ai"). */
function headerHost(value) {
  if (!value) return null;
  try {
    const { host } = new URL(String(value));
    return host ? host.toLowerCase().slice(0, MAX_DOMAIN_LENGTH) : null;
  } catch {
    return 'invalid';
  }
}

/** First product token of the User-Agent ("Mozilla/5.0 (…)" → "Mozilla/5.0", "axios/1.9.0"). */
function clientTag(userAgent) {
  if (!userAgent) return null;
  const first = String(userAgent).trim().split(/\s+/)[0] || '';
  return first.replace(/[^\w./-]/g, '').slice(0, MAX_CLIENT_LENGTH) || null;
}

function outcomeFor(status) {
  if (status === 201) return 'created';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'error';
  if (status >= 400) return 'rejected';
  return 'other';
}

function registerUsageLog(req, res, next) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const started = Date.now();
  const base = {
    event: EVENT,
    emailDomain: emailDomain(body.email),
    origin: headerHost(req.get?.('origin')),
    refererHost: headerHost(req.get?.('referer')),
    client: clientTag(req.get?.('user-agent')),
    isOrganization: Boolean(body.isOrganization),
    hasReferralCode: Boolean(body.referralCode),
    hasCampaign: Boolean(body.referralCampaign ?? body.campaign),
  };
  let logged = false;
  const emit = (aborted) => {
    if (logged) return;
    logged = true;
    const status = aborted ? null : res.statusCode;
    logger.info('Public e-mail sign-up called', {
      ...base,
      status,
      outcome: aborted ? 'aborted' : outcomeFor(status),
      durationMs: Date.now() - started,
    });
  };
  res.once('finish', () => emit(false));
  res.once('close', () => emit(!res.writableFinished));
  next();
}

module.exports = { registerUsageLog, emailDomain, headerHost, clientTag, logger, EVENT };
