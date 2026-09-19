const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');
const { createLogger } = require('./logger');

const logger = createLogger('referralUtils');

// 32 characters. Skip 0/O and 1/I/L so codes stay easy to read aloud.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const ALLOCATE_ATTEMPTS = 16;

function generateReferralCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return code;
}

function isDisplayReferralCode(code) {
  return typeof code === 'string'
    && code.length === CODE_LENGTH
    && [...code].every((character) => ALPHABET.includes(character));
}

function referralCodeLookupValues(raw) {
  const compact = String(raw || '').trim().replace(/\s+/g, '');
  if (!compact) return [];

  const noHyphen = compact.replace(/-/g, '');
  const values = new Set([
    compact,
    compact.toUpperCase(),
    compact.toLowerCase(),
    noHyphen,
    noHyphen.toUpperCase(),
    noHyphen.toLowerCase(),
  ]);

  if (/^DD[A-Z0-9]{8}$/i.test(noHyphen)) {
    const body = noHyphen.slice(2);
    values.add(`DD-${body}`);
    values.add(`DD-${body.toLowerCase()}`);
    values.add(`DD-${body.toUpperCase()}`);
  }

  return [...values];
}

async function findUserByReferralCode(code, select = { id: true, email: true }) {
  const values = [...new Set(referralCodeLookupValues(code).map((value) => value.toLowerCase()))];
  if (values.length === 0) return null;
  const rows = await prisma.$queryRaw`
    SELECT id, email, name, "referralCode"
    FROM "User"
    WHERE LOWER("referralCode") IN (${Prisma.join(values)})
       OR LOWER(COALESCE("legacyReferralCode", '')) IN (${Prisma.join(values)})
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const picked = {};
  if (select.id) picked.id = row.id;
  if (select.email) picked.email = row.email;
  if (select.name) picked.name = row.name;
  if (select.referralCode) picked.referralCode = row.referralCode;
  return picked;
}

async function generateUniqueReferralCode() {
  for (let attempt = 0; attempt < ALLOCATE_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();
    const existing = await findUserByReferralCode(code, { id: true });
    if (!existing) return code;
  }
  throw new Error('Could not allocate a unique referral code');
}

async function ensureDisplayReferralCode(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, referralCode: true },
  });
  if (!user) return '';
  if (isDisplayReferralCode(user.referralCode)) return user.referralCode;

  const short = await generateUniqueReferralCode();
  await prisma.$executeRaw`
    UPDATE "User"
    SET "referralCode" = ${short},
        "legacyReferralCode" = COALESCE("legacyReferralCode", ${user.referralCode})
    WHERE id = ${userId}
      AND "referralCode" = ${user.referralCode}
  `;
  const latest = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });
  logger.info('Assigned display referral code', { userId, display: latest?.referralCode });
  return latest?.referralCode || short;
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
        errorCode: 'MISSING_CODE',
      };
    }

    const referrer = await findUserByReferralCode(code, { id: true, email: true });

    if (!referrer) {
      logger.warn('Invalid referral code', { code });
      return {
        valid: false,
        error: 'Invalid referral code',
        errorCode: 'INVALID_CODE',
      };
    }

    if (userId) {
      const isEmail = typeof userId === 'string' && userId.includes('@');

      if (isEmail) {
        const existingUser = await prisma.user.findUnique({
          where: { email: userId },
          select: { id: true },
        });

        if (existingUser) {
          const existingReferral = await prisma.referral.findUnique({
            where: { inviteeId: existingUser.id },
            include: { inviter: { select: { id: true, name: true } } },
          });

          if (existingReferral) {
            logger.warn('User has already been referred', {
              userEmail: userId,
              existingInviterId: existingReferral.inviterId,
            });
            return {
              valid: false,
              error: 'User has already been referred',
              errorCode: 'ALREADY_REFERRED',
              data: {
                inviterId: existingReferral.inviterId,
                inviterName: existingReferral.inviter?.name,
                code: existingReferral.code,
                createdAt: existingReferral.createdAt,
              },
            };
          }

          if (referrer.id === existingUser.id) {
            logger.warn('Self-referral attempt', { userEmail: userId, code });
            return {
              valid: false,
              error: 'Cannot use your own referral code',
              errorCode: 'SELF_REFERRAL_NOT_ALLOWED',
            };
          }
        }

        if (referrer.email === userId) {
          logger.warn('Self-referral attempt by email', { userEmail: userId, code });
          return {
            valid: false,
            error: 'Cannot use your own referral code',
            errorCode: 'SELF_REFERRAL_NOT_ALLOWED',
          };
        }
      } else {
        const existingReferral = await prisma.referral.findUnique({
          where: { inviteeId: userId },
          include: { inviter: { select: { id: true, name: true } } },
        });

        if (existingReferral) {
          logger.warn('User has already been referred', {
            userId,
            existingInviterId: existingReferral.inviterId,
          });
          return {
            valid: false,
            error: 'User has already been referred',
            errorCode: 'ALREADY_REFERRED',
            data: {
              inviterId: existingReferral.inviterId,
              inviterName: existingReferral.inviter?.name,
              code: existingReferral.code,
              createdAt: existingReferral.createdAt,
            },
          };
        }

        if (referrer.id === userId) {
          logger.warn('Self-referral attempt', { userId, code });
          return {
            valid: false,
            error: 'Cannot use your own referral code',
            errorCode: 'SELF_REFERRAL_NOT_ALLOWED',
          };
        }
      }
    }

    logger.info('Valid referral code used', {
      code,
      referrerId: referrer.id,
      userId,
    });

    return {
      valid: true,
      referrerId: referrer.id,
    };
  } catch (error) {
    logger.error('Error validating referral code', {
      code,
      userId,
      error: error.message,
    });
    return {
      valid: false,
      error: 'Error validating referral code',
      errorCode: 'VALIDATION_ERROR',
    };
  }
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  generateReferralCode,
  generateUniqueReferralCode,
  isDisplayReferralCode,
  ensureDisplayReferralCode,
  referralCodeLookupValues,
  findUserByReferralCode,
  validateReferralCode,
};
