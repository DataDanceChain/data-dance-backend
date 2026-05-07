const prisma = require('../utils/prisma');
const {
  getReferralOverview,
  claimReferralRewards,
  getReferralStatus,
  useReferralCode,
  countCampaignInvitesAsInviter,
} = require('../services/referralService');
const { MOTHERS_DAY_2026_SLUG } = require('../constants/referralCampaigns');

/**
 * Use referral code (previously invitation code)
 * @route POST /api/referrals/use-code
 * @access Private - Requires authentication
 */
exports.useReferralCode = async (req, res) => {
  try {
    const { code, campaign, referralCampaign } = req.body;
    const userId = req.user.id;

    if (!code) {
      return res.status(400).json({
        status: 'fail',
        code: 'MISSING_CODE',
        message: 'Please provide a referral code'
      });
    }

    const result = await useReferralCode(userId, code, campaign ?? referralCampaign);
    
    return res.status(200).json({
      status: 'success',
      message: 'Referral code used successfully',
      data: result
    });
  } catch (error) {
    console.error('Error using referral code:', error);
    
    if (error.code === 'ALREADY_REFERRED') {
      return res.status(409).json({
        status: 'fail',
        code: error.code,
        message: error.message,
        data: error.data
      });
    }
    
    if (error.code === 'INVALID_CODE') {
      return res.status(404).json({
        status: 'fail',
        code: error.code,
        message: error.message
      });
    }
    
    if (error.code === 'SELF_REFERRAL_NOT_ALLOWED') {
      return res.status(400).json({
        status: 'fail',
        code: error.code,
        message: error.message
      });
    }

    if (error.code === 'INVALID_CAMPAIGN' || error.code === 'CAMPAIGN_INACTIVE' || error.code === 'CAMPAIGN_REQUIRES_REFERRAL_CODE') {
      return res.status(400).json({
        status: 'fail',
        code: error.code,
        message: error.message
      });
    }

    // Log detailed error for debugging
    console.error('Unexpected error in useReferralCode:', error);
    
    return res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Get referral overview
 * @route GET /api/referrals/overview
 * @access Private - Requires authentication
 */
exports.getReferralOverview = async (req, res) => {
  try {
    const data = await getReferralOverview(req.user.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    console.error('Error getting referral overview:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

/**
 * Get detailed referral status including invitation info if user was invited
 * @route GET /api/referrals/status
 * @access Private - Requires authentication
 */
exports.getReferralStatus = async (req, res) => {
  try {
    const data = await getReferralStatus(req.user.id);
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('Error getting referral status:', error);
    return res.status(500).json({
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'Error getting referral status'
    });
  }
};

/**
 * Claim referral rewards
 * @route POST /api/referrals/claim-rewards
 * @access Private - Requires authentication
 */
exports.claimReferralRewards = async (req, res) => {
  try {
    const result = await claimReferralRewards(req.user.id);
    return res.json({ status: 'success', data: result });
  } catch (error) {
    console.error('Error claiming referral rewards:', error);
    return res.status(400).json({ status: 'fail', message: error.message });
  }
};

/**
 * Mother's Day campaign invite count for current user
 * @route GET /api/referrals/campaign/mothers-day-2026/stats
 * @access Private
 */
exports.getMothersDay2026Stats = async (req, res) => {
  try {
    const successfulInvites = await countCampaignInvitesAsInviter(req.user.id, MOTHERS_DAY_2026_SLUG);
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { referralCode: true },
    });
    return res.status(200).json({
      status: 'success',
      data: {
        slug: MOTHERS_DAY_2026_SLUG,
        successfulInvites,
        ownReferralCode: user?.referralCode ?? '',
      },
    });
  } catch (error) {
    console.error('getMothersDay2026Stats error', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};