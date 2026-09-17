const {
  getMothersDay2026PublicPayload,
  getSummerTravel2026PublicPayload,
} = require('../constants/referralCampaigns');
const { resolveStayBonusRules } = require('../utils/stayBonus');

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
    const rules = await resolveStayBonusRules();
    if (!rules) {
      return res.status(200).json({
        status: 'success',
        data: { ...payload, sites: ['airbnb', 'booking'] },
      });
    }
    const siteLabels = rules.sites.join(' or ');
    return res.status(200).json({
      status: 'success',
      data: {
        ...payload,
        title: rules.titleEn || payload.title,
        subtitle: rules.blurbEn || payload.subtitle,
        isActive: rules.isActive,
        startsAt: rules.startUtc instanceof Date ? rules.startUtc.toISOString() : payload.startsAt,
        endsAt: rules.endUtc instanceof Date ? rules.endUtc.toISOString() : payload.endsAt,
        stayStartDate: rules.stayStartDate,
        stayEndDate: rules.stayEndDate,
        pointsPerOrder: rules.pointsPerOrder,
        uploadBonusPerItem: rules.bonusPerItem,
        inviterPoints: rules.inviterPoints,
        inviteePoints: rules.inviteePoints,
        sites: rules.sites,
        siteLabels,
      },
    });
  } catch (error) {
    console.error('getSummerTravel2026 error', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
