const { init: initCuid } = require('@paralleldrive/cuid2');
const prisma = require('./prisma');
const { createLogger } = require('./logger');

const logger = createLogger('inviteUtils');

// Initialize cuid generator with custom configuration
const createId = initCuid({
  length: 8  // Shorter length for invite codes
});

/**
 * Generate a unique invite code for a new user
 * @returns {string} A unique invite code
 */
function generateInviteCode() {
  return `DD-${createId()}`;
}

/**
 * Validate an invite code and return the referrer's information
 * @param {string} code - The invite code to validate
 * @returns {Promise<{valid: boolean, referrerId?: string, error?: string}>}
 */
async function validateInviteCode(code) {
  try {
    if (!code) {
      logger.warn('No invite code provided');
      return { valid: false, error: 'No invite code provided' };
    }

    // Find user with this invite code
    const referrer = await prisma.user.findFirst({
      where: { inviteCode: code },
      select: {
        id: true,
        email: true,
        referralCount: true
      }
    });

    if (!referrer) {
      logger.warn('Invalid invite code', { code });
      return { valid: false, error: 'Invalid invite code' };
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

    logger.info('Valid invite code used', {
      code,
      referrerId: referrer.id,
      referralCount: referrer.referralCount
    });

    return {
      valid: true,
      referrerId: referrer.id
    };

  } catch (error) {
    logger.error('Error validating invite code', {
      code,
      error: error.message
    });
    return {
      valid: false,
      error: 'Error validating invite code'
    };
  }
}

module.exports = {
  generateInviteCode,
  validateInviteCode
};
