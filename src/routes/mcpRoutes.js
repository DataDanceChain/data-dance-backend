const express = require('express');
const { MCP_SERVER_NAME, MCP_SERVER_VERSION, mcpEndpointUrl, publicBaseUrl } = require('../constants/lifeContext');
const { findUserByMcpToken } = require('../services/mcpTokenService');
const { handleMcpMessage } = require('../services/mcpProtocol');
const { challengeHeader, metadataDocuments } = require('../services/oauthService');

const router = express.Router();

function applyMcpHeaders(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name',
  );
  res.set(
    'Access-Control-Expose-Headers',
    'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Protocol-Version',
  );
}

function readBearer(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)/i);
  if (match?.[1]) return match[1];
  return typeof req.query.access_token === 'string' ? req.query.access_token : null;
}

router.use((req, res, next) => {
  applyMcpHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

router.get('/', async (req, res) => {
  const token = readBearer(req);
  const user = token ? await findUserByMcpToken(token) : null;
  res.json({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    transport: 'streamable-http',
    auth: 'bearer',
    endpoint: mcpEndpointUrl(req),
    user: user ? user.email : undefined,
  });
});

router.post('/', async (req, res) => {
  const token = readBearer(req);
  const user = token ? await findUserByMcpToken(token) : null;
  if (!user) {
    res.set('WWW-Authenticate', challengeHeader(req));
    return res.status(401).json({ error: 'Connect AI token required.' });
  }

  const { response, notification } = await handleMcpMessage(user.id, req.body);
  if (notification && response === null) return res.status(202).end();
  return res.json(response);
});

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json(metadataDocuments(req).resourceDoc);
});

module.exports = router;
