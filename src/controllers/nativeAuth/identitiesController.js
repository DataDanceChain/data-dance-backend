/**
 * /api/auth/native/identities* (contract §2.1 #12–15, design §3.8). The router runs the
 * nativeIdentities limiter and `protect` (DDC session → req.user) before these handlers, and
 * answers 404 before anything while DDC_AUTH_ENABLED is off.
 *
 *   POST   /identities/challenge {action, loginId?, identityId?} → {stepUp, mode}
 *   GET    /identities                                        → [identity summary]
 *   POST   /identities/link {loginId, loginSecret, stepUpSignature | stepUpLoginId+stepUpLoginSecret}
 *                                                             → {identity}
 *   DELETE /identities/:id {stepUpSignature | stepUpLoginId+stepUpLoginSecret} → 204
 *
 * Nothing from the body is logged (loginId, loginSecret, signatures are secrets). Link / unlink
 * notices are sent after the answer; a failed notice never fails the request.
 */
const identities = require('../../services/nativeAuth/identities');
const { sendSuccess, sendNativeError } = require('./respond');

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function requestContext(req) {
  const b = body(req);
  return {
    userAgent: req.get('user-agent') || '',
    country: req.get('cf-ipcountry') || '',
    locale: typeof b.locale === 'string' ? b.locale : '',
  };
}

function options(req) {
  return req.nativeAuthConfig ? { cfg: req.nativeAuthConfig } : {};
}

/** Handlers with an injectable service (tests). */
function createIdentitiesController({ service = identities } = {}) {
  async function challenge(req, res, next) {
    try {
      const data = await service.createStepUpChallenge({ user: req.user, body: body(req), ...options(req) });
      return sendSuccess(res, data);
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  async function list(req, res, next) {
    try {
      const data = await service.listIdentities({ user: req.user });
      return sendSuccess(res, data);
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  async function link(req, res, next) {
    try {
      const { identity } = await service.linkIdentity({ user: req.user, body: body(req), request: requestContext(req), ...options(req) });
      return sendSuccess(res, { identity });
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  async function unlink(req, res, next) {
    try {
      await service.unlinkIdentity({ user: req.user, identityId: req.params.id, body: body(req), request: requestContext(req), ...options(req) });
      return res.status(204).end();
    } catch (err) {
      return sendNativeError(res, next, err);
    }
  }

  return { challenge, list, link, unlink };
}

module.exports = { ...createIdentitiesController(), createIdentitiesController };
