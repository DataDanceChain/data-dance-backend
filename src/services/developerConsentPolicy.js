/** One named developer capability; never an ops permission or a promotion to partner scopes. */

const SKIP_CONFIRMATION = 'sso.skip_confirmation';

function capabilitiesFor(roles) {
  return Array.isArray(roles) && roles.includes('trusted_developer') ? [SKIP_CONFIRMATION] : [];
}

/** Short database-only critical section shared by entitlement changes and final auto decisions.
 * Always take this BEFORE row writes / admin locks. Raw SQL edits are not the supported control
 * plane. A bounded wait fails closed rather than holding an authorization request indefinitely.
 */
async function lockConsentPolicy(tx) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ddc:sso-consent-policy'))`;
}

module.exports = { SKIP_CONFIRMATION, capabilitiesFor, lockConsentPolicy };
