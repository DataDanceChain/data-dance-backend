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
 * @param {string} userId - Optional user ID to perform additional validations
 * @returns {Promise<{valid: boolean, referrerId?: string, error?: string, errorCode?: string}>}
 */
async function validateReferralCode(code, userId = null) {
  try {
    if (!code) {
      logger.warn('No referral code provided');
      return { 
        valid: false, 
        error: 'No referral code provided',
        errorCode: 'MISSING_CODE'
      };
    }

    // Find user with this referral code
    const referrer = await prisma.user.findFirst({
      where: { referralCode: code },
      select: {
        id: true,
        email: true
      }
    });

    if (!referrer) {
      logger.warn('Invalid referral code', { code });
      return { 
        valid: false, 
        error: 'Invalid referral code',
        errorCode: 'INVALID_CODE'
      };
    }

    // If userId is provided, perform additional validations
    if (userId) {
      // For new user registration, userId might be an email or actual user ID
      // Check if it's an email (contains @) or actual user ID
      const isEmail = typeof userId === 'string' && userId.includes('@');
      
      if (isEmail) {
        // For email-based validation (new user registration)
        // Check if a user with this email already exists and has been referred
        const existingUser = await prisma.user.findUnique({
          where: { email: userId },
          select: { id: true }
        });
        
        if (existingUser) {
          const existingReferral = await prisma.referral.findUnique({
            where: { inviteeId: existingUser.id },
            include: { inviter: { select: { id: true, name: true } } }
          });

          if (existingReferral) {
            logger.warn('User has already been referred', {
              userEmail: userId,
              existingInviterId: existingReferral.inviterId
            });
            return {
              valid: false,
              error: 'User has already been referred',
              errorCode: 'ALREADY_REFERRED',
              data: {
                inviterId: existingReferral.inviterId,
                inviterName: existingReferral.inviter?.name,
                code: existingReferral.code,
                createdAt: existingReferral.createdAt
              }
            };
          }
          
          // Prevent self-referral for existing user
          if (referrer.id === existingUser.id) {
            logger.warn('Self-referral attempt', { userEmail: userId, code });
            return {
              valid: false,
              error: 'Cannot use your own referral code',
              errorCode: 'SELF_REFERRAL_NOT_ALLOWED'
            };
          }
        }
        
        // Check if the referrer has the same email (self-referral prevention for new users)
        if (referrer.email === userId) {
          logger.warn('Self-referral attempt by email', { userEmail: userId, code });
          return {
            valid: false,
            error: 'Cannot use your own referral code',
            errorCode: 'SELF_REFERRAL_NOT_ALLOWED'
          };
        }
      } else {
        // For user ID-based validation (existing user)
        const existingReferral = await prisma.referral.findUnique({
          where: { inviteeId: userId },
          include: { inviter: { select: { id: true, name: true } } }
        });

        if (existingReferral) {
          logger.warn('User has already been referred', {
            userId,
            existingInviterId: existingReferral.inviterId
          });
          return {
            valid: false,
            error: 'User has already been referred',
            errorCode: 'ALREADY_REFERRED',
            data: {
              inviterId: existingReferral.inviterId,
              inviterName: existingReferral.inviter?.name,
              code: existingReferral.code,
              createdAt: existingReferral.createdAt
            }
          };
        }

        // Prevent self-referral
        if (referrer.id === userId) {
          logger.warn('Self-referral attempt', { userId, code });
          return {
            valid: false,
            error: 'Cannot use your own referral code',
            errorCode: 'SELF_REFERRAL_NOT_ALLOWED'
          };
        }
      }
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
      userId
    });

    return {
      valid: true,
      referrerId: referrer.id
    };

  } catch (error) {
    logger.error('Error validating referral code', {
      code,
      userId,
      error: error.message
    });
    return {
      valid: false,
      error: 'Error validating referral code',
      errorCode: 'VALIDATION_ERROR'
    };
  }
}

module.exports = {
  generateReferralCode,
  validateReferralCode
};
