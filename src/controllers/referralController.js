const prisma = require('../utils/prisma');
const { getReferralOverview, claimReferralRewards, processReferral, getReferralStatus, useReferralCode } = require('../services/referralService');

/**
 * Use referral code (previously invitation code)
 * @route POST /api/referrals/use-code
 * @access Private - Requires authentication
 */
exports.useReferralCode = async (req, res) => {
  try {
    const { code } = req.body;
    const userId = req.user.id;

    if (!code) {
      return res.status(400).json({
        status: 'fail',
        code: 'MISSING_CODE',
        message: 'Please provide a referral code'
      });
    }

    const result = await useReferralCode(userId, code);
    
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