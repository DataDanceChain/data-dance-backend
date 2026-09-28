const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');
const { runVettedRawRead } = require('./prismaReadOnly');
const { createLogger } = require('./logger');

const logger = createLogger('referralUtils');

const {
  ALPHABET,
  CODE_LENGTH,
  DISPLAY_CODE_PREFIX,
  isDisplayCode,
  bareDisplayReferralCode,
  normalizeReferralCodeInput,
  formatReferralCodeForDisplay,
  withDisplayReferralCode,
} = require('./referralCodeFormat');

const ALLOCATE_ATTEMPTS = 16;

function generateReferralCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return code;
}

function isDisplayReferralCode(code) {
  return isDisplayCode(code);
}

// The legacy long-form code (see referralCodeLookupValues below): "DD" + 8 alphanumeric
// characters, an optional hyphen after "DD", case-insensitive.
const LEGACY_CODE_PATTERN = /^DD[A-Z0-9]{8}$/i;

/**
 * Format-only check: does `raw` look like a referral code this app could ever issue, WITHOUT
 * looking anything up? Accepts exactly what `referralCodeLookupValues` below would search for —
 * the 6-character display code or the legacy "DD########" code, case-insensitive, tolerant of
 * surrounding/internal whitespace and (for the legacy form) a hyphen after "DD" — and nothing
 * else. Used where a caller must reject a malformed code before any database access (e.g.
 * /oauth/authorize's optional referral_code, which must not become a code-enumeration oracle).
 */
function isValidReferralCodeFormat(raw) {
  if (typeof raw !== 'string') return false;
  const compact = raw.trim().replace(/\s+/g, '');
  if (!compact || compact.length > 32) return false;
  if (isDisplayReferralCode(compact.toUpperCase())) return true;
  return LEGACY_CODE_PATTERN.test(compact.replace(/-/g, ''));
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

  if (LEGACY_CODE_PATTERN.test(noHyphen)) {
    const body = noHyphen.slice(2);
    values.add(`DD-${body}`);
    values.add(`DD-${body.toLowerCase()}`);
    values.add(`DD-${body.toUpperCase()}`);
  }

  // A display code typed with the "DDC-" prefix (or without it, in any case, with spaces or
  // hyphens) also resolves to the bare stored code.
  const bare = bareDisplayReferralCode(compact);
  if (bare) {
    values.add(bare);
    values.add(bare.toLowerCase());
  }

  return [...values];
}

async function findUserByReferralCode(code, select = { id: true, email: true }) {
  const values = [...new Set(referralCodeLookupValues(code).map((value) => value.toLowerCase()))];
  if (values.length === 0) return null;
  // A fixed, parameterised SELECT: vetted for the partner API's read-only scope, where
  // POST /partner/tge/referral/bind/check resolves the typed code through here. `async` + `await`
  // on purpose: a PrismaPromise is lazy and runs when it is awaited, so it must be awaited INSIDE
  // the vetted scope, not by the caller after runVettedRawRead has returned.
  const rows = await runVettedRawRead('referralUtils.findUserByReferralCode', async () => await prisma.$queryRaw`
    SELECT id, email, name, "referralCode"
    FROM "User"
    WHERE LOWER("referralCode") IN (${Prisma.join(values)})
       OR LOWER(COALESCE("legacyReferralCode", '')) IN (${Prisma.join(values)})
    LIMIT 1
  `);
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
 * Who invited this user, as a DataDance user id — or null when nobody did.
 * Same row the Wallet referral page reads (`Referral.inviteeId` is unique, so there is at most
 * one inviter per account).
 */
async function getInviterId(userId) {
  const row = await prisma.referral.findUnique({
    where: { inviteeId: userId },
    select: { inviterId: true },
  });
  return row?.inviterId || null;
}

/**
 * How many people this user invited DIRECTLY (level 1).
 *
 * Counts EVERY direct invite, campaign invites (Mother's Day, Summer Travel) included: the
 * partner's question is "how many people did this user invite", and someone who joined through a
 * campaign link was still invited by them. This can therefore exceed the number the Wallet
 * referral page shows, which lists standard referrals only — say so wherever it is displayed.
 * A COUNT never materialises the invitees, which is what keeps the downline out of reach by
 * construction, not only by convention.
 */
async function countDirectInvitees(userId) {
  // Every person this user directly brought in, campaign invites included: the partner asks
  // "how many people did this user invite", and someone who joined through a campaign link was
  // still invited by them. Note this can exceed the number the Wallet referral page shows, which
  // counts standard referrals only.
  return prisma.referral.count({ where: { inviterId: userId } });
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
                code: formatReferralCodeForDisplay(existingReferral.code),
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
              code: formatReferralCodeForDisplay(existingReferral.code),
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
  isValidReferralCodeFormat,
  ensureDisplayReferralCode,
  referralCodeLookupValues,
  findUserByReferralCode,
  validateReferralCode,
  getInviterId,
  countDirectInvitees,
  DISPLAY_CODE_PREFIX,
  bareDisplayReferralCode,
  normalizeReferralCodeInput,
  formatReferralCodeForDisplay,
  withDisplayReferralCode,
};
