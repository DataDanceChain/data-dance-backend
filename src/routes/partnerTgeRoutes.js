/**
 * Read-only partner (TGE) resource: `/partner/tge/me` and `/partner/tge/status`.
 *
 * Auth: `Authorization: Bearer ddc_tge_…` only (never a query string). The token must have
 * been issued to the static partner client for THIS audience (`${PUBLIC_BASE_URL}/partner/tge`)
 * and the client must currently be enabled; otherwise 401 invalid_token. A DDC user JWT, an
 * MCP token (`ddc_mcp_`) or a manual PAT can never pass, and a partner token can pass neither
 * `protect` (not a JWT) nor `/mcp` (prefix). Identity always comes from the token: a `sub` /
 * `user_id` parameter is refused (contract T12).
 */
const express = require('express');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { publicBaseUrl } = require('../constants/lifeContext');
const {
  PARTNER_REALM,
  PARTNER_STATUS_CACHE_MAX_AGE_SEC,
  PARTNER_POINTS_CACHE_MAX_AGE_SEC,
  getPartnerClient,
  partnerResourceUrl,
  maskEmail,
  realEmail,
  checksumWalletAddress,
} = require('../constants/partnerClient');
const { findUserByPartnerToken } = require('../services/mcpTokenService');
const { hasActiveConsent } = require('../services/dataLicenceConsent');
const { isDisplayReferralCode, getInviterId, countDirectInvitees } = require('../utils/referralUtils');
const { createLogger } = require('../utils/logger');
const prisma = require('../utils/prisma');
const { installReadOnlyGuard, runReadOnly } = require('../utils/prismaReadOnly');

const logger = createLogger('partnerTge');

const router = express.Router();

// "Read-only" is enforced by the process, not promised by the handlers: inside a partner
// request every Prisma write throws (src/utils/prismaReadOnly.js). The guard is installed on
// the shared client, so it also catches a write made inside a helper several calls down.
installReadOnlyGuard(prisma);

/**
 * Opens the read-only scope. Mounted AFTER `requirePartnerToken` on purpose: authenticating the
 * token refreshes `McpToken.lastUsedAt`, which is DataDance's own bookkeeping about the
 * credential — not partner-visible state — and is the one write this surface still makes.
 * Everything from here on serves data and must not write.
 */
function readOnlyRequest(req, res, next) {
  return runReadOnly(`partner ${req.method} ${req.baseUrl || ''}${req.path}`, next);
}

const passthrough = (req, res, next) => next();
const lim = (name) => (rateLimiters && rateLimiters[name]) || passthrough;

function resourceMetadataUrl(req) {
  return `${publicBaseUrl(req)}/.well-known/oauth-protected-resource/partner/tge`;
}

function challenge(req, { error, description, scope }) {
  const parts = [`realm="${PARTNER_REALM}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${String(description).replace(/"/g, "'")}"`);
  if (scope) parts.push(`scope="${scope}"`);
  parts.push(`resource_metadata="${resourceMetadataUrl(req)}"`);
  return `Bearer ${parts.join(', ')}`;
}

function sendError(req, res, status, error, description, extra = {}) {
  res.set('Cache-Control', 'no-store');
  if (status === 401 || status === 403) {
    res.set('WWW-Authenticate', challenge(req, { error, description, scope: extra.scope }));
  }
  return res.status(status).json({ error, error_description: description });
}

function readBearer(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

function hasScope(tokenScope, scope) {
  return String(tokenScope || '').split(/\s+/).includes(scope);
}

/** Account status is `unknown` until the `User.disabledAt` column exists (P0 branch). */
function accountStatus(user) {
  if (!user || !('disabledAt' in user)) return 'unknown';
  return user.disabledAt ? 'disabled' : 'active';
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function requirePartnerToken(req, res, next) {
  try {
    if (req.query && (req.query.sub !== undefined || req.query.user_id !== undefined)) {
      return sendError(req, res, 400, 'invalid_request', 'The subject is taken from the token; sub/user_id parameters are not accepted.');
    }
    if (req.query && req.query.access_token !== undefined) {
      return sendError(req, res, 400, 'invalid_request', 'Send the access token in the Authorization header only.');
    }
    const token = readBearer(req);
    if (!token) {
      return sendError(req, res, 401, 'invalid_token', 'A partner access token is required in the Authorization header.');
    }
    const client = getPartnerClient(undefined, req);
    if (!client || !client.enabled) {
      return sendError(req, res, 401, 'invalid_token', 'The partner client is disabled.');
    }
    const resolved = await findUserByPartnerToken(token, partnerResourceUrl(req));
    if (!resolved || resolved.token.clientId !== client.clientId) {
      return sendError(req, res, 401, 'invalid_token', 'The access token is invalid, expired or revoked.');
    }
    req.partner = { client, user: resolved.user, token: resolved.token };
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!hasScope(req.partner.token.scope, scope)) {
      return sendError(req, res, 403, 'insufficient_scope', `Scope ${scope} is required.`, { scope });
    }
    if (req.partner.user.disabledAt) {
      return sendError(req, res, 403, 'account_disabled', 'This DataDance account is disabled.');
    }
    return next();
  };
}

/**
 * One limiter for the whole partner API (120/min per access token). `points` and `referral` make
 * /status heavier than it was — two extra indexed reads — but the limit stays where it is: it is
 * sized for a partner backend reading once per user session, not for a crawl, and raising it is
 * how a read API quietly becomes a bulk export. Revisit only with a measured need.
 */
router.use(lim('partner'));

/**
 * Both gates in front of an optional field:
 *   - the token must carry the field's scope (the partner asked for it and the user allowed it);
 *   - the environment must have frozen the field in SSO_TGE_STATUS_FIELDS.
 * Either gate shut → the key is simply absent, so the partner can tell "not served here" from
 * "DataDance has no value" (which is `null` inside a field that IS served).
 */
function fieldGate(req) {
  const { client, token } = req.partner;
  const frozen = new Set(client.statusFields);
  return (scope, field) => hasScope(token.scope, scope) && frozen.has(field);
}

/**
 * The `/me` body. Extracted so the field gates can be exercised with a token the endpoint
 * itself would never let through — which is how the `email_masked` gap was found.
 */
function meBody(req) {
  const { user, token } = req.partner;
  const serves = fieldGate(req);
  const body = {
    sub: user.id,
    client_id: token.clientId,
    issued_at: iso(token.issuedAt),
    expires_at: iso(token.expiresAt),
    // BOTH gates, like every other field: the catalog declares `email_masked` under
    // `tge:identity`, and it used to be gated on the freeze list alone — so a token without the
    // scope still received it. Today that scope is also the endpoint scope, so nothing changes
    // for a caller; the point is that the field can never again outlive its own declaration.
    email_masked: serves('tge:identity', 'email_masked') ? maskEmail(realEmail(user)) : null,
  };
  // The real address, for the campaign's own mail. null when the e-mail column holds a wallet
  // address (external-wallet login) or a legacy `twitter|<id>` subject — see realEmail().
  if (serves('tge:email', 'email')) body.email = realEmail(user);
  // EIP-55 form, so the partner can compare it with what a wallet shows. null when unbound.
  if (serves('tge:wallet', 'wallet_address')) body.wallet_address = checksumWalletAddress(user.walletAddress);
  return body;
}

router.get('/me', requirePartnerToken, readOnlyRequest, requireScope('tge:identity'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json(meBody(req));
});

/**
 * `{ code, inviter_sub, direct_invitees }`.
 *
 * NEVER a list of downline users. The people this user invited are third parties who consented
 * to DataDance, not to this partner; handing over their ids (or e-mails, or names) would share
 * data nobody in that list agreed to share. `direct_invitees` is a COUNT for the partner's
 * leaderboard and `inviter_sub` is the one id the user's own upline rebate needs.
 */
async function referralSummary(user) {
  // READ ONLY. This used to call ensureDisplayReferralCode(), which allocates a short code and
  // writes it to the User row — a partner GET mutating DataDance state, with no request of its
  // own in the audit trail and a `$executeRaw` UPDATE behind it. The partner now sees the code
  // only if the user already has one in display form; a legacy code reads as `null`, exactly as
  // the contract's "a display code could not be resolved". Allocation belongs to the Wallet,
  // where the user is present and the write has a reason.
  const code = isDisplayReferralCode(user.referralCode) ? user.referralCode : null;
  const [inviterSub, directInvitees] = await Promise.all([getInviterId(user.id), countDirectInvitees(user.id)]);
  return { code, inviter_sub: inviterSub, direct_invitees: directInvitees };
}

router.get('/status', requirePartnerToken, readOnlyRequest, requireScope('tge:status'), async (req, res, next) => {
  try {
    const { user } = req.partner;
    const serves = fieldGate(req);
    const asOf = new Date().toISOString();
    const body = {
      sub: user.id,
      account_status: accountStatus(user),
      registered_at: serves('tge:status', 'registered_at') ? iso(user.createdAt) : null,
      wallet_bound: serves('tge:status', 'wallet_bound') ? Boolean(user.walletAddress) : null,
      data_licence_granted: serves('tge:status', 'data_licence_granted') ? Boolean(await hasActiveConsent(user.id)) : null,
      as_of: asOf,
      cache_max_age: PARTNER_STATUS_CACHE_MAX_AGE_SEC,
    };
    if (serves('tge:points', 'points')) {
      // The denormalised User.totalPoints, NOT SUM(Point.amount). The Point ledger is the source
      // of truth and totalPoints is maintained from it inside the same transactions, but summing
      // a user's whole ledger on every partner read is too expensive for a 120/min endpoint.
      // A balance is therefore as fresh as the last ledger write, which is what `as_of` states.
      body.points = {
        balance: Number(user.totalPoints) || 0,
        as_of: asOf,
        cache_max_age: PARTNER_POINTS_CACHE_MAX_AGE_SEC,
      };
    }
    if (serves('tge:referral', 'referral')) body.referral = await referralSummary(user);
    // A body carrying a live balance is not cacheable at all, so the whole response drops to
    // no-store and the top-level cache_max_age follows it down (T14: never cache past the value).
    if (body.points) {
      body.cache_max_age = PARTNER_POINTS_CACHE_MAX_AGE_SEC;
      res.set('Cache-Control', 'no-store');
    } else {
      res.set('Cache-Control', `private, max-age=${PARTNER_STATUS_CACHE_MAX_AGE_SEC}`);
    }
    return res.json(body);
  } catch (error) {
    return next(error);
  }
});

// Anything else under /partner/tge is unknown; answer in the same RFC 6750 vocabulary.
router.use((req, res) => sendError(req, res, 404, 'invalid_request', 'Unknown partner endpoint.'));

// Errors thrown inside this router never fall through to the HTML/stack-trace handler.
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (error && error.code === 'READ_ONLY_VIOLATION') {
    // Loud on purpose: a write on this surface is a defect, not a user-visible condition.
    logger.error('partner.read_only_violation', { operation: error.operation, path: req.originalUrl });
  }
  return sendError(req, res, 500, 'server_error', 'Unexpected error.');
});

module.exports = router;
module.exports.requirePartnerToken = requirePartnerToken;
module.exports.accountStatus = accountStatus;
module.exports.meBody = meBody;
module.exports.referralSummary = referralSummary;
