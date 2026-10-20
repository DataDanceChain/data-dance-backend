/**
 * The ops audit log (OpsAuditLog): who, when, what, why, for every change made through the ops
 * site, the developer console's staff endpoints and scripts/opsRoles.js.
 *
 * - A management action (role grant/revoke, disable/enable, points adjust, Data Planet manager,
 *   sign-in) writes its row with `writeAudit(tx, ...)` inside the transaction of the change, so a
 *   failed audit write leaves nothing changed, and sets `req.auditWritten`.
 * - A route that moves money or balances (payments, merchant credit, order attestation, payouts,
 *   data-request fulfilment, raffle draw) is mounted with `auditInChange(action)`: its handler
 *   writes the row with `req.auditChange(tx, ...)` inside the transaction of the change, one row
 *   per change, and a call that changes nothing writes none.
 * - Other ops writes declare a generic audit boundary. Their database mutation and `ops.write`
 *   row commit together; external results await their row before a successful response.
 * - `auditOpsWrites` remains a compatibility fallback for callers outside the annotated router.
 * - `detail` never holds a token, a secret, a code or a request body.
 * - Rows are append-only: nothing here updates or deletes one.
 */
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { createLogger } = require('../utils/logger');
const { AUDIT_ACTIONS, ACTOR_KINDS, SURFACES } = require('../constants/opsRoles');

const logger = createLogger('opsAudit');

/** An ops refusal with its HTTP status and contract code. */
class OpsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OpsError';
    this.status = status;
    this.code = code;
  }
}

/** The sub-key of record labels: HMAC-SHA256(JWT_SECRET, 'ops-record-label'), or null without a secret. */
function recordLabelKey() {
  const secret = String(process.env.JWT_SECRET || '');
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('ops-record-label').digest();
}

/**
 * Who acted, as written into records that people outside staff can read (a point's source id, a
 * privacy request's resolvedBy, a ledger row's metadata, a campaign's createdBy, a role grant's
 * grantedBy, ...): `ops:` and the first 10 hex characters of HMAC-SHA256 over the staff account's
 * id, keyed with a sub-key of JWT_SECRET (recordLabelKey). Never the e-mail and never the id: the
 * same account always gets the same label, and only the server can tell whose it is. The person
 * behind it is kept only in OpsAuditLog (actorUserId, actorLabel). Without JWT_SECRET (no ops
 * session can exist then) the label is plain `ops`.
 */
function staffRecordLabel(userId) {
  const id = String(userId || '');
  const key = id ? recordLabelKey() : null;
  if (!key) return 'ops';
  return `ops:${crypto.createHmac('sha256', key).update(id).digest('hex').slice(0, 10)}`;
}

/** The actor of scripts/opsRoles.js. */
const SCRIPT_ACTOR = Object.freeze({ kind: 'system', userId: null, label: 'script', recordLabel: 'script', role: 'system' });

/**
 * The audit actor of an ops session (req.opsAdmin). A demo session never writes. `label` is the
 * audit row's actorLabel (a personal session's e-mail); `recordLabel` is what any other record
 * gets (see staffRecordLabel).
 */
function actorFromOps(opsAdmin) {
  if (opsAdmin && opsAdmin.kind === 'user') {
    return {
      kind: 'user',
      userId: opsAdmin.userId,
      label: opsAdmin.email || opsAdmin.username,
      recordLabel: staffRecordLabel(opsAdmin.userId),
      role: opsAdmin.role,
    };
  }
  if (opsAdmin && opsAdmin.kind === 'shared') {
    return { kind: 'shared', userId: null, label: 'shared', recordLabel: 'shared', role: 'shared' };
  }
  throw new OpsError(403, 'FORBIDDEN_ROLE', 'This session cannot change anything.');
}

/** The audit actor for a signed-in DataDance account acting with `role`. */
function actorFromUser(user, role) {
  return { kind: 'user', userId: user.id, label: user.email || user.id, recordLabel: staffRecordLabel(user.id), role };
}

/** The "by" value an actor writes into a record outside OpsAuditLog: never an e-mail. */
function recordLabelOf(actor) {
  if (!actor) return 'ops';
  if (actor.kind === 'user') return staffRecordLabel(actor.userId);
  return String(actor.recordLabel || actor.label || actor.kind);
}

const ID_LIMIT = 256;

/** A date for an audit detail (JSON): ISO text, or null. */
function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function text(value, limit = ID_LIMIT) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, limit);
}

/**
 * Write one audit row with `db` (a transaction client inside a change). Throws on a programming
 * error (unknown action, actor kind or surface) as well as on a failed write.
 */
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

/** AuditRow, the shape every list returns. */
function presentAuditRow(row) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    actor: { kind: row.actorKind, userId: row.actorUserId || null, label: row.actorLabel, role: row.actorRole },
    action: row.action,
    target: { type: row.targetType, id: row.targetId || null, label: row.targetLabel || null },
    reason: row.reason || null,
    detail: row.detail === undefined ? null : row.detail,
    surface: row.surface,
    requestId: row.requestId || null,
  };
}

const ACTION_PREFIX = /^[a-z_]+(\.[a-z_]+)*\.$/;
const FILTER_VALUE = /^[A-Za-z0-9._:@+-]{1,256}$/;

function parseDate(value, name) {
  if (value === undefined || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new OpsError(400, 'INVALID_REQUEST', `${name} must be an ISO date.`);
  return date;
}

function parsePaging(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

function createdAtRange(query) {
  const from = parseDate(query.from, 'from');
  const to = parseDate(query.to, 'to');
  if (!from && !to) return null;
  const range = {};
  if (from) range.gte = from;
  if (to) range.lte = to;
  return range;
}

function filterValue(query, name) {
  const value = query[name];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !FILTER_VALUE.test(value)) {
    throw new OpsError(400, 'INVALID_REQUEST', `${name} is not valid.`);
  }
  return value;
}

/** GET /api/ops/audit: filters, newest first, paged. */
async function listAudit(query = {}, db = prisma) {
  const where = {};
  if (query.action !== undefined && query.action !== '') {
    const action = String(query.action);
    if (action.endsWith('.')) {
      if (!ACTION_PREFIX.test(action)) throw new OpsError(400, 'INVALID_REQUEST', 'action is not valid.');
      where.action = { startsWith: action };
    } else if (AUDIT_ACTIONS.includes(action)) {
      where.action = action;
    } else {
      throw new OpsError(400, 'INVALID_REQUEST', 'action is not valid.');
    }
  }
  for (const name of ['actorUserId', 'targetType', 'targetId']) {
    const value = filterValue(query, name);
    if (value) where[name] = value;
  }
  const range = createdAtRange(query);
  if (range) where.createdAt = range;
  const { limit, offset } = parsePaging(query);
  const [total, rows] = await Promise.all([
    db.opsAuditLog.count({ where }),
    db.opsAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
    }),
  ]);
  return { total, limit, offset, items: rows.map(presentAuditRow) };
}

/** The newest rows about one user (the user view's History section). */
async function auditForUser(userId, { take = 20 } = {}, db = prisma) {
  const rows = await db.opsAuditLog.findMany({
    where: { targetType: 'user', targetId: userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  });
  return rows.map(presentAuditRow);
}

function firstSegment(routePath) {
  const segment = String(routePath || '').split('/').filter(Boolean)[0];
  return segment || 'ops';
}

/**
 * The generic row for an ops write that wrote none of its own: action `ops.write`, the target
 * from the route params (userId: a user; id: the path's first segment) or, for a create, the new
 * record the handler named with `noteCreated`, and a detail of method, route, params and status.
 * Never the body.
 */
function genericWriteRow(req, res) {
  const route = req.opsRoute || {};
  const params = route.params || {};
  const routePath = route.path || req.path;
  const created = req.auditCreated || null;
  let target;
  if (params.userId) target = { type: 'user', id: params.userId };
  else target = { type: firstSegment(routePath), id: params.id || null };
  if (created) target = { type: created.type || target.type, id: created.id };
  return {
    actor: actorFromOps(req.opsAdmin),
    action: 'ops.write',
    target,
    detail: {
      method: req.method,
      route: `${route.baseUrl || req.baseUrl || ''}${routePath || ''}`,
      params,
      status: res.statusCode,
    },
    surface: 'ops',
    requestId: req.reqId || null,
  };
}

/**
 * A create handler names the record it made, so the generic row's targetId is the new id (a
 * create route has no id in its path). `type` defaults to the route's first path segment.
 */
function noteCreated(req, id, type = null) {
  if (id === undefined || id === null || id === '') return;
  req.auditCreated = { id: String(id), ...(type ? { type: String(type) } : {}) };
}

/** Where a failed generic write is reported. Replaceable for tests. */
const auditLog = {
  error: (event, entry) => logger.error(event, entry),
};

/**
 * Route middleware for an ops route that moves money or balances: the handler writes its own
 * `action` row with `req.auditChange(tx, { target, reason, detail })` inside the transaction of
 * the change, and the generic row is skipped (also when the call changed nothing). A further
 * change the call makes writes its own row with `req.auditChangeAs(otherAction)`.
 */
function auditInChange(action) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`Unknown audit action: ${action}`);
  return function markAuditInChange(req, res, next) {
    let actor;
    try {
      actor = actorFromOps(req.opsAdmin);
    } catch (error) {
      return res.status(error.status || 403).json({ status: 'fail', code: error.code, message: error.message });
    }
    const writer = (rowAction) => async (tx, { target, reason = null, detail }) => {
      const row = await writeAudit(tx, {
        actor, action: rowAction, target, reason, detail, surface: 'ops', requestId: req.reqId || null,
      });
      req.auditWritten = true;
      return row;
    };
    req.auditInChange = action;
    req.auditChange = writer(action);
    // A second change the same call makes (a payment confirm attests its order): its own action,
    // the same actor, written inside that change's transaction.
    req.auditChangeAs = (other) => {
      if (!AUDIT_ACTIONS.includes(other)) throw new Error(`Unknown audit action: ${other}`);
      return writer(other);
    };
    return next();
  };
}

/**
 * Generic ops writes use the same redacted row as the response middleware, but the handler
 * explicitly awaits it inside its mutation's transaction (or before returning external output).
 * A create may override only the target id; route metadata and status come from the router.
 */
function auditGenericWrite(mode, statusCode = 200) {
  if (!['transaction', 'external'].includes(mode)) throw new Error(`Unknown generic audit mode: ${mode}`);
  return function markGenericAudit(req, res, next) {
    req.auditGenericMode = mode;
    req.auditGeneric = async (tx, createdId) => {
      const row = genericWriteRow(req, { statusCode });
      if (createdId !== undefined) {
        if (typeof createdId !== 'string' || !createdId) throw new Error('A created audit target needs an id');
        row.target = { ...row.target, id: createdId };
      }
      const saved = await writeAudit(tx, row);
      req.auditWritten = true;
      return saved;
    };
    return next();
  };
}

/** Start the generic row for a finished write, unless it needs none. */
function recordGenericWrite(req, res) {
  if (req.auditWritten || req.auditInChange || req.auditGenericMode) return;
  if (res.statusCode < 200 || res.statusCode >= 300) return;
  const kind = req.opsAdmin && req.opsAdmin.kind;
  if (kind !== 'user' && kind !== 'shared') return;
  let row;
  try {
    row = genericWriteRow(req, res);
  } catch (error) {
    auditLog.error('ops_audit_write_failed', { reqId: req.reqId || null, errorName: error && error.name });
    return;
  }
  req.auditPending = writeAudit(prisma, row).catch((error) => {
    auditLog.error('ops_audit_write_failed', {
      reqId: req.reqId || null,
      action: 'ops.write',
      errorName: error && error.name,
    });
  });
}

/**
 * Mounted after protectOps: one `ops.write` row for each non-GET request that ended 2xx and
 * did not write its own row (`req.auditWritten`). A failed write is logged as an error only: the
 * change it describes has already been made and answered.
 *
 * The row starts when the handler ends the response (`res.end`), not on 'finish': a client that
 * hangs up before the answer is sent never gets a 'finish', but the handler still made its change
 * and still calls `res.end` (with the status already set), so the change is still recorded.
 */
function auditOpsWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const originalEnd = res.end;
  let recorded = false;
  res.end = function auditedEnd(...args) {
    if (!recorded) {
      recorded = true;
      recordGenericWrite(req, res);
    }
    return originalEnd.apply(this, args);
  };
  return next();
}

module.exports = {
  OpsError,
  SCRIPT_ACTOR,
  staffRecordLabel,
  recordLabelOf,
  actorFromOps,
  actorFromUser,
  writeAudit,
  isoOrNull,
  presentAuditRow,
  listAudit,
  auditForUser,
  auditOpsWrites,
  auditInChange,
  auditGenericWrite,
  noteCreated,
  auditLog,
  parsePaging,
  createdAtRange,
  filterValue,
  _internals: { genericWriteRow, firstSegment },
};
