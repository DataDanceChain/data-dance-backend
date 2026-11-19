/** Transactional developer-host audit primitives, reused without mounting legacy Ops changes. */
const crypto = require('node:crypto');
const { AUDIT_ACTIONS, ACTOR_KINDS, SURFACES } = require('../constants/opsRoles');
const ID_LIMIT = 256;

class OpsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OpsError';
    this.status = status;
    this.code = code;
  }
}

function recordLabelKey() {
  const secret = String(process.env.JWT_SECRET || '');
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('ops-record-label').digest();
}

function staffRecordLabel(userId) {
  const id = String(userId || '');
  const key = id ? recordLabelKey() : null;
  if (!key) return 'ops';
  return `ops:${crypto.createHmac('sha256', key).update(id).digest('hex').slice(0, 10)}`;
}

function actorFromUser(user, role) {
  return { kind: 'user', userId: user.id, label: user.email || user.id, recordLabel: staffRecordLabel(user.id), role };
}

function text(value, limit = ID_LIMIT) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, limit);
}

async function writeAudit(db, { actor, action, target, reason = null, detail, surface, requestId = null }) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`Unknown audit action: ${action}`);
  if (!actor || !ACTOR_KINDS.includes(actor.kind)) throw new Error('Unknown audit actor kind');
  if (!SURFACES.includes(surface)) throw new Error(`Unknown audit surface: ${surface}`);
  if (!target || !target.type) throw new Error('An audit row needs a target type');
  const data = {
    actorKind: actor.kind,
    actorUserId: actor.userId || null,
    actorLabel: String(actor.label || actor.kind),
    actorRole: String(actor.role || actor.kind),
    action,
    targetType: String(target.type),
    targetId: text(target.id),
    targetLabel: text(target.label),
    reason: text(reason, 500),
    surface,
    requestId: text(requestId, 128),
  };
  // A nullable Json column is left out rather than written as null (Prisma needs DbNull for that).
  if (detail !== undefined && detail !== null) data.detail = detail;
  return db.opsAuditLog.create({ data });
}

module.exports = { OpsError, actorFromUser, writeAudit };
