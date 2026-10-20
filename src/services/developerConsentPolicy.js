/** One named developer capability; never an ops permission or a promotion to partner scopes. */
const prisma = require('../utils/prisma');
const { readPartnerConfig, initiateLoginUriProblem } = require('../constants/partnerClient');

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

async function resetOwnerConsent(tx, ownerUserId) {
  return tx.ssoDeveloperClient.updateMany({
    where: { ownerUserId, skipConfirmationEnabled: true },
    data: { skipConfirmationEnabled: false, skipConfirmationOwnerUserId: null },
  });
}

async function consentState(row, configured = null, db = prisma) {
  const cfg = readPartnerConfig();
  const ownerId = row && row.ownerUserId;
  const owner = ownerId ? await db.user.findUnique({ where: { id: ownerId }, select: { id: true, disabledAt: true } }) : null;
  const grant = owner && !owner.disabledAt ? await db.userRoleGrant.findUnique({ where: { userId_role: { userId: ownerId, role: 'trusted_developer' } } }) : null;
  const eligible = Boolean(owner && !owner.disabledAt && grant);
  // Bind the preference to the owner who confirmed it: an unexpected SQL owner change cannot
  // transfer another owner's choice, even before the supported manager service resets the row.
  const enabled = Boolean(row && row.skipConfirmationEnabled && ownerId && row.skipConfirmationOwnerUserId === ownerId);
  const platform = Boolean(cfg.enabled && cfg.autoApprove.app);
  const clientEnabled = configured ? configured.enabled : row && row.enabled;
  const rawUri = configured ? configured.initiateLoginUri : row && row.initiateLoginUri;
  const uri = typeof rawUri === 'string' ? rawUri.trim() : null;
  const validUri = typeof uri === 'string' && uri && !initiateLoginUriProblem(uri) ? uri : null;
  let reason = 'enabled';
  if (owner && owner.disabledAt) reason = 'owner_disabled';
  else if (!eligible) reason = 'qualification_required';
  else if (!clientEnabled) reason = 'client_disabled';
  else if (!platform) reason = 'platform_disabled';
  else if (!enabled) reason = 'not_enabled';
  else if (!validUri) reason = 'handoff_not_configured';
  return { eligible, enabled, effective: reason === 'enabled', reason, platform_enabled: platform, initiate_login_uri: validUri };
}

module.exports = { SKIP_CONFIRMATION, capabilitiesFor, lockConsentPolicy, resetOwnerConsent, consentState };
