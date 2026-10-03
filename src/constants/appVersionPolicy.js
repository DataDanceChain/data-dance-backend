/**
 * App version policy: the lowest App version each platform may run, served publicly by
 * GET /api/app/version-policy so an App older than the minimum can show "update required" and
 * send the user to the right place. No minimum configured means nothing is ever blocked.
 *
 *   APP_MIN_VERSION_IOS       e.g. 2.1.0. Unset or blank: minVersion is null (nobody is blocked).
 *   APP_MIN_VERSION_ANDROID   e.g. 2.1.0. Same, and it only counts together with the URL below.
 *   APP_STORE_URL_IOS         where an iOS App sends the user to update. Default: our App Store listing.
 *   APP_DOWNLOAD_URL_ANDROID  where an Android App sends the user to update: the APK file, or a page
 *                             that offers it. NO default: downloadUrl is null unless configured.
 *
 * There is deliberately no Android default. The directory https://app.datadance.ai/downloads/
 * answers 403 (no index) and /downloads is the web app's HTML, so neither is a place to send a
 * user; the one working address is an APK file, whose name carries the version and changes with
 * every release. It has to be configured together with the minimum that needs it, and an Android
 * minimum without a usable download URL is ignored (minVersion null) rather than put users in front
 * of an "update required" screen with nowhere to go.
 *
 * Validated once, at boot (initVersionPolicy, called from server.js), each problem with one warning
 * that names the variable(s): a minimum that is not a dotted version number is ignored (treated as
 * unset), an iOS URL that is not https falls back to its default, an Android URL that is not https is
 * treated as unset. The Apps compare the version numerically, so a value they cannot parse must never
 * reach them; failing open (no gate) is the safe side because decision 56 says a backend without
 * this configuration never blocks anyone.
 */

const DEFAULT_IOS_STORE_URL = 'https://apps.apple.com/app/id6743675282';

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
    variables: [variable],
    detail: `${variable} is not a version number like 2.1.0 (2 to 4 dot-separated numbers); ignored, treated as unset`,
    // A version string is not a secret; capped so a pasted blob cannot flood the log.
    value: raw.length > 32 ? `${raw.slice(0, 32)}...` : raw,
  });
  return null;
}

function isHttpsUrl(raw) {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

/** An https URL, or `fallback` when unset. A set value that is not https is a problem; the URL itself is never echoed. */
function httpsUrl(env, variable, fallback, problems) {
  const raw = clean(env[variable]);
  if (!raw) return fallback;
  if (isHttpsUrl(raw)) return raw;
  problems.push({ variables: [variable], detail: `${variable} is not an https URL; using the default` });
  return fallback;
}

/**
 * The policy for one environment, plus every problem found in it. Pure: reads only `env`.
 *
 * @returns {{ policy: { ios: { minVersion: string|null, storeUrl: string },
 *                       android: { minVersion: string|null, downloadUrl: string|null } },
 *             problems: Array<{ variables: string[], detail: string, value?: string }> }}
 */
function buildVersionPolicy(env = process.env) {
  const problems = [];

  const ios = {
    minVersion: minVersion(env, 'APP_MIN_VERSION_IOS', problems),
    storeUrl: httpsUrl(env, 'APP_STORE_URL_IOS', DEFAULT_IOS_STORE_URL, problems),
  };

  // Android has no default URL: null unless configured. A minimum with no usable URL to send the
  // user to is dropped, and that is ONE warning naming both variables, not one per symptom.
  let androidMin = minVersion(env, 'APP_MIN_VERSION_ANDROID', problems);
  const rawUrl = clean(env.APP_DOWNLOAD_URL_ANDROID);
  const urlIsSet = rawUrl !== '';
  const downloadUrl = urlIsSet && isHttpsUrl(rawUrl) ? rawUrl : null;
  if (androidMin && !downloadUrl) {
    problems.push({
      variables: ['APP_MIN_VERSION_ANDROID', 'APP_DOWNLOAD_URL_ANDROID'],
      detail: 'APP_MIN_VERSION_ANDROID is set but APP_DOWNLOAD_URL_ANDROID is '
        + `${urlIsSet ? 'not an https URL' : 'not set'}: the Android minimum is ignored (minVersion null), `
        + 'because an update prompt needs somewhere to send the user',
    });
    androidMin = null;
  } else if (urlIsSet && !downloadUrl) {
    problems.push({ variables: ['APP_DOWNLOAD_URL_ANDROID'], detail: 'APP_DOWNLOAD_URL_ANDROID is not an https URL; ignored (downloadUrl null)' });
  }

  return { policy: { ios, android: { minVersion: androidMin, downloadUrl } }, problems };
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
  VERSION_PATTERN,
  buildVersionPolicy,
  initVersionPolicy,
  getVersionPolicy,
};
