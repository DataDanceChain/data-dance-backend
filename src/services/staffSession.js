/**
 * Which sessions may act as staff (admin issue #2).
 *
 *   - Verified: a wallet JWT minted from a verified Web3Auth ID token carries `ver: 2`. Only those
 *     reach the staff routes: POST /api/ops/auth/code and the developer console's staff endpoints.
 *   - Recent: minting an ops sign-in code also needs a wallet sign-in from the last 10 minutes
 *     (the token's `iat`), so a long-lived wallet session cannot open an ops session on its own.
 *   - Not older than the last disable / enable: `User.sessionsResetAt` is set by both. An ops
 *     session or a wallet JWT issued before it is refused on these routes, so re-enabling an
 *     account does not bring its old sessions back. New tokens also carry a signed `iatMs`, so
 *     staff can sign in again within the reset's second. Legacy whole-second tokens fail closed
 *     for that second, because their actual order relative to the reset cannot be established.
 */
const { OpsError } = require('./opsAudit');

const RECENT_SIGN_IN_SEC = 10 * 60;

function issuedAtSec(claims) {
  const iat = Number(claims && claims.iat);
  return Number.isFinite(iat) ? iat : null;
}

/** Whether a token with `claims` was issued before `resetAt` (a Date, or null for never). */
function issuedBeforeReset(claims, resetAt) {
  const iat = issuedAtSec(claims);
  const precise = claims && claims.iatMs;
  // Only a correctly formed, signed issue time may distinguish tokens in the same second.
  // Reject a malformed or future new-format claim even on accounts that have never reset.
  if (precise !== undefined && (
    !Number.isSafeInteger(precise) || Math.floor(precise / 1000) !== iat || precise > Date.now()
  )) return true;
  if (!resetAt) return false;
  const at = new Date(resetAt).getTime();
  if (Number.isNaN(at)) return false;
  if (iat === null) return true;
  if (precise !== undefined) {
    return precise <= at;
  }
  return iat * 1000 <= at;
}

/** Whether the token was issued in the last RECENT_SIGN_IN_SEC seconds. */
function recentSignIn(claims, now = Date.now()) {
  const iat = issuedAtSec(claims);
  if (iat === null) return false;
  const age = now / 1000 - iat;
  return age >= 0 && age <= RECENT_SIGN_IN_SEC;
}

function verifiedSession(claims) {
  return Number(claims && claims.ver) >= 2;
}

/**
 * The checks a wallet JWT passes before it acts as staff. Throws an OpsError:
 *   403 VERIFIED_SESSION_REQUIRED  not a verified session (ver < 2)
 *   401 SESSION_REVOKED            issued before the account's last disable / enable
 *   403 RECENT_SIGN_IN_REQUIRED    `recent` and older than 10 minutes
 * `user` is the account row (`sessionsResetAt`); `claims` the decoded wallet JWT.
 */
function assertStaffWalletSession(user, claims, { recent = false, now = Date.now() } = {}) {
  if (!verifiedSession(claims)) {
    throw new OpsError(403, 'VERIFIED_SESSION_REQUIRED', 'Please sign in again to continue.');
  }
  if (issuedBeforeReset(claims, user && user.sessionsResetAt)) {
    throw new OpsError(401, 'SESSION_REVOKED', 'This sign-in has ended. Please sign in again.');
  }
  if (recent && !recentSignIn(claims, now)) {
    throw new OpsError(403, 'RECENT_SIGN_IN_REQUIRED', 'Please sign in again to continue.');
  }
}

module.exports = {
  RECENT_SIGN_IN_SEC,
  issuedBeforeReset,
  recentSignIn,
  verifiedSession,
  assertStaffWalletSession,
};
