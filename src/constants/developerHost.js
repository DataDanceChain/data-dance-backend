/** Dedicated developer-host authority. It never infers Wallet network from prod/test. */
const NETWORKS = ['mainnet', 'devnet'];
const SCOPES = ['developer', 'docs.internal', 'docs.review_projects'];
function origin(value, env) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('DEVELOPER_HOST_CONFIG_INVALID'); }
  const local = env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname) && url.port;
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('DEVELOPER_HOST_CONFIG_INVALID');
  return url.origin;
}
function readDeveloperHostConfig(env = process.env) {
  const environment = String(env.DEVELOPER_HOST_NETWORK || '').trim();
  if (!NETWORKS.includes(environment)) throw new Error('DEVELOPER_HOST_CONFIG_INVALID');
  const portalOrigin = origin(env.DEVELOPER_PORTAL_URL, env);
  return { environment, portalOrigin, callbackUri: `${portalOrigin}/auth/callback`, walletOrigin: origin(env.DEVELOPER_WALLET_URL, env), issuer: origin(env.PUBLIC_BASE_URL, env) };
}
function walletDeveloperClaims(env = process.env) {
  const network = String(env.DEVELOPER_HOST_NETWORK || '').trim();
  if (!NETWORKS.includes(network)) return {};
  try { return { developerNetwork: network, developerIssuer: origin(env.PUBLIC_BASE_URL, env) }; } catch { return {}; }
}
function hostScopes(value) {
  if (value === undefined) return ['developer'];
  if (!Array.isArray(value) || value.some(scope => !SCOPES.includes(scope))) throw new Error('DEVELOPER_HOST_SCOPE_INVALID');
  return SCOPES.filter(scope => scope === 'developer' || value.includes(scope));
}
module.exports = { readDeveloperHostConfig, walletDeveloperClaims, hostScopes };
