/**
 * Disable / re-enable a DataDance account from ops (admin issue #2).
 *
 * Disable, in one transaction guarded by `updateMany({ id, disabledAt: null })`:
 *   1. set disabledAt, disabledBy (the actor's label) and disabledReason;
 *   2. delete the account's McpToken rows (OAuthRefreshToken rows cascade): partner and MCP access end;
 *   3. delete the account's SsoTicket rows: App SSO consent sessions end;
 *   4. write the audit row.
 * Every sign-in path already refuses a disabled account (see the contract's §4 table). Wallet JWTs
 * cannot be revoked; they are refused while the account is disabled and work again in the wallet
 * after a re-enable until they expire. Disable and enable both set `sessionsResetAt`, so no ops
 * session and no wallet JWT issued before either is accepted on the ops and console staff routes
 * again (src/services/staffSession.js). Role grants are kept through disable and enable.
 */
const prisma = require('../utils/prisma');
const { OpsError, writeAudit, isoOrNull } = require('./opsAudit');
const { lockAdmins, otherEnabledAdmins, requireReason, findTarget } = require('./userRoles');

function presentState(user) {
  return {
    id: user.id,
    disabledAt: user.disabledAt || null,
    disabledBy: user.disabledBy || null,
    disabledReason: user.disabledReason || null,
  };
}

async function disableAccount({ userId, reason, actor, surface = 'ops', requestId = null }, db = prisma) {
  const why = requireReason(reason);
  const target = await findTarget(db, userId);
  if (actor.userId && actor.userId === target.id) {
    throw new OpsError(409, 'SELF_CHANGE', 'You cannot disable your own account.');
  }
  if (target.disabledAt) throw new OpsError(409, 'ALREADY_DISABLED', 'This account is already disabled.');
  return db.$transaction(async (tx) => {
    await lockAdmins(tx);
    const adminGrant = await tx.userRoleGrant.findUnique({
      where: { userId_role: { userId: target.id, role: 'ddc_admin' } },
    });
    if (adminGrant && (await otherEnabledAdmins(tx, target.id)) === 0) {
      throw new OpsError(409, 'LAST_ADMIN', 'At least one enabled ddc_admin must remain.');
    }
    const now = new Date();
    const state = { disabledAt: now, disabledBy: String(actor.label), disabledReason: why };
    const changed = await tx.user.updateMany({
      where: { id: target.id, disabledAt: null },
      data: { ...state, sessionsResetAt: now },
    });
    if (changed.count !== 1) throw new OpsError(409, 'ALREADY_DISABLED', 'This account is already disabled.');
    const mcpTokens = await tx.mcpToken.deleteMany({ where: { userId: target.id } });
    const ssoTickets = await tx.ssoTicket.deleteMany({ where: { userId: target.id } });
    const audit = await writeAudit(tx, {
      actor,
      action: 'account.disable',
      target: { type: 'user', id: target.id, label: target.email },
      reason: why,
      detail: { mcpTokens: mcpTokens.count, ssoTickets: ssoTickets.count },
      surface,
      requestId,
    });
    return { user: presentState({ id: target.id, ...state }), auditId: audit.id };
  });
}

async function enableAccount({ userId, reason, actor, surface = 'ops', requestId = null }, db = prisma) {
  const why = requireReason(reason);
  const target = await findTarget(db, userId);
  if (!target.disabledAt) throw new OpsError(409, 'NOT_DISABLED', 'This account is not disabled.');
  return db.$transaction(async (tx) => {
    // A re-enable changes which accounts count as enabled admins; it runs under the same lock as
    // revoke and disable so their LAST_ADMIN check never reads it half way.
    await lockAdmins(tx);
    const before = await tx.user.findUnique({
      where: { id: target.id },
      select: { id: true, disabledAt: true, disabledBy: true, disabledReason: true },
    });
    const previous = presentState(before || target);
    const changed = await tx.user.updateMany({
      where: { id: target.id, disabledAt: { not: null } },
      data: { disabledAt: null, disabledBy: null, disabledReason: null, sessionsResetAt: new Date() },
    });
    if (changed.count !== 1) throw new OpsError(409, 'NOT_DISABLED', 'This account is not disabled.');
    const audit = await writeAudit(tx, {
      actor,
      action: 'account.enable',
      target: { type: 'user', id: target.id, label: target.email },
      reason: why,
      detail: {
        previous: {
          disabledAt: isoOrNull(previous.disabledAt),
          disabledBy: previous.disabledBy,
          disabledReason: previous.disabledReason,
        },
      },
      surface,
      requestId,
    });
    return { user: presentState({ id: target.id }), auditId: audit.id };
  });
}

module.exports = { disableAccount, enableAccount };
