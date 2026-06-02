const {
  isReferralRewardsFeaturesDisabled,
} = require('../constants/referralRewardsFeature');

function sendReferralFeaturesDisabled(res) {
  return res.status(403).json({
    status: 'fail',
    code: 'REFERRAL_FEATURES_DISABLED',
    message: 'Referral rewards are temporarily unavailable.',
  });
}

/** Use after authentication on referral routers. */
function referralRewardsRouterGate(req, res, next) {
  if (isReferralRewardsFeaturesDisabled()) {
    return sendReferralFeaturesDisabled(res);
  }
  return next();
}

/** Blocks loading tasks for the referral rewards award slug. */
function referralRewardAwardTasksGate(req, res, next) {
  if (
    isReferralRewardsFeaturesDisabled() &&
    req.params.awardId === 'referral-rewards'
  ) {
    return sendReferralFeaturesDisabled(res);
  }
  return next();
}

module.exports = {
  referralRewardsRouterGate,
  referralRewardAwardTasksGate,
  sendReferralFeaturesDisabled,
};
