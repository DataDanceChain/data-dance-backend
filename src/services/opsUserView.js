/**
 * The sections GET /api/ops/users/:userId adds to the existing member detail (admin issue #2):
 * account, identity, roles, data licence, privacy requests, developer clients, merchant, and —
 * for sessions with ops.support only — sign-in issues and the audit history (null otherwise).
 */
const prisma = require('../utils/prisma');
const { conflictsForUser } = require('./identityConflicts');
const { auditForUser } = require('./opsAudit');
const { ROLES } = require('../constants/opsRoles');

/** The extra User columns the sections read, beside the existing USER_SELECT. */
const VIEW_USER_SELECT = Object.freeze({
  isOrganization: true,
  disabledBy: true,
  disabledReason: true,
  web3authVerifier: true,
  web3authVerifierId: true,
  web3authLinkedAt: true,
});

async function userViewSections(user, { canSupport = false } = {}, db = prisma) {
  const userId = user.id;
  const [grants, licence, privacy, clients, legalEntity, rebind, conflicts, audit] = await Promise.all([
    db.userRoleGrant.findMany({ where: { userId }, orderBy: { grantedAt: 'asc' } }),
    db.dataLicenceConsent.findUnique({ where: { userId } }),
    db.privacyRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, kind: true, status: true, createdAt: true, resolvedAt: true, resolvedBy: true },
    }),
    db.ssoDeveloperClient.findMany({
      where: { ownerUserId: userId },
      orderBy: { createdAt: 'asc' },
      select: { clientId: true, clientName: true, kind: true, enabled: true, createdAt: true },
    }),
    db.legalEntity.findUnique({
      where: { userId },
      select: { companyName: true, kycStatus: true, kycReviewedAt: true },
    }),
    db.web3AuthNetworkRebind.findUnique({ where: { userId } }),
    canSupport ? conflictsForUser(userId, { take: 10 }, db) : null,
    canSupport ? auditForUser(userId, { take: 20 }, db) : null,
  ]);

  return {
    account: {
      authType: user.authType,
      userType: user.userType,
      isOrganization: Boolean(user.isOrganization),
      createdAt: user.createdAt,
      disabledAt: user.disabledAt || null,
      disabledBy: user.disabledBy || null,
      disabledReason: user.disabledReason || null,
    },
    identity: {
      web3auth: user.web3authVerifier
        ? {
            verifier: user.web3authVerifier,
            verifierId: user.web3authVerifierId || null,
            linkedAt: user.web3authLinkedAt || null,
          }
        : null,
      walletAddress: user.walletAddress || null,
      xUsername: user.xUsername || null,
      rebind: rebind
        ? {
            status: rebind.status,
            walletPolicy: rebind.walletPolicy,
            evidence: rebind.evidence,
            oldAddress: rebind.oldAddress || null,
            newAddress: rebind.newAddress || null,
            createdAt: rebind.createdAt,
            reboundAt: rebind.reboundAt || null,
          }
        : null,
    },
    roles: grants
      .filter((grant) => ROLES.includes(grant.role))
      .map((grant) => ({
        role: grant.role,
        grantedAt: grant.grantedAt,
        grantedBy: grant.grantedBy,
        reason: grant.reason,
      })),
    dataLicence: licence
      ? {
          policyVersion: licence.policyVersion,
          grantedAt: licence.grantedAt,
          withdrawnAt: licence.withdrawnAt || null,
          source: licence.source,
        }
      : null,
    privacyRequests: privacy.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt || null,
      resolvedBy: row.resolvedBy || null,
    })),
    developerClients: clients.map((row) => ({
      client_id: row.clientId,
      client_name: row.clientName,
      kind: row.kind === 'partner' ? 'partner' : 'developer',
      enabled: Boolean(row.enabled),
      created_at: row.createdAt || null,
    })),
    merchant: {
      isOrganization: Boolean(user.isOrganization),
      legalEntity: legalEntity
        ? {
            companyName: legalEntity.companyName,
            kycStatus: legalEntity.kycStatus,
            kycReviewedAt: legalEntity.kycReviewedAt || null,
          }
        : null,
    },
    identityConflicts: conflicts,
    audit,
  };
}

module.exports = { VIEW_USER_SELECT, userViewSections };
