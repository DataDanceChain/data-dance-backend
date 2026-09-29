/**
 * GET /api/auth/native/x/start, GET /x/callback, POST /x/exchange (contract §2.1 rows 7–9, §2.6,
 * design §3.5). Reached only while DDC_AUTH_ENABLED=true and `x` is in DDC_AUTH_METHODS (the
 * router answers 404 before); /x/start runs behind nativeXStart and /x/exchange behind nativeIdp.
 *
 * start and callback are top-level browser navigations: they answer with redirects (the X
 * authorize page, or the configured return URL with a `#handoff=` / `#error=` fragment), except
 * for an unknown or disabled platform (404 METHOD_DISABLED) and a server without a usable return
 * URL (503 IDP_UNAVAILABLE), where there is nowhere safe to send the browser.
 *
 * exchange answers `Identified` (JSON). A hand-off started with intent 'link' needs the caller's
 * bearer session; the link attempt is created only then (identify.createLoginAttempt with
 * bearerUser), never at the callback, which has no session.
 *
 * Nothing from the query, the cookie or the body is logged here (idpX logs reasons only).
 */
const { protect } = require('../../middlewares/authMiddleware');
const idpX = require('../../services/nativeAuth/idpX');
const { logger, readNativeAuthConfig } = require('../../services/nativeAuth/config');
const { sendSuccess, sendError, sendNativeError } = require('./respond');

const COOKIE_OPTIONS = Object.freeze({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/** The __Host-ddc_xlogin value from the Cookie header (no cookie parser is mounted). */
function readLoginCookie(req) {
  const header = req.headers && req.headers.cookie;
  if (typeof header !== 'string' || !header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== idpX.COOKIE_NAME) continue;
    const value = part.slice(index + 1).trim();
    return value.length <= 256 ? value : undefined;
  }
  return undefined;
}

function redirect(res, url) {
  res.set('Referrer-Policy', 'no-referrer');
  return res.redirect(302, url);
}

/**
 * Handlers with injectable collaborators (tests): `idp` is idpX, `authenticate` an Express
 * middleware that sets req.user or answers 401 itself, `identify` the identify module.
 */
function createXController({
  idp = idpX,
  authenticate = protect,
  identify = () => require('../../services/nativeAuth/identify'),
  config = (req) => req.nativeAuthConfig,
} = {}) {
  const cfgFor = (req) => config(req) || readNativeAuthConfig();

  async function start(req, res, next) {
    try {
      const { redirectUrl, cookie } = await idp.startXLogin({ query: req.query || {}, cfg: cfgFor(req) });
      res.cookie(cookie.name, cookie.value, { ...COOKIE_OPTIONS, maxAge: cookie.maxAgeSec * 1000 });
      return redirect(res, redirectUrl);
    } catch (err) {
      if (err instanceof idp.XLoginError) {
        if (err.kind === 'platform') return sendError(res, 'METHOD_DISABLED');
        if (err.kind === 'request') {
          try {
            return redirect(res, idp.errorRedirect('x_failed', err.platform, cfgFor(req)));
          } catch {
            // fall through to the misconfiguration answer
          }
        }
        logger.error('native_auth.x_misconfigured', { reason: err.reason });
        return sendError(res, 'IDP_UNAVAILABLE', { message: 'X sign-in is not available right now.' });
      }
      return next(err);
    }
  }

  async function callback(req, res, next) {
    const cookieValue = readLoginCookie(req);
    res.clearCookie(idpX.COOKIE_NAME, COOKIE_OPTIONS);
    try {
      const { redirectUrl } = await idp.handleXCallback({ query: req.query || {}, cookieValue, req, cfg: cfgFor(req) });
      return redirect(res, redirectUrl);
    } catch (err) {
      if (!(err instanceof idp.XLoginError)) logger.error('native_auth.x_callback_error', { reason: 'internal', error: err && err.name });
      try {
        return redirect(res, idp.fallbackErrorRedirect('x_failed', cookieValue, cfgFor(req)));
      } catch {
        return err instanceof idp.XLoginError ? sendError(res, 'IDP_UNAVAILABLE', { message: 'X sign-in is not available right now.' }) : next(err);
      }
    }
  }

  async function exchange(req, res, next) {
    try {
      const { handoff, verifier } = body(req);
      const redeemed = await idp.redeemXHandoff({ handoff, verifier, cfg: cfgFor(req) });
      if (redeemed.intent !== 'link') return sendSuccess(res, redeemed.identified);
      return authenticate(req, res, async (authErr) => {
        if (authErr) return next(authErr);
        try {
          const identified = await identify().createLoginAttempt({
            identity: redeemed.identity,
            intent: 'link',
            method: 'x',
            req,
            bearerUser: req.user,
            cfg: cfgFor(req),
          });
          return sendSuccess(res, identified);
        } catch (err) {
          return sendNativeError(res, next, err);
        }
      });
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  return { start, callback, exchange };
}

module.exports = { ...createXController(), createXController, readLoginCookie };
