/**
 * Runtime toggle for emergency shutdown of referral rewards (hub UI + APIs).
 * Set DISABLE_REFERRAL_REWARDS_FEATURES=true on the API server to block
 * referral reward endpoints and strip referral rewards from aggregated award payloads.
 */
function isReferralRewardsFeaturesDisabled() {
  return process.env.DISABLE_REFERRAL_REWARDS_FEATURES === 'true';
}

module.exports = { isReferralRewardsFeaturesDisabled };
