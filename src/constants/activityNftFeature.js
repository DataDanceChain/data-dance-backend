/**
 * ACTIVITY_NFT_ENABLED switches POST /api/activities/new (create an activity and its NFT contract).
 *
 * Default off: unset, or anything but "true" (any case), and the endpoint answers 503
 * ACTIVITY_NFT_UNAVAILABLE before any chain or database work and before an upload is stored.
 * "true" defers to the chain layer, which still refuses today and says why in the server log
 * (activityNftUnavailableReason in src/utils/web3Utils.js). Read on every request, never cached.
 */
function isActivityNftEnabled(env = process.env) {
  return String(env.ACTIVITY_NFT_ENABLED || '').trim().toLowerCase() === 'true';
}

module.exports = { isActivityNftEnabled };
