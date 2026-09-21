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
  getPartnerClient,
  partnerResourceUrl,
  maskEmail,
} = require('../constants/partnerClient');
const { findUserByPartnerToken } = require('../services/mcpTokenService');
const { hasActiveConsent } = require('../services/dataLicenceConsent');

const router = express.Router();

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

router.use(lim('partner'));

router.get('/me', requirePartnerToken, requireScope('tge:identity'), (req, res) => {
  const { client, user, token } = req.partner;
  res.set('Cache-Control', 'no-store');
  return res.json({
    sub: user.id,
    client_id: token.clientId,
    issued_at: iso(token.issuedAt),
    expires_at: iso(token.expiresAt),
    email_masked: client.statusFields.includes('email_masked') ? maskEmail(user.email) : null,
  });
});

router.get('/status', requirePartnerToken, requireScope('tge:status'), async (req, res, next) => {
  try {
    const { client, user } = req.partner;
    const frozen = new Set(client.statusFields);
    const body = {
      sub: user.id,
      account_status: accountStatus(user),
      registered_at: frozen.has('registered_at') ? iso(user.createdAt) : null,
      wallet_bound: frozen.has('wallet_bound') ? Boolean(user.walletAddress) : null,
      data_licence_granted: frozen.has('data_licence_granted') ? Boolean(await hasActiveConsent(user.id)) : null,
      as_of: new Date().toISOString(),
      cache_max_age: PARTNER_STATUS_CACHE_MAX_AGE_SEC,
    };
    res.set('Cache-Control', `private, max-age=${PARTNER_STATUS_CACHE_MAX_AGE_SEC}`);
    return res.json(body);
  } catch (error) {
    return next(error);
  }
});

// Anything else under /partner/tge is unknown; answer in the same RFC 6750 vocabulary.
router.use((req, res) => sendError(req, res, 404, 'invalid_request', 'Unknown partner endpoint.'));

// Errors thrown inside this router never fall through to the HTML/stack-trace handler.
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => sendError(req, res, 500, 'server_error', 'Unexpected error.'));

module.exports = router;
module.exports.requirePartnerToken = requirePartnerToken;
module.exports.accountStatus = accountStatus;
