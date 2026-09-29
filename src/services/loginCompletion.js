/**
 * What every login path does once it knows WHO signed in: referral / campaign handling, the
 * sanitised user in the response and the response shape itself. Shared by POST
 * /api/auth/web3auth-login (web3AuthController) and POST /api/auth/native/complete
 * (nativeAuth/complete), so a new account or an existing one gets exactly the same referral and
 * reward behaviour whichever way it signed in (design §3.7 step 5).
 *
 * Moved verbatim out of web3AuthController.js (pure extraction). The logger keeps the controller's
 * component name so the legacy path's log lines stay byte-identical.
 */
const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const referralService = require('./referralService');
const { validateReferralCode } = require('../utils/referralUtils');
const { withDisplayReferralCode } = require('../utils/referralCodeFormat');
const {
  MOTHERS_DAY_2026_SLUG,
  SUMMER_TRAVEL_2026_SLUG,
  normalizeReferralCampaignInput,
} = require('../constants/referralCampaigns');
const { assertReferralCampaignUsable } = require('../utils/stayBonus');

const logger = createLogger('web3AuthController');

/** Thrown by helpers to short-circuit the request with an HTTP reply (legacy status codes and bodies). */
class HttpReply extends Error {
  constructor(status, body) {
    super(body && body.message ? body.message : 'http reply');
    this.name = 'HttpReply';
    this.status = status;
    this.body = body;
  }
}
const reply = (status, body) => new HttpReply(status, body);

function sanitizeUser(user) {
  const { password, privateKey, ...safeUser } = user;
  return withDisplayReferralCode(safeUser);
}

/**
 * Returns `{ campaignSlug, inviteError }`. An unusable campaign is not thrown here: it only
 * refuses a NEW registration (as before); for an existing account it is reported in
 * `invitationStatus` and the login goes ahead.
 */
async function resolveCampaign(req, referralCode) {
  let campaignSlug = null;
  try {
    campaignSlug = normalizeReferralCampaignInput(req.body.referralCampaign ?? req.body.campaign);
    await assertReferralCampaignUsable(campaignSlug);
  } catch (e) {
    if (e.code === 'INVALID_CAMPAIGN' || e.code === 'CAMPAIGN_INACTIVE') {
      return {
        campaignSlug: null,
        inviteError: reply(400, { status: 'fail', code: e.code, message: e.message }),
      };
    }
    throw e;
  }
  if (campaignSlug && !referralCode) {
    return {
      campaignSlug,
      inviteError: reply(400, {
        status: 'fail',
        code: 'CAMPAIGN_REQUIRES_REFERRAL_CODE',
        message:
          'This campaign requires signing up through an invite link that includes a referral code.',
      }),
    };
  }
  return { campaignSlug, inviteError: null };
}

function referralFailure(referralData) {
  const statusCode = referralData.errorCode === 'INVALID_CODE' ? 404 : 400;
  return reply(statusCode, {
    status: 'fail',
    code: referralData.errorCode || 'INVALID_REFERRAL_CODE',
    message: referralData.error || 'Invalid or expired referral code',
    ...(referralData.data && { data: referralData.data }),
  });
}

async function assertInviterEligible(referrerId, campaignSlug) {
  if (campaignSlug !== SUMMER_TRAVEL_2026_SLUG) return;
  try {
    await referralService.assertSummerTravelInviterEligible(referrerId);
  } catch (e) {
    if (e.code === 'CAMPAIGN_INVITER_LOCKED') {
      throw reply(403, { status: 'fail', code: e.code, message: e.message });
    }
    throw e;
  }
}

// Referral row + rewards cannot run in one interactive tx: processCampaignReferral
// opens its own transaction and UPDATEs the invitee row, which deadlocks with the
// uncommitted outer transaction that created the same user + referral.
async function settleReferral(userId, referrerId, campaignSlug, referralCode) {
  if (campaignSlug === MOTHERS_DAY_2026_SLUG) {
    await referralService.processCampaignReferral(userId, referrerId, campaignSlug);
  } else if (campaignSlug === SUMMER_TRAVEL_2026_SLUG) {
    // Relation only — settle after invitee's first valid summer stay upload.
  } else {
    await referralService.processReferral(userId, referrerId, referralCode);
  }
}

/** Neutral wording per reason; never names the account's existing inviter or a code's owner. */
const NOT_APPLIED_MESSAGES = {
  ALREADY_REFERRED: 'This account already has an inviter, so the referral code was not applied.',
  INVALID_CODE: 'The referral code was not recognised, so it was not applied.',
  SELF_REFERRAL_NOT_ALLOWED: 'You cannot use your own referral code, so it was not applied.',
  REFERRAL_CYCLE: 'This referral code belongs to someone in your own invite network, so it was not applied.',
};
const NOT_APPLIED_DEFAULT = 'The referral code was not applied.';

function referralNotApplied(code) {
  return { success: false, code, message: NOT_APPLIED_MESSAGES[code] || NOT_APPLIED_DEFAULT };
}

/**
 * Existing-user referral handling; returns invitationStatus or null. It never fails the login:
 * a code (or campaign) that cannot be applied is reported as `{ success: false, code, message }`
 * and the session is issued as usual. Otherwise a user who already has an inviter and opens
 * anyone's invite link could not sign in again while the link's code stayed pending.
 */
async function applyReferralToExistingUser(user, referralCode, campaignSlug, inviteError) {
  if (!referralCode && !inviteError) return null;

  const notApplied = (code, meta = {}) => {
    logger.info('referral_not_applied_at_login', { userId: user.id, code, campaignSlug, ...meta });
    return referralNotApplied(code);
  };

  if (inviteError) return notApplied(inviteError.body.code);

  const applied = {
    success: true,
    code: 'REFERRAL_SUCCESSFUL',
    message: 'Successfully used referral code',
  };
  let bound = false;
  try {
    const existingReferral = await prisma.referral.findUnique({ where: { inviteeId: user.id } });
    if (existingReferral) return notApplied('ALREADY_REFERRED');

    const referralData = await validateReferralCode(referralCode, user.id);
    if (!referralData.valid) return notApplied(referralData.errorCode || 'INVALID_REFERRAL_CODE');
    const referrerId = referralData.referrerId;
    await assertInviterEligible(referrerId, campaignSlug);

    // Refuses a bind that would close a referral ring (REFERRAL_CYCLE, decision 11 B).
    await referralService.createLateBindReferral({
      inviterId: referrerId,
      inviteeId: user.id,
      code: referralCode,
      campaignSlug,
    });
    bound = true;
    await settleReferral(user.id, referrerId, campaignSlug, referralCode);

    return applied;
  } catch (error) {
    if (bound) {
      // The relation is recorded; only the reward step failed. Say so loudly for a re-settle,
      // and do not tell the user a code that is now bound was "not applied".
      logger.error('referral_settle_failed_at_login', { userId: user.id, error: error.message });
      return applied;
    }
    // Decision 11 B refuses the bind, not the login (createLateBindReferral already logged it).
    if (error.code === 'REFERRAL_CYCLE') return notApplied('REFERRAL_CYCLE');
    if (error instanceof HttpReply) return notApplied(error.body.code);
    if (error.code === 'P2002') return notApplied('ALREADY_REFERRED', { race: true });
    logger.error('Referral code validation error for existing user', {
      userId: user.id,
      error: error.message,
    });
    return referralNotApplied('REFERRAL_VALIDATION_ERROR');
  }
}

/** New-user referral validation; returns referrerId or null. Behaviour unchanged. */
async function validateReferralForNewUser(referralCode, campaignSlug, tempUserId) {
  if (!referralCode) return null;
  try {
    const referralData = await validateReferralCode(referralCode, tempUserId);
    if (!referralData.valid) throw referralFailure(referralData);
    const referrerId = referralData.referrerId;
    await assertInviterEligible(referrerId, campaignSlug);
    return referrerId;
  } catch (error) {
    if (error instanceof HttpReply) throw error;
    logger.error('Referral code validation error', { error: error.message });
    throw reply(500, {
      status: 'error',
      code: 'REFERRAL_VALIDATION_ERROR',
      message: 'Failed to validate referral code',
    });
  }
}

/**
 * The login response body: today's web3auth-login shape. `extra` is merged into `data` after the
 * standard fields; POST /api/auth/native/complete passes `{ isNewUser }`, the only addition (D19).
 */
function loginResponseData(token, user, invitationStatus, extra = {}) {
  return {
    token,
    user: sanitizeUser(user),
    ...(invitationStatus && { invitationStatus }),
    ...extra,
  };
}

function sendLogin(res, httpStatus, token, user, invitationStatus) {
  return res.status(httpStatus).json({
    status: 'success',
    data: loginResponseData(token, user, invitationStatus),
  });
}

/** invitationStatus for a new account registered with a referral code (both login paths). */
const REGISTERED_WITH_REFERRAL = Object.freeze({
  success: true,
  code: 'REFERRAL_SUCCESSFUL',
  message: 'Successfully registered with referral code',
});

module.exports = {
  HttpReply,
  reply,
  sanitizeUser,
  resolveCampaign,
  referralFailure,
  assertInviterEligible,
  settleReferral,
  NOT_APPLIED_MESSAGES,
  referralNotApplied,
  applyReferralToExistingUser,
  validateReferralForNewUser,
  loginResponseData,
  sendLogin,
  REGISTERED_WITH_REFERRAL,
};
