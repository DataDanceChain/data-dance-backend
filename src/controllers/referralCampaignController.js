const {
  getMothersDay2026PublicPayload,
  getSummerTravel2026PublicPayload,
} = require('../constants/referralCampaigns');

/**
 * GET /api/referrals/campaign/mothers-day-2026
 * @access Public
 */
exports.getMothersDay2026 = async (req, res) => {
  try {
    const payload = getMothersDay2026PublicPayload();
    return res.status(200).json({ status: 'success', data: payload });
  } catch (error) {
    console.error('getMothersDay2026 error', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

/**
 * GET /api/referrals/campaign/summer-travel-2026
 * @access Public
 */
exports.getSummerTravel2026 = async (req, res) => {
  try {
    const payload = getSummerTravel2026PublicPayload();
    return res.status(200).json({ status: 'success', data: payload });
  } catch (error) {
    console.error('getSummerTravel2026 error', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
