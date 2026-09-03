const LIFE_PRIVACY_LEVELS = ['public', 'transparent', 'intimate'];

const DEFAULT_BOUNDARIES = `Do not reveal exact addresses, payment methods, account numbers, government IDs, or private contact details.
Do not quote raw purchase receipts, order IDs, prices, or full chat transcripts.
Stay at the level of taste, rhythm, cities, and stated limits.
If a question needs a private fact, say Data Dance does not include it.`;

const MCP_SERVER_NAME = 'data-dance-life-context';
const MCP_SERVER_VERSION = '0.2.0';
const MCP_INSTRUCTIONS = `You are reading Data Dance lifestyle context: distilled life traces (shopping rhythm, travel, events), not a work inbox and not a wallet dump.
Call get_boundaries first when advice could expose private facts.
Prefer get_life_capsule for a portrait, then search_life_signals for a specific question.
Never invent purchases, trips, or relationships the tools did not return.
Never recite prices, order IDs, or street addresses.`;

function isLifePrivacyLevel(value) {
  return LIFE_PRIVACY_LEVELS.includes(value);
}

function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const forwardedHost = (req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || req.get('host') || 'localhost:10000';
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto =
    forwardedProto || (host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function mcpEndpointUrl(req) {
  return `${publicBaseUrl(req)}/mcp`;
}

function appPublicUrl() {
  const raw = (process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || 'https://app.datadance.ai')
    .split(',')[0]
    .trim();
  return raw.replace(/\/$/, '') || 'https://app.datadance.ai';
}

const MCP_SCOPES = ['openid', 'email', 'profile', 'life_capsule'];

module.exports = {
  LIFE_PRIVACY_LEVELS,
  DEFAULT_BOUNDARIES,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_INSTRUCTIONS,
  MCP_SCOPES,
  isLifePrivacyLevel,
  publicBaseUrl,
  mcpEndpointUrl,
  appPublicUrl,
};
