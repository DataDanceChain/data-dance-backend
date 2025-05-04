const { getReferralOverview, claimReferralRewards } = require('../services/referralService');

exports.getReferralOverview = async (req, res) => {
  try {
    const data = await getReferralOverview(req.user.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.claimReferralRewards = async (req, res) => {
  try {
    const result = await claimReferralRewards(req.user.id);
    return res.json({ status: 'success', data: { claimedAt: result.claimedAt, totalPoints: result.totalPoints, count: result.count } });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ status: 'fail', message: error.message });
  }
};

/**
 * Trigger processing of a referral for the current user.
 * Expects { inviterId } in request body.
 */
exports.processReferral = async (req, res) => {
  const newUserId = req.user.id;
  const { inviterId } = req.body;
  if (!inviterId) {
    return res.status(400).json({ status: 'fail', message: 'inviterId is required' });
  }
  try {
    await require('../services/referralService').processReferral(newUserId, inviterId);
    return res.json({ status: 'success', data: { processed: true } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
};