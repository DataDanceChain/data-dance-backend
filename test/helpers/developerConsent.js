/** Explicit opt-in fixture for legacy auto-positive tests under the new default-off policy. */
async function enableTrustedConsent(db, clientId) {
  const owner = `consent-owner-${clientId}`;
  await db.user.upsert({ where: { id: owner }, update: {},
    create: { id: owner, email: `${owner}@example.test`, referralCode: owner, disabledAt: null } });
  await db.userRoleGrant.upsert({ where: { userId_role: { userId: owner, role: 'trusted_developer' } }, update: {},
    create: { userId: owner, role: 'trusted_developer', reason: 'Synthetic consent fixture', grantedBy: 'script' } });
  const choice = { ownerUserId: owner, skipConfirmationEnabled: true, skipConfirmationOwnerUserId: owner };
  await db.ssoDeveloperClient.upsert({ where: { clientId }, update: choice,
    create: { clientId, clientName: 'Synthetic consent fixture', contactEmail: `${owner}@example.test`, secretHash: 'a'.repeat(64), redirectUris: [], enabled: true, kind: 'partner', ...choice } });
}
module.exports = { enableTrustedConsent };
