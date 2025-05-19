const { init: initCuid } = require('@paralleldrive/cuid2');
const prisma = require('./prisma');
const { createLogger } = require('./logger');

const logger = createLogger('referralUtils');

// Initialize cuid generator with custom configuration
const createId = initCuid({
  length: 8  // Shorter length for referral codes
});

/**
 * Generate a unique referral code for a new user
 * @returns {string} A unique referral code
 */
function generateReferralCode() {
  return `DD-${createId()}`;
}

/**
 * Validate a referral code and return the referrer's information
 * @param {string} code - The referral code to validate
 * @returns {Promise<{valid: boolean, referrerId?: string, error?: string}>}
 */
async function validateReferralCode(code) {
  try {
    if (!code) {
      logger.warn('No referral code provided');
      return { valid: false, error: 'No referral code provided' };
    }

    // Find user with this referral code
    const referrer = await prisma.user.findFirst({
      where: { referralCode: code },
      select: {
        id: true,
        email: true,
        referralCount: true
      }
    });

    if (!referrer) {
      logger.warn('Invalid referral code', { code });
      return { valid: false, error: 'Invalid referral code' };
    }

    // Check if referrer has reached their limit (if any limit exists)
    // This is a placeholder for future referral limit implementation
    /*
    const MAX_REFERRALS = 50;
    if (referrer.referralCount >= MAX_REFERRALS) {
      logger.warn('Referral limit reached', { 
        referrerId: referrer.id,
        currentCount: referrer.referralCount 
      });
      return { valid: false, error: 'Referrer has reached their referral limit' };
    }
    */

    logger.info('Valid referral code used', {
      code,
      referrerId: referrer.id,
      referralCount: referrer.referralCount
    });

    return {
      valid: true,
      referrerId: referrer.id
    };

  } catch (error) {
    logger.error('Error validating referral code', {
      code,
      error: error.message
    });
    return {
      valid: false,
      error: 'Error validating referral code'
    };
  }
}

module.exports = {
  generateReferralCode,
  validateReferralCode
};
