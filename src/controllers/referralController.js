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