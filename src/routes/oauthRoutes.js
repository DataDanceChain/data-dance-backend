const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const {
  OAuthError,
  metadataDocuments,
  registerClient,
  startAuthorization,
  getConsentRequest,
  decideConsent,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  revokeToken,
  userInfoFromBearer,
} = require('../services/oauthService');

const router = express.Router();

function sendOAuthError(res, error) {
  const status = error instanceof OAuthError ? error.statusCode : 500;
  const body = {
    error: error instanceof OAuthError ? error.error : 'server_error',
    error_description: error instanceof Error ? error.message : 'Unexpected error.',
  };
  return res.status(status).json(body);
}

function readBearer(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)/i);
  return match?.[1] || null;
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

router.post('/oauth/register', async (req, res) => {
  try {
    return res.status(201).json(await registerClient(req.body || {}));
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

router.get('/oauth/authorize', async (req, res) => {
  try {
    return res.redirect(302, await startAuthorization(req, req.query || {}));
  } catch (error) {
    if (error instanceof OAuthError && req.query.redirect_uri) {
      try {
        const url = new URL(String(req.query.redirect_uri));
        url.searchParams.set('error', error.error);
        url.searchParams.set('error_description', error.description);
        if (req.query.state) url.searchParams.set('state', String(req.query.state));
        return res.redirect(302, url.toString());
      } catch {
        // fall through
      }
    }
    return sendOAuthError(res, error);
  }
});

router.post('/oauth/token', async (req, res) => {
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

router.post('/oauth/revoke', async (req, res) => {
  await revokeToken(req.body?.token || req.body?.refresh_token);
  return res.status(200).json({ revoked: true });
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

router.get('/api/oauth/requests/:id', async (req, res) => {
  try {
    return res.json({ status: 'success', data: await getConsentRequest(req.params.id) });
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

router.post('/api/oauth/consent', protect, async (req, res) => {
  try {
    const allow = req.body?.allow !== false;
    const redirectTo = await decideConsent(req.user, req.body?.requestId, allow);
    return res.json({ status: 'success', data: { redirectTo } });
  } catch (error) {
    return sendOAuthError(res, error);
  }
});

module.exports = router;
