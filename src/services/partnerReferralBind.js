/**
 * The partner (TGE) binds an invite code as the signed-in user's inviter — decision 30 A (Sloan,
 * 2026-09-28): TGE shows a popup, and a user without an inviter cannot subscribe there.
 *
 * This is deliberately NOT a second bind implementation. It calls useReferralCode(), the exact
 * service behind POST /api/referrals/use-code, so a partner bind gets everything a Wallet bind gets:
 * the late-bind transaction with the cycle check under the global advisory lock (decision 11 B),
 * self-referral refusal, and whatever reward timing that path applies (after PR #6: rewards only
 * for activity after the bind). What this module adds is the partner-facing outcome vocabulary.
 *
 * Decision 29 A: an inviter, once bound, is never changed. A second bind is refused — except that
 * re-sending the code of the inviter the user already has is answered as success (`already: true`),
 * so a partner retrying after a timeout does not show its user an error. Refusing a DIFFERENT
 * inviter never names the current one: the partner learns who the inviter is only through the
 * `tge:referral` read scope.
 */
const prisma = require('../utils/prisma');
const { useReferralCode } = require('./referralService');
const { findUserByReferralCode } = require('../utils/referralUtils');

/** Codes are six characters today and legacy ones longer; anything past this is not a code. */
const MAX_CODE_LENGTH = 64;

/** The `code` from a request body, trimmed, or null when it is not a usable string. */
function parseBindCode(body) {
  const raw = body && typeof body === 'object' ? body.code : undefined;
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  if (!code || code.length > MAX_CODE_LENGTH) return null;
  return code;
}

/** Enough to correlate a log line with a support ticket; never the whole code. */
function codePrefix(code) {
  const value = String(code || '');
  return value ? `${value.slice(0, 2)}…` : null;
}

function refused(status, error, description, outcome) {
  return { status, body: { error, error_description: description }, outcome, inviterSub: null };
}

/**
 * @returns {Promise<{ status: number, body: object, outcome: string, inviterSub: string|null }>}
 *   outcome ∈ bound | already | already_referred | invalid_code | self_referral | referral_cycle.
 *   Anything else is thrown (the route answers 500).
 */
async function bindReferralForPartner(userId, code) {
  try {
    const result = await useReferralCode(userId, code, null);
    return { status: 200, body: { bound: true, inviter_sub: result.inviterId }, outcome: 'bound', inviterSub: result.inviterId };
  } catch (error) {
    switch (error && error.code) {
      case 'ALREADY_REFERRED': {
        // Also reached when a concurrent bind for the same user won the race (unique inviteeId →
        // P2002), so re-read what is stored now rather than trusting the error's payload.
        const [existing, owner] = await Promise.all([
          prisma.referral.findUnique({ where: { inviteeId: userId }, select: { inviterId: true } }),
          findUserByReferralCode(code, { id: true }),
        ]);
        if (existing && owner && existing.inviterId === owner.id) {
          return {
            status: 200,
            body: { bound: true, inviter_sub: owner.id, already: true },
            outcome: 'already',
            inviterSub: owner.id,
          };
        }
        return refused(409, 'already_referred', 'This user already has an inviter, and an inviter is never changed.', 'already_referred');
      }
      case 'INVALID_CODE':
        return refused(404, 'invalid_code', 'No DataDance user has this invite code.', 'invalid_code');
      case 'SELF_REFERRAL_NOT_ALLOWED':
        return refused(400, 'self_referral', 'A user cannot use their own invite code.', 'self_referral');
      case 'REFERRAL_CYCLE':
        return refused(409, 'referral_cycle', 'This invite code belongs to someone the user invited, directly or further down.', 'referral_cycle');
      default:
        throw error;
    }
  }
}

module.exports = { bindReferralForPartner, parseBindCode, codePrefix, MAX_CODE_LENGTH };
