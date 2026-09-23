const express = require('express');
const prisma = require('../utils/prisma');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { createLogger } = require('../utils/logger');
const { PARTNER_REALM, getPartnerClient, verifyClientSecret } = require('../constants/partnerClient');
const { verifySsoSession, looksLikeSsoSession } = require('./ssoRoutes');
const {
  OAuthError,
  ConsentInitiatorError,
  readInitiatorNonce,
  metadataDocuments,
  registerClient,
  startAuthorization,
  getConsentRequest,
  decideConsent,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  revokeToken,
  userInfoFromBearer,
  presentedClientCredentials,
} = require('../services/oauthService');

const router = express.Router();
const logger = createLogger('oauthRoutes');

// Limiters are defined on the hardening branch; until it is merged they are pass-through.
const passthrough = (req, res, next) => next();
const lim = (name) => (rateLimiters && rateLimiters[name]) || passthrough;

function logUnexpected(error) {
  logger.error('OAuth endpoint failed', { message: error && error.message, name: error && error.name });
}

/**
 * The one answer that is neither success nor an OAuth error: the consent came from a browser
 * that did not start this authorization (item 1). The Wallet renders it as "this sign-in was
 * started on another device or browser — start again from {client}"; nothing is redirected and
 * no code exists (an OAuth error here would have to travel to `redirect_uri`, i.e. to the
 * attacker who set the request up).
 */
function sendInitiatorMismatch(res, error) {
  res.set('Cache-Control', 'no-store');
  return res.status(409).json({
    status: 'fail',
    code: error.code,
    message: error.clientName
      ? `This sign-in was started on another device or browser. Start again from ${error.clientName}.`
      : 'This sign-in was started on another device or browser. Start again from the application.',
    data: { reason: error.reason, clientId: error.clientId, clientName: error.clientName },
  });
}

/** OAuthError → its status/code; anything else → 500 server_error with NO internal detail. */
function sendOAuthError(res, error) {
  if (error instanceof ConsentInitiatorError) return sendInitiatorMismatch(res, error);
  const known = error instanceof OAuthError;
  if (!known) logUnexpected(error);
  const status = known ? error.statusCode : 500;
  const body = {
    error: known ? error.error : 'server_error',
    error_description: known ? error.description : 'Unexpected error.',
  };
  if (status === 401 && body.error === 'invalid_client') {
    res.set('WWW-Authenticate', `Basic realm="${PARTNER_REALM}"`);
  }
  res.set('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Authorize-time failures that happen BEFORE client + redirect_uri are validated must never
 * leave the browser at an unregistered URI (RFC 6749 §4.1.2.1, RFC 9700 §4.11): render a page.
 */
function sendAuthorizeErrorPage(res, error) {
  if (!(error instanceof OAuthError)) logUnexpected(error);
  const status = error instanceof OAuthError ? error.statusCode : 500;
  const code = error instanceof OAuthError ? error.error : 'server_error';
  const description = error instanceof OAuthError ? error.description : 'Unexpected error.';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>DataDance sign-in could not start</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#1c1f26;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
  main{background:#fff;border-radius:12px;max-width:440px;width:100%;padding:28px 24px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
  h1{font-size:1.2rem;margin:0 0 12px}
  p{margin:0 0 10px;line-height:1.5}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f0f1f4;padding:2px 6px;border-radius:6px;font-size:.92em}
  .muted{color:#5c6270;font-size:.92rem}
</style>
</head>
<body>
<main>
<h1>Sign-in could not start</h1>
<p>The application that sent you here is not registered correctly with DataDance, so we stopped before redirecting you anywhere.</p>
<p><code>${escapeHtml(code)}</code> — ${escapeHtml(description)}</p>
<p class="muted">Nothing was shared. Close this tab and start again from the application; if it keeps failing, contact the application's support.</p>
</main>
</body>
</html>`;
  res.set('Cache-Control', 'no-store');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.set('Referrer-Policy', 'no-referrer');
  return res.status(status).type('html').send(html);
}

function readBearer(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)/i);
  return match?.[1] || null;
}

/** The one answer the Wallet page acts on: drop the session and log in normally. */
function ssoSessionExpired(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(401).json({
    status: 'fail',
    code: 'SSO_SESSION_EXPIRED',
    message: 'This sign-in session has expired. Please sign in again.',
  });
}

/**
 * The request summary stays readable without a credential (the consent page loads it before
 * any login), but a credential that IS presented must be usable: a partner access token, an
 * MCP token or a stale JWT gets 401, never a free read (contract security: userJwt|ssoSession,
 * T12.5).
 */
function bearerMustVerify(req, res, next) {
  return readBearer(req) ? protect(req, res, next) : next();
}

/**
 * Phase 3: the two consent endpoints additionally accept the consent-only SSO session
 * (`ddc_sso_…`, contract ddc-sso-tge-v0.1), which is recognised by its prefix and verified
 * with SSO_SESSION_SECRET. Every other credential — above all the user JWT the MCP consent
 * flow uses — falls through to `fallback` unchanged.
 *
 * A session that does not verify (wrong secret, expired, unknown subject) is 401
 * `SSO_SESSION_EXPIRED`; which client it may answer for is decided further down, by
 * `decideConsent` for a decision and by the handler for the request summary.
 */
function consentPrincipal(fallback) {
  return async (req, res, next) => {
    const token = readBearer(req);
    if (!looksLikeSsoSession(token)) return fallback(req, res, next);
    const claims = verifySsoSession(token);
    if (!claims) return ssoSessionExpired(res);
    try {
      const user = await prisma.user.findUnique({ where: { id: claims.userId } });
      if (!user) return ssoSessionExpired(res);
      req.user = user;
      // Consumed by decideConsent as ctx.clientId: the session may only answer for its client.
      req.ssoSession = { clientId: claims.clientId, jti: claims.jti };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(metadataDocuments(req).as);
});

router.get('/.well-known/openid-configuration', (req, res) => {
  res.json({
    ...metadataDocuments(req).as,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['none'],
  });
});

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json(metadataDocuments(req).resourceDoc);
});

router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.json(metadataDocuments(req).resourceDoc);
});

router.get('/.well-known/oauth-protected-resource/partner/tge', (req, res) => {
  res.json(metadataDocuments(req).partnerResourceDoc);
});

router.post('/oauth/register', lim('oauthRegister'), async (req, res) => {
  try {
    return res.status(201).json(await registerClient(req.body || {}));
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

router.get('/oauth/authorize', lim('oauthAuthorize'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // `res` carries the `__Host-ddc_authz` cookie this authorization is bound to (item 1).
    return res.redirect(302, await startAuthorization(req, req.query || {}, res));
  } catch (error) {
    if (error instanceof OAuthError && error.redirectable && error.redirectTo) {
      return res.redirect(302, error.redirectTo);
    }
    return sendAuthorizeErrorPage(res, error);
  }
});

/**
 * The confidential client whose credentials THIS request presents and which VERIFY (enabled partner
 * client, correct secret), or null. Cheap: one sha256 per request, no database. Any malformed or
 * ambiguous credential is simply "not authenticated" here — the handler still answers it properly.
 */
function verifiedConfidentialClientId(req) {
  try {
    const presented = presentedClientCredentials(req, req.body || {});
    if (!presented || !presented.clientSecret) return null;
    const client = getPartnerClient(presented.clientId, req);
    if (!client || !client.enabled) return null;
    return verifyClientSecret(client, presented.clientSecret) ? client.clientId : null;
  } catch {
    return null;
  }
}

/**
 * /oauth/token limiting (A4). The partner exchanges every user's code from ONE server IP, so a
 * per-IP budget that also counts its authenticated exchanges caps the whole campaign (it was 20 a
 * minute). Therefore:
 *   - verified confidential client → per-client_id ceiling only (OAUTH_TOKEN_CLIENT_MAX_PER_MIN,
 *     default 3000; a runaway-loop catcher, not a security control). Its successes AND its
 *     invalid_grant answers (double submits, expired codes — ordinary user behaviour at campaign
 *     scale) never spend the per-IP budget;
 *   - everything else — no/unknown client authentication, a wrong secret, public (MCP) clients —
 *     → the per-IP limiter as before, counted on entry. That is the brute-force surface: nobody
 *     without the secret gets past it, and codes/verifiers of public clients stay IP-limited.
 */
function tokenRateLimit(req, res, next) {
  const clientId = verifiedConfidentialClientId(req);
  if (clientId) {
    req.oauthTokenClientId = clientId;
    return lim('oauthTokenClient')(req, res, next);
  }
  return lim('oauthToken')(req, res, next);
}

router.post('/oauth/token', tokenRateLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  try {
    const body = req.body || {};
    if (body.grant_type === 'authorization_code') {
      return res.json(await exchangeAuthorizationCode(req, body));
    }
    if (body.grant_type === 'refresh_token') {
      return res.json(await exchangeRefreshToken(body));
    }
    throw new OAuthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

router.post('/oauth/revoke', lim('oauthRevoke'), async (req, res) => {
  try {
    const body = req.body || {};
    await revokeToken(body.token || body.refresh_token, { req, body });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ revoked: true });
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

router.get('/oauth/userinfo', async (req, res) => {
  try {
    const token = readBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'invalid_token', error_description: 'Bearer token required.' });
    }
    return res.json(await userInfoFromBearer(token));
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

router.get('/api/oauth/requests/:id', consentPrincipal(bearerMustVerify), async (req, res) => {
  try {
    const data = await getConsentRequest(req.params.id);
    if (req.ssoSession && req.ssoSession.clientId !== data.clientId) {
      logger.warn('SSO session presented for another client', { requestId: req.params.id });
      res.set('Cache-Control', 'no-store');
      return res.status(401).json({
        status: 'fail',
        code: 'UNAUTHORIZED',
        message: 'This session is bound to a different client.',
      });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', data });
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

/**
 * Parse the consent decision. `express.urlencoded` is mounted before these routes, so a
 * form-encoded `allow=false` arrives as the STRING "false" — truthy. Only a real boolean `true`
 * or the string "true" is consent; anything else present is a denial; absent is malformed.
 * Returns true | false | null (absent).
 */
function parseAllow(value) {
  if (value === true || value === 'true') return true;
  if (value === undefined || value === null) return null;
  return false;
}

// The limiter runs AFTER the principal is known, so its `userOrIp` key is the user: one person's
// decisions never throttle everyone else behind the same NAT (event Wi-Fi, carrier CGNAT). Before
// the mount-order fix this was only true by accident (an earlier router's `protect` set req.user).
router.post('/api/oauth/consent', consentPrincipal(protect), lim('consent'), async (req, res) => {
  try {
    const allow = parseAllow(req.body?.allow);
    if (allow === null) {
      throw new OAuthError(400, 'invalid_request', 'allow must be true or false.');
    }
    // req.authClaims is set by `protect` (P0 verified-login claims); an SSO session carries no
    // claims of its own — the verified-login check happened when the ticket was minted.
    const initiatorNonce = readInitiatorNonce(req);
    const ctx = req.ssoSession
      ? { kind: 'sso_ticket', clientId: req.ssoSession.clientId, initiatorNonce }
      : { kind: 'user_jwt', claims: req.authClaims, initiatorNonce };
    const redirectTo = await decideConsent(req.user, req.body?.requestId, allow, ctx);
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', data: { redirectTo } });
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

module.exports = router;
