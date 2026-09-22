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

/**
 * The OAuth issuer and the audience of every token this server mints.
 *
 * PUBLIC_BASE_URL is REQUIRED. There used to be a fallback to `x-forwarded-host` / `Host`, which
 * let the issuer — the value a partner checks with `iss` (RFC 9207) and the value token audiences
 * are compared against — be chosen by whoever sent the request: one forged header and a token
 * bears someone else's issuer, or the discovery document points the client at another host. An
 * identifier that names US cannot come from THEM. `req` is accepted and ignored so call sites
 * read the same as before.
 */
// eslint-disable-next-line no-unused-vars
function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (!configured) {
    throw new Error(
      'PUBLIC_BASE_URL is required: it is the OAuth issuer and the audience of every token this ' +
        'server mints, and it must never be derived from a request header. Set it to this API\'s ' +
        'public origin, e.g. https://api.datadance.ai (or http://localhost:3000 for local work).'
    );
  }
  return configured;
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
