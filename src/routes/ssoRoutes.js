/**
 * Phase 3 — App→browser hand-off (contract ddc-sso-tge-v0.1 `/api/sso/*`, plan §2.8).
 *
 * The Wallet App holds the DDC user JWT inside its WebView and must never hand it to the
 * system browser. Instead it mints a one-time TICKET here, opens
 * `${APP_PUBLIC_URL}/sso/continue#ticket=…` in the SYSTEM browser (fragment only, so no
 * proxy/CDN/referer ever sees it), and that page exchanges the ticket for a consent-only
 * SSO SESSION.
 *
 * Two properties carry the whole design:
 *   - the ticket is single-use. Only its sha256 is stored, and it is consumed with one
 *     conditional `updateMany` (`consumedAt: null`, `expiresAt > now`); the reason for the
 *     failure is read only AFTER that write, so two concurrent exchanges cannot both win.
 *   - the session is consent-only. It is an HS256 JWT signed with a DEDICATED
 *     `SSO_SESSION_SECRET` (never `JWT_SECRET`) and carries the `ddc_sso_` prefix, so
 *     `protect` — which verifies against `JWT_SECRET` — rejects it everywhere else (T12).
 *     Only `GET /api/oauth/requests/:id` and `POST /api/oauth/consent` accept it, and only
 *     for the client it is bound to.
 *
 * Nothing here logs a ticket or a session token; only their ids.
 */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const { protect } = require('../middlewares/authMiddleware');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { createLogger } = require('../utils/logger');
const { appPublicUrl } = require('../constants/lifeContext');
const { getPartnerClient, maskEmail, sha256Hex } = require('../constants/partnerClient');
const { isCEndSubject } = require('../services/dataLicenceConsent');

const router = express.Router();
const logger = createLogger('ssoRoutes');

const passthrough = (req, res, next) => next();
const lim = (name) => (rateLimiters && rateLimiters[name]) || passthrough;

// Mirror of web3authIdentity.EXTERNAL_WALLET_VERIFIER, asserted equal in
// test/unit/ssoHandoff.test.js. Copied rather than imported so that reading an e-mail column
// does not drag the Web3Auth JWKS boot assertion into every module that mounts these routes.
const EXTERNAL_WALLET_VERIFIER = 'external-wallet';

const TICKET_PREFIX = 'tk_';
const TICKET_BYTES = 32;
const SSO_SESSION_PREFIX = 'ddc_sso_';
const SSO_SESSION_AUDIENCE = 'ddc-sso';
const DEFAULT_TICKET_TTL_SEC = 60;
const DEFAULT_SESSION_TTL_SEC = 300;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read on every call so a redeploy-free env change takes effect and tests can set it. */
function ticketTtlSec() {
  return positiveInt(process.env.SSO_TICKET_TTL_SEC, DEFAULT_TICKET_TTL_SEC);
}

function sessionTtlSec() {
  return positiveInt(process.env.SSO_SESSION_TTL_SEC, DEFAULT_SESSION_TTL_SEC);
}

function sessionSecret() {
  return String(process.env.SSO_SESSION_SECRET || '').trim();
}

/** `{ status:'fail', code, message }` — the existing DataDance API error envelope. */
function fail(res, status, code, message) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ status: 'fail', code, message });
}

/**
 * Display hint only. `null` when the account has no usable e-mail, and also when the row is
 * an external-wallet login: those accounts carry the wallet address in the e-mail column
 * (web3authIdentity.accountEmailFor), which must never be shown as an e-mail.
 */
function subjectEmailMasked(user) {
  if (!user || user.web3authVerifier === EXTERNAL_WALLET_VERIFIER) return null;
  return maskEmail(user.email);
}

function newTicket() {
  return `${TICKET_PREFIX}${crypto.randomBytes(TICKET_BYTES).toString('base64url')}`;
}

/** The consent-only session: `ddc_sso_` + HS256 JWT signed with SSO_SESSION_SECRET. */
function signSsoSession({ userId, clientId, jti }, { ttlSec = sessionTtlSec(), now = Date.now() } = {}) {
  const secret = sessionSecret();
  if (!secret) throw new Error('SSO_SESSION_SECRET is not configured');
  const iat = Math.floor(now / 1000);
  const token = jwt.sign(
    { sub: userId, aud: SSO_SESSION_AUDIENCE, cid: clientId, jti, iat, exp: iat + ttlSec },
    secret,
    { algorithm: 'HS256' },
  );
  return { token: `${SSO_SESSION_PREFIX}${token}`, expiresIn: ttlSec };
}

/** Cheap shape test: tells an SSO session apart from a user JWT before any verification. */
function looksLikeSsoSession(token) {
  return typeof token === 'string' && token.startsWith(SSO_SESSION_PREFIX);
}

/**
 * `{ userId, clientId, jti, exp }` for a valid session, `null` for anything else
 * (wrong secret, wrong audience, expired, malformed, or no secret configured).
 */
function verifySsoSession(token) {
  const secret = sessionSecret();
  if (!secret || !looksLikeSsoSession(token)) return null;
  try {
    const claims = jwt.verify(token.slice(SSO_SESSION_PREFIX.length), secret, {
      algorithms: ['HS256'],
      audience: SSO_SESSION_AUDIENCE,
    });
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) return null;
    if (typeof claims.cid !== 'string' || !claims.cid) return null;
    return { userId: claims.sub, clientId: claims.cid, jti: claims.jti || null, exp: claims.exp };
  } catch {
    return null;
  }
}

/**
 * POST /api/sso/app-ticket — auth: user JWT. Body `{ client_id }`.
 * Rate limit after `protect` so the bucket is per user (5/min), not per IP.
 */
router.post('/app-ticket', protect, lim('ssoTicket'), async (req, res, next) => {
  try {
    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id.trim() : '';
    if (!clientId) return fail(res, 400, 'SSO_CLIENT_UNKNOWN', 'client_id is required.');

    const client = getPartnerClient(clientId, req);
    if (!client) return fail(res, 400, 'SSO_CLIENT_UNKNOWN', 'This client is not registered with DataDance.');
    // No initiate_login_uri means the hand-off cannot complete: refuse it here rather than
    // mint a ticket that can only fail at exchange.
    if (!client.enabled || !client.initiateLoginUri) {
      logger.warn('sso.ticket_rejected', { reason: 'client_disabled', clientId: client.clientId, userId: req.user.id });
      return fail(res, 403, 'CLIENT_DISABLED', 'This client is not available.');
    }
    if (!isCEndSubject(req.user)) {
      return fail(res, 403, 'ORG_NOT_ALLOWED', 'Organization accounts cannot sign in to this partner.');
    }
    if (req.user.disabledAt) {
      return fail(res, 403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
    }
    if (client.requireVerifiedSession && !(Number(req.authClaims?.ver) >= 2)) {
      logger.warn('sso.ticket_rejected', { reason: 'unverified_session', clientId: client.clientId, userId: req.user.id });
      return fail(res, 403, 'VERIFIED_SESSION_REQUIRED', 'Please sign in again to continue.');
    }

    const ticket = newTicket();
    const expiresIn = ticketTtlSec();
    const row = await prisma.ssoTicket.create({
      data: {
        ticketHash: sha256Hex(ticket),
        userId: req.user.id,
        clientId: client.clientId,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      },
    });
    logger.info('sso.ticket_minted', {
      ticketId: row.id, userId: req.user.id, clientId: client.clientId, expiresIn,
    });

    res.set('Cache-Control', 'no-store');
    return res.json({
      status: 'success',
      data: {
        ticket,
        expires_in: expiresIn,
        // Fragment, never query: the static host that serves /sso/continue never sees it.
        continue_url: `${appPublicUrl()}/sso/continue#ticket=${encodeURIComponent(ticket)}`,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/sso/ticket/exchange — public. Body `{ ticket }`.
 * The conditional update IS the single-use guarantee; the lookup that distinguishes
 * expired / used / unknown runs only when that update changed nothing.
 */
router.post('/ticket/exchange', lim('ssoExchange'), async (req, res, next) => {
  try {
    const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
    if (!ticket) return fail(res, 400, 'TICKET_INVALID', 'ticket is required.');

    const ticketHash = sha256Hex(ticket);
    const now = new Date();
    const consumed = await prisma.ssoTicket.updateMany({
      where: { ticketHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) {
      const stale = await prisma.ssoTicket.findUnique({ where: { ticketHash } });
      const code = !stale ? 'TICKET_INVALID' : (stale.consumedAt ? 'TICKET_USED' : 'TICKET_EXPIRED');
      logger.warn('sso.exchange_rejected', { reason: code, ticketId: stale ? stale.id : null });
      return fail(res, 400, code, 'This sign-in link is no longer valid. Please try again from the app.');
    }

    const row = await prisma.ssoTicket.findUnique({ where: { ticketHash } });
    const client = getPartnerClient(row.clientId, req);
    if (!client || !client.enabled || !client.initiateLoginUri) {
      logger.warn('sso.exchange_rejected', { reason: 'client_disabled', ticketId: row.id, clientId: row.clientId });
      return fail(res, 403, 'CLIENT_DISABLED', 'This client is not available.');
    }

    const user = await prisma.user.findUnique({ where: { id: row.userId } });
    if (!user) return fail(res, 400, 'TICKET_INVALID', 'This sign-in link is no longer valid.');
    if (user.disabledAt) return fail(res, 403, 'ACCOUNT_DISABLED', 'This account has been disabled.');

    const session = signSsoSession({ userId: user.id, clientId: row.clientId, jti: row.id });
    logger.info('sso.ticket_exchanged', {
      ticketId: row.id, userId: user.id, clientId: row.clientId, expiresIn: session.expiresIn,
    });

    res.set('Cache-Control', 'no-store');
    return res.json({
      status: 'success',
      data: {
        session_token: session.token,
        expires_in: session.expiresIn,
        client: {
          client_id: client.clientId,
          name: client.clientName,
          initiate_login_uri: client.initiateLoginUri,
        },
        subject: { email_masked: subjectEmailMasked(user) },
      },
    });
  } catch (error) {
    return next(error);
  }
});

// The router is the module export (one-line mount in app.js); the session helpers ride along
// so oauthRoutes can accept the same credential without a second copy of the rules.
module.exports = router;
module.exports.signSsoSession = signSsoSession;
module.exports.verifySsoSession = verifySsoSession;
module.exports.looksLikeSsoSession = looksLikeSsoSession;
module.exports.subjectEmailMasked = subjectEmailMasked;
module.exports.SSO_SESSION_PREFIX = SSO_SESSION_PREFIX;
module.exports.SSO_SESSION_AUDIENCE = SSO_SESSION_AUDIENCE;
module.exports.DEFAULT_TICKET_TTL_SEC = DEFAULT_TICKET_TTL_SEC;
module.exports.DEFAULT_SESSION_TTL_SEC = DEFAULT_SESSION_TTL_SEC;
