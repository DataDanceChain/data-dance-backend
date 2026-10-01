/**
 * App version policy: the lowest App version each platform may run, served publicly by
 * GET /api/app/version-policy so an App older than the minimum can show "update required" and
 * send the user to the right place. No minimum configured means nothing is ever blocked.
 *
 *   APP_MIN_VERSION_IOS       e.g. 2.1.0. Unset or blank: minVersion is null (nobody is blocked).
 *   APP_MIN_VERSION_ANDROID   e.g. 2.1.0. Same.
 *   APP_STORE_URL_IOS         where an iOS App sends the user to update. Default: our App Store page.
 *   APP_DOWNLOAD_URL_ANDROID  where an Android App sends the user to update. Default: the APK page.
 *
 * Validated once, at boot (initVersionPolicy, called from server.js): a minimum that is not a
 * dotted version number is ignored (treated as unset) and a URL that is not https falls back to its
 * default, each with one warning that names the variable. The Apps compare the version numerically,
 * so a value they cannot parse must never reach them; failing open (no gate) is the safe side
 * because decision 56 says a backend without this configuration never blocks anyone.
 */

const DEFAULT_IOS_STORE_URL = 'https://apps.apple.com/app/id6743675282';
const DEFAULT_ANDROID_DOWNLOAD_URL = 'https://app.datadance.ai/downloads/';

// 2 to 4 dot-separated numbers, no leading zeros: 2.1, 2.1.0, 2.1.0.15. Anything else (a leading
// "v", "-beta", "2.1.x", a bare "2") would make a numeric comparison in the App guess.
const VERSION_PATTERN = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){1,3}$/;

function clean(value) {
  return String(value ?? '').trim();
}

function minVersion(env, variable, problems) {
  const raw = clean(env[variable]);
  if (!raw) return null;
  if (VERSION_PATTERN.test(raw)) return raw;
  problems.push({
    variable,
    detail: `${variable} is not a version number like 2.1.0 (2 to 4 dot-separated numbers); ignored, treated as unset`,
    // A version string is not a secret; capped so a pasted blob cannot flood the log.
    value: raw.length > 32 ? `${raw.slice(0, 32)}...` : raw,
  });
  return null;
}

function httpsUrl(env, variable, fallback, problems) {
  const raw = clean(env[variable]);
  if (!raw) return fallback;
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.protocol === 'https:') return raw;
  // The URL itself is not echoed.
  problems.push({ variable, detail: `${variable} is not an https URL; using the default` });
  return fallback;
}

/**
 * The policy for one environment, plus every problem found in it. Pure: reads only `env`.
 *
 * @returns {{ policy: { ios: { minVersion: string|null, storeUrl: string },
 *                       android: { minVersion: string|null, downloadUrl: string } },
 *             problems: Array<{ variable: string, detail: string, value?: string }> }}
 */
function buildVersionPolicy(env = process.env) {
  const problems = [];
  const policy = {
    ios: {
      minVersion: minVersion(env, 'APP_MIN_VERSION_IOS', problems),
      storeUrl: httpsUrl(env, 'APP_STORE_URL_IOS', DEFAULT_IOS_STORE_URL, problems),
    },
    android: {
      minVersion: minVersion(env, 'APP_MIN_VERSION_ANDROID', problems),
      downloadUrl: httpsUrl(env, 'APP_DOWNLOAD_URL_ANDROID', DEFAULT_ANDROID_DOWNLOAD_URL, problems),
    },
  };
  return { policy, problems };
}

function defaultLog() {
  // Required here, not at the top: building a logger opens the log files, and this module is
  // otherwise free of side effects.
  return require('../utils/logger').createLogger('appVersionPolicy');
}

function deepFreeze(value) {
  for (const inner of Object.values(value)) {
    if (inner && typeof inner === 'object') deepFreeze(inner);
  }
  return Object.freeze(value);
}

let snapshot = null;

/**
 * Boot: validate the environment, warn once per problem, and keep the result as the policy the
 * endpoint serves until the process restarts (an environment change needs a restart anyway).
 * Never throws.
 */
function initVersionPolicy({ env = process.env, log } = {}) {
  const { policy, problems } = buildVersionPolicy(env);
  if (problems.length > 0) {
    const sink = log || defaultLog();
    for (const problem of problems) sink.warn('app_version_policy.invalid_value', problem);
  }
  snapshot = deepFreeze(policy);
  return snapshot;
}

/** The policy to serve. Built from process.env on first use if boot did not get to it. */
function getVersionPolicy() {
  return snapshot || initVersionPolicy();
}

module.exports = {
  DEFAULT_IOS_STORE_URL,
  DEFAULT_ANDROID_DOWNLOAD_URL,
  VERSION_PATTERN,
  buildVersionPolicy,
  initVersionPolicy,
  getVersionPolicy,
};
