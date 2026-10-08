const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const {
  createDeveloperClient,
  listOwnedClients,
  updateOwnedClient,
  rotateOwnedSecret,
} = require('../services/ssoDeveloperLive');

const router = express.Router();
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const recent = (hits.get(ip) || []).filter((at) => now - at < windowMs);
  if (recent.length >= 5) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('Developer client request failed', error && error.message);
  return res.status(status).json({
    error: error.code || 'server_error',
    error_description: status >= 500 ? 'Could not complete that request.' : error.message,
  });
}

async function requireUser(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !process.env.JWT_SECRET) {
      return res.status(401).json({
        error: 'login_required',
        error_description: 'Sign in with DataDance first.',
      });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || typeof decoded.id !== 'string' || !decoded.id) {
      return res.status(401).json({
        error: 'login_required',
        error_description: 'Sign in with DataDance first.',
      });
    }
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user || user.disabledAt) {
      return res.status(401).json({
        error: 'login_required',
        error_description: 'Sign in with DataDance first.',
      });
    }
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({
      error: 'login_required',
      error_description: 'Sign in with DataDance first.',
    });
  }
}

function issued(created) {
  return {
    client_id: created.clientId,
    client_secret: created.clientSecret,
    client_name: created.clientName,
    redirect_uris: created.redirectUris,
    token_endpoint_auth_method: 'client_secret_post',
    issuer: created.issuer,
    authorization_endpoint: `${created.issuer}/oauth/authorize`,
    token_endpoint: `${created.issuer}/oauth/token`,
    userinfo_endpoint: `${created.issuer}/partner/sso/me`,
    resource: created.resource,
    scopes: created.scopes,
  };
}

router.use(requireUser);

router.get('/clients', async (req, res) => {
  try {
    const clients = await listOwnedClients(req.user.id);
    return res.json({
      email: req.user.email,
      clients,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/clients', async (req, res) => {
  try {
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
    if (limited(ip)) {
      return res.status(429).json({
        error: 'rate_limited',
        error_description: 'Too many client registrations from this address. Please wait an hour.',
      });
    }
    const created = await createDeveloperClient(req.body || {}, req.user);
    return res.status(201).json(issued(created));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/clients/update', async (req, res) => {
  try {
    const updated = await updateOwnedClient(req.user.id, req.body || {});
    return res.json(updated);
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/clients/secret', async (req, res) => {
  try {
    const rotated = await rotateOwnedSecret(req.user.id, req.body && req.body.client_id);
    return res.json(rotated);
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
