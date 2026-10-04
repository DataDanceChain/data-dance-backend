const { getVersionPolicy: currentVersionPolicy } = require('../constants/appVersionPolicy');

/**
 * GET /api/app/version-policy (public, no auth)
 *
 * { ios: { minVersion, storeUrl }, android: { minVersion, downloadUrl } }
 *
 * minVersion is null when none is configured; the App then never blocks. The values are the ones
 * validated at boot (src/constants/appVersionPolicy.js), so this handler cannot fail on bad input.
 */
exports.getVersionPolicy = (req, res) => {
  // A forced-update gate must never be answered from a stale cache.
  res.set('Cache-Control', 'no-store');
  return res.json(currentVersionPolicy());
};
