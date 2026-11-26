const crypto = require('crypto');
const { sha256Hex } = require('../constants/partnerClient');

const START = 'https://dataplanet.cc/pages/oauth/start';
const CALLBACK = 'https://dataplanet.cc/pages/oauth/callback';
const READ_SCOPES = new Set(['sso:identity', 'sso:status', 'sso:wallet', 'sso:email']);
const TTL_MS = 60000;

// The official registration stays on manual approval even when the dedicated setting is absent.
function isPlanetRegistration(client) {
  return Boolean(client && (client.clientId === process.env.SSO_WALLET_PLANET_CLIENT_ID ||
    client.initiateLoginUri === START || client.redirectUris?.includes(CALLBACK)));
}

function configuredPlanet(client) {
  return Boolean(client?.enabled && client.firstParty === true &&
    client.clientId === process.env.SSO_WALLET_PLANET_CLIENT_ID &&
    client.initiateLoginUri === START && client.redirectUris?.includes(CALLBACK));
}

function eligibleRequest(client, row) {
  const scopes = String(row.scope || '').trim().split(/\s+/);
  return configuredPlanet(client) && row.redirectUri === CALLBACK && Boolean(row.initiatorHash) &&
    scopes.includes('sso:identity') && scopes.every(scope => READ_SCOPES.has(scope));
}

function usableSince() {
  return { gt: new Date(Date.now() - TTL_MS) };
}

// Called only on the successful single-use ticket exchange. The opaque handle cannot sign in.
async function issueWalletOpen(db, ticketId, browserNonce) {
  const handle = crypto.randomBytes(32).toString('base64url');
  await db.ssoTicket.update({
    where: { id: ticketId },
    data: { walletOpenHash: sha256Hex(handle), walletOpenBrowserHash: sha256Hex(browserNonce) },
  });
  return handle;
}

async function bindWalletOpen(db, client, row, handle) {
  if (!eligibleRequest(client, row) || typeof handle !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(handle)) return;
  // A single conditional update elects one already validated PKCE request. A miss stays manual.
  await db.ssoTicket.updateMany({
    where: { walletOpenHash: sha256Hex(handle), walletOpenBrowserHash: row.initiatorHash,
      clientId: row.clientId, consumedAt: usableSince(), walletOpenAuthorizationId: null },
    data: { walletOpenAuthorizationId: row.id },
  });
}

function decisionBinding(row, session) {
  if (!session?.jti || !session.userId || session.clientId !== row.clientId) return null;
  return { id: session.jti, userId: session.userId, clientId: row.clientId,
    walletOpenAuthorizationId: row.id, walletOpenBrowserHash: row.initiatorHash,
    walletOpenHash: { not: null }, consumedAt: usableSince() };
}

module.exports = { isPlanetRegistration, configuredPlanet, eligibleRequest, issueWalletOpen, bindWalletOpen, decisionBinding };
