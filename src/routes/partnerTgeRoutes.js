/**
 * Read-only partner (TGE) resource: `/partner/tge/me`, `/partner/tge/status` and
 * `/partner/tge/referral-network`, `POST /partner/tge/referral/bind/check` (a read: checks a code) —
 * plus ONE deliberate write, `POST /partner/tge/referral/bind` (decision 30 A, two-step since item
 * 35), which is the only route here outside the read-only guard.
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
  referralBindEnabled,
} = require('../constants/partnerClient');
const { isReferralRewardsFeaturesDisabled } = require('../constants/referralRewardsFeature');
const {
  bindReferralForPartner,
  checkReferralForPartner,
  resolveBindCode,
  parseBindCode,
  codePrefix,
} = require('../services/partnerReferralBind');
const { issueConfirmToken, verifyConfirmToken } = require('../services/referralBindConfirm');
const { findUserByPartnerToken } = require('../services/mcpTokenService');
const { withPartnerVisibleWallet } = require('../services/networkRebindWallet');
const { hasActiveConsent } = require('../services/dataLicenceConsent');
const { isDisplayReferralCode, getInviter, countDirectInvitees } = require('../utils/referralUtils');
const { formatReferralCodeForDisplay, normalizeReferralCodeInput } = require('../utils/referralCodeFormat');
const { createLogger } = require('../utils/logger');
const prisma = require('../utils/prisma');
const { installReadOnlyGuard, runReadOnly } = require('../utils/prismaReadOnly');
const { buildReferralNetwork, NetworkRequestError } = require('../services/referralNetwork');

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
    // During the Web3Auth network switch an account whose re-bind is pending still stores its
    // old-network address; every field below then reads it as unbound (networkRebindWallet.js).
    const user = await withPartnerVisibleWallet(resolved.user);
    req.partner = { client, user, token: resolved.token };
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
 * G6, minimal: every successful partner read writes ONE structured `partner.access` line — who
 * (client + DataDance user), when (the logger's timestamp), through which token, and exactly which
 * keys left DataDance. It is a log line: append-only on stdout; durable, tamper-evident storage is
 * log shipping (G7). No token, no field VALUES. `accessLog.write` is replaceable for tests.
 */
const accessLog = { write: (entry) => logger.info('partner.access', entry) };

function recordAccess(req, endpoint, body, extra = {}) {
  const { client, user, token } = req.partner;
  accessLog.write({
    reqId: req.reqId || null,
    clientId: client.clientId,
    userId: user.id,
    tokenId: token.id || null,
    endpoint,
    scope: token.scope,
    fields: Object.keys(body).sort(),
    ...extra,
  });
}

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
  const body = meBody(req);
  recordAccess(req, 'me', body);
  return res.json(body);
});

/**
 * `{ code, inviter_sub, inviter_code, direct_invitees }`. `direct_invitees` is a COUNT for the
 * partner's leaderboard and `inviter_sub` is the one id the user's own upline rebate needs.
 * `inviter_code` (decision 47 A, for the "upline inviter" row of the campaign page) is that
 * inviter's own invite code, shown as "DDC-XXXXXX" like `code` — the code they hand out anyway,
 * never their name or e-mail. Same scope and freeze-list entry as the rest of `referral`.
 * The complete network — every upline and every downline at any depth, as ids and dates only —
 * is GET /partner/tge/referral-network under its own scope (`tge:referral_network`, Sloan's
 * decision of 2026-09-23). Other users' e-mail, name, wallet, points and status never leave here.
 */
function displayCodeOrNull(stored) {
  return isDisplayReferralCode(stored) ? formatReferralCodeForDisplay(stored) : null;
}

async function referralSummary(user) {
  // READ ONLY. This used to call ensureDisplayReferralCode(), which allocates a short code and
  // writes it to the User row — a partner GET mutating DataDance state, with no request of its
  // own in the audit trail and a `$executeRaw` UPDATE behind it. The partner now sees the code
  // only if the user already has one in display form; a legacy code reads as `null`, exactly as
  // the contract's "a display code could not be resolved". Allocation belongs to the Wallet,
  // where the user is present and the write has a reason.
  // Shown as "DDC-XXXXXX" (decision 36); the stored code has no prefix.
  const code = displayCodeOrNull(user.referralCode);
  const [inviter, directInvitees] = await Promise.all([getInviter(user.id), countDirectInvitees(user.id)]);
  return {
    code,
    inviter_sub: inviter ? inviter.id : null,
    // Same read-only rule as `code`: an inviter whose code is still in the legacy form reads as
    // null; it is never allocated from here.
    inviter_code: inviter ? displayCodeOrNull(inviter.referralCode) : null,
    direct_invitees: directInvitees,
  };
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
    recordAccess(req, 'status', body);
    return res.json(body);
  } catch (error) {
    return next(error);
  }
});

// Anything else under /partner/tge is unknown; answer in the same RFC 6750 vocabulary.
/**
 * GET /partner/tge/referral-network — the user's complete referral network (see
 * src/services/referralNetwork.js for the snapshot, pagination and cycle rules).
 * Gates, in order: a valid partner token (401) → this environment serves it (404 not_available,
 * distinct from "not granted") → the token carries `tge:referral_network` (403 insufficient_scope)
 * → the account is active (403 account_disabled). Read-only scope, per-token rate limit, and one
 * G6 access record with the node count returned.
 */
function networkServed(req, res, next) {
  if (!req.partner.client.statusFields.includes('referral_network')) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'not_available', error_description: 'The referral network is not served in this environment.' });
  }
  return next();
}

router.get('/referral-network', requirePartnerToken, readOnlyRequest, networkServed, requireScope('tge:referral_network'), async (req, res, next) => {
  try {
    const { cursor, limit, as_of: asOf } = req.query || {};
    const body = await buildReferralNetwork(req.partner.user.id, { cursor, limit, as_of: asOf });
    res.set('Cache-Control', 'private, max-age=60');
    recordAccess(req, 'referral-network', body, {
      nodeCount: body.downline.nodes.length,
      uplineCount: body.upline.length,
      total: body.downline.total,
      asOf: body.as_of,
      anomalies: body.anomalies || [],
    });
    return res.json(body);
  } catch (error) {
    if (error instanceof NetworkRequestError) return sendError(req, res, 400, 'invalid_request', error.description);
    return next(error);
  }
});

/**
 * The invite-code bind — decision 30 A (Sloan, 2026-09-28), made two-step by item 35 (same day):
 *
 *   "Inside the App the extra DDC Continue page is odd and redundant. The bind scope may be
 *    auto-approved; the partner must show its own second confirmation before binding, and our
 *    backend enforces a programmatic second confirmation."
 *
 *   1. POST /partner/tge/referral/bind/check  { code }
 *        → 200 { valid: true, code: <normalised display code>, confirm_token, expires_in: 120 }
 *          (+ already: true when the code is the inviter the user already has). Writes nothing:
 *          it runs under the read-only guard like every read here.
 *   2. The partner shows ITS OWN confirmation ("确认使用邀请码 DDC-XXXXXX？绑定后不能更改") and, on the
 *      user's tap, sends
 *      POST /partner/tge/referral/bind  { code, confirm_token }
 *        → 200 { bound: true, inviter_sub } (or already: true). No token → 428
 *          confirmation_required; a token that is not /check's answer for this client, this user
 *          and this code, is expired (120 s) or is younger than 1 s → 400 invalid_confirmation.
 *
 * The bind is THE ONE PARTNER WRITE, and deliberately mounted WITHOUT `readOnlyRequest`. TGE will
 * not let a user without an inviter subscribe, so it must be able to bind the code the user typed
 * there. Everything else on this router stays process-enforced read-only: the guard is opened per
 * route, not router-wide, and test/unit/partnerReferralBind.test.js fails if any other route is
 * ever mounted without it.
 *
 * What keeps the write narrow (both steps share every gate):
 *   - it acts only for the token's own user (`sub`); a `sub` / `user_id` in the query or body is
 *     refused, as everywhere on this router;
 *   - it needs its own scope, `tge:referral_bind` (never default-granted), and the environment
 *     must switch it on (SSO_TGE_REFERRAL_BIND; otherwise 404 not_available);
 *   - it runs the same service as POST /api/referrals/use-code (late-bind lock + cycle check,
 *     decision 11 B; reward timing unchanged), and never replaces an existing inviter (29 A);
 *   - the referral kill switch (DISABLE_REFERRAL_REWARDS_FEATURES) refuses it like /api/referrals;
 *   - 10 attempts a minute per access token, /check and /bind counted TOGETHER (one limiter), on
 *     top of the partner limiter — /check answers what the bind would, so it gets no extra budget;
 *   - one audit line per attempt of either step, never the full code or the confirmation token:
 *     `partner.referral_bind_checked` / `partner.referral_bind_check_refused` and
 *     `partner.referral_bound` / `partner.referral_bind_refused`.
 */
function referralBindServed(req, res, next) {
  if (!referralBindEnabled()) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'not_available', error_description: 'Referral binding is not served in this environment.' });
  }
  return next();
}

function referralFeaturesEnabled(req, res, next) {
  if (isReferralRewardsFeaturesDisabled()) {
    return sendError(req, res, 403, 'referral_features_disabled', 'Referral features are temporarily unavailable.');
  }
  return next();
}

/**
 * Audit trail for both steps. Replaceable for tests, like accessLog. No token, no full code: only
 * the first characters of the normalised code, so "DDC-AB23CD" logs "AB…" rather than "DD…".
 */
const BIND_OK_EVENTS = new Set(['partner.referral_bound', 'partner.referral_bind_checked']);
const bindLog = {
  write: (event, entry) => (BIND_OK_EVENTS.has(event) ? logger.info(event, entry) : logger.warn(event, entry)),
};

function recordBindStep(req, step, outcome, code, extra = {}) {
  const { client, user, token } = req.partner;
  const ok = step === 'check' ? outcome === 'valid' || outcome === 'already' : outcome === 'bound' || outcome === 'already';
  const event = step === 'check'
    ? (ok ? 'partner.referral_bind_checked' : 'partner.referral_bind_check_refused')
    : (ok ? 'partner.referral_bound' : 'partner.referral_bind_refused');
  bindLog.write(event, {
    reqId: req.reqId || null,
    clientId: client.clientId,
    userId: user.id,
    tokenId: token.id || null,
    outcome,
    codePrefix: codePrefix(normalizeReferralCodeInput(code)),
    ...extra,
  });
}

/** The body checks both steps share. Returns the code, or null after answering 400. */
function readBindBody(req, res, step) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.sub !== undefined || body.user_id !== undefined) {
    recordBindStep(req, step, 'invalid_request', null);
    sendError(req, res, 400, 'invalid_request', 'The subject is taken from the token; sub/user_id are not accepted.');
    return null;
  }
  const code = parseBindCode(body);
  if (!code) {
    recordBindStep(req, step, 'invalid_request', null);
    sendError(req, res, 400, 'invalid_request', 'code is required: a non-empty invite code string.');
    return null;
  }
  return code;
}

const bindGates = [
  requirePartnerToken,
  referralBindServed,
  requireScope('tge:referral_bind'),
  referralFeaturesEnabled,
  lim('partnerReferralBind'),
];

router.post('/referral/bind/check', ...bindGates, readOnlyRequest, async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const code = readBindBody(req, res, 'check');
  if (!code) return undefined;
  try {
    const result = await checkReferralForPartner(req.partner.user.id, code);
    if (result.status !== 200) {
      recordBindStep(req, 'check', result.outcome, code);
      return res.status(result.status).json(result.body);
    }
    // The token binds the bare stored code, so /bind confirms with the typed, bare or "DDC-" form
    // alike; only the response shows the display form every other endpoint returns (decision 36).
    const { token, expiresIn } = issueConfirmToken({
      clientId: req.partner.client.clientId,
      userId: req.partner.user.id,
      code: result.canonical,
    });
    recordBindStep(req, 'check', result.outcome, code);
    return res.status(200).json({
      valid: true,
      code: formatReferralCodeForDisplay(result.canonical),
      confirm_token: token,
      expires_in: expiresIn,
      ...(result.already ? { already: true } : {}),
    });
  } catch (error) {
    recordBindStep(req, 'check', 'error', code);
    return next(error);
  }
});

const CONFIRMATION_REFUSAL = {
  expired: 'The confirmation has expired; check the code again.',
  too_early: 'The confirmation is less than a second old; the bind must follow the user\'s own confirmation.',
};

router.post('/referral/bind', ...bindGates, async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const code = readBindBody(req, res, 'bind');
  if (!code) return undefined;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const confirmToken = body.confirm_token;
  if (confirmToken === undefined || confirmToken === null || confirmToken === '') {
    recordBindStep(req, 'bind', 'confirmation_required', code);
    return sendError(req, res, 428, 'confirmation_required', 'Call /partner/tge/referral/bind/check first, confirm with the user, then send its confirm_token.');
  }
  try {
    const { canonical } = await resolveBindCode(code);
    const verdict = verifyConfirmToken(confirmToken, {
      clientId: req.partner.client.clientId,
      userId: req.partner.user.id,
      code: canonical,
    });
    if (!verdict.ok) {
      recordBindStep(req, 'bind', 'invalid_confirmation', code, { reason: verdict.reason });
      return sendError(req, res, 400, 'invalid_confirmation',
        CONFIRMATION_REFUSAL[verdict.reason] || 'confirm_token was not issued by /check for this user, client and code.');
    }
    const result = await bindReferralForPartner(req.partner.user.id, code);
    recordBindStep(req, 'bind', result.outcome, code, result.inviterSub ? { inviterSub: result.inviterSub } : {});
    return res.status(result.status).json(result.body);
  } catch (error) {
    recordBindStep(req, 'bind', 'error', code);
    return next(error);
  }
});

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
module.exports.accessLog = accessLog;
module.exports.meBody = meBody;
module.exports.referralSummary = referralSummary;
module.exports.readOnlyRequest = readOnlyRequest;
module.exports.bindLog = bindLog;
