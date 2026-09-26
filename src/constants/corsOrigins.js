/**
 * Browser origins allowed to call this API with credentials.
 *
 * Production and development are two different lists, and `http://localhost:5174` belongs only
 * to the second one. It used to sit in the production list, where it means: a page served from
 * the developer port on any machine the user is signed in from may read authenticated responses
 * — including the SSO consent endpoints. Nothing on the money path needs that.
 */
const LOCAL_FRONTEND_ORIGINS = Object.freeze([
  'http://localhost:8100',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
]);

/** Deployed first-party front-ends. No loopback, no developer ports. */
const PUBLIC_ORIGINS = Object.freeze([
  'https://app.datadance.ai',
  'https://business.datadance.ai',
  'https://admin.datadance.ai',
]);

function configuredOrigins(env = process.env) {
  return String(env.FRONTEND_URL || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The `origin` value for `cors()`: the deployed list (plus anything FRONTEND_URL names) as soon
 * as either is present or NODE_ENV=production; otherwise the local development list.
 */
function corsOrigins(env = process.env) {
  const configured = configuredOrigins(env);
  if (configured.length || env.NODE_ENV === 'production') {
    return [...new Set([...configured, ...PUBLIC_ORIGINS])];
  }
  return [...LOCAL_FRONTEND_ORIGINS];
}

module.exports = { corsOrigins, configuredOrigins, LOCAL_FRONTEND_ORIGINS, PUBLIC_ORIGINS };
