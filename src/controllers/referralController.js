const { getReferralOverview, claimReferralRewards, processReferral } = require('../services/referralService');

// 获取邀请概览
exports.getReferralOverview = async (req, res) => {
  try {
    const data = await getReferralOverview(req.user.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

// 领取邀请奖励
exports.claimReferralRewards = async (req, res) => {
  try {
    const result = await claimReferralRewards(req.user.id);
    return res.json({ status: 'success', data: result });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ status: 'fail', message: error.message });
  }
};

// 处理新邀请
exports.processReferral = async (req, res) => {
  try {
    const { inviterId } = req.body;
    await processReferral(req.user.id, inviterId);
    return res.json({ status: 'success', data: { processed: true } });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ status: 'fail', message: error.message });
  }
};