/**
 * "Read-only" as something the process enforces, not something a handler promises.
 *
 * The partner (TGE) API is documented as read-only, and it was not: `GET /partner/tge/status`
 * lazily allocated and PERSISTED a display referral code. A GET that writes on a money-adjacent
 * surface is both a correctness problem (a partner's read changes DataDance state) and an audit
 * problem (the write has no request of its own to hang off).
 *
 * The fix has two halves. The handler no longer allocates (see partnerTgeRoutes), and this
 * module makes the next one impossible to add by accident: while a request runs inside
 * `runReadOnly`, every write operation on the shared Prisma client throws — including writes
 * made deep inside a helper that has no idea which request it is serving.
 *
 * Mechanism: an AsyncLocalStorage scope plus wrapped write methods on the client. The wrapping
 * is what "actually fires" for both the real client and the in-memory test stand-in; when the
 * client also supports Prisma middleware (`$use`), that is installed as a second net so a model
 * accessed in some other way is still covered.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const INSTALLED = Symbol.for('ddc.prismaReadOnlyGuard');

/** Everything that can change a row. `$queryRaw` is a read and is deliberately absent. */
const MODEL_WRITE_METHODS = [
  'create', 'createMany', 'createManyAndReturn',
  'update', 'updateMany', 'upsert',
  'delete', 'deleteMany',
];
const CLIENT_WRITE_METHODS = ['$executeRaw', '$executeRawUnsafe', '$transaction'];

class ReadOnlyViolationError extends Error {
  constructor(operation, label) {
    super(`Read-only request (${label || 'unlabelled'}) attempted a write: ${operation}`);
    this.name = 'ReadOnlyViolationError';
    this.code = 'READ_ONLY_VIOLATION';
    this.operation = operation;
  }
}

/** The active read-only scope, or null. */
function readOnlyScope() {
  return storage.getStore() || null;
}

/** Run `fn` (and everything it awaits) with writes forbidden. */
function runReadOnly(label, fn) {
  return storage.run({ label, startedAt: Date.now() }, fn);
}

/** Escape hatch for a deliberate write inside a read-only request. Nothing uses it today. */
function runWritable(fn) {
  return storage.run(undefined, fn);
}

/**
 * Inside a read-only scope, allow `$queryRaw` for the duration of `fn` — and nothing else: model
 * writes and `$executeRaw` stay refused. Raw SQL is refused by default because a statement can hide
 * a write (`WITH x AS (DELETE …) SELECT …`); this is the explicit, named exception for vetted,
 * fixed, parameterised SELECTs. Its only caller is src/services/referralNetwork.js (recursive CTEs
 * the Prisma query API cannot express). Outside a read-only scope it just runs `fn`.
 */
function runVettedRawRead(label, fn) {
  const scope = readOnlyScope();
  if (!scope) return fn();
  return storage.run({ ...scope, vettedRawRead: String(label || 'unlabelled') }, fn);
}

function guarded(operation, original) {
  // Rejected promise, not a synchronous throw: every Prisma operation is awaited, and keeping
  // the same shape means the violation surfaces exactly where the write would have.
  const wrapper = function readOnlyGuarded(...args) {
    const scope = readOnlyScope();
    if (scope) return Promise.reject(new ReadOnlyViolationError(operation, scope.label));
    return original.apply(this, args);
  };
  wrapper.__readOnlyGuarded = true;
  return wrapper;
}

function looksLikeDelegate(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.findUnique === 'function';
}

/**
 * Idempotent. Call once, with the shared client, from the module that opens read-only scopes.
 */
function installReadOnlyGuard(client) {
  if (!client || client[INSTALLED]) return client;
  Object.defineProperty(client, INSTALLED, { value: true, enumerable: false, configurable: true });

  for (const key of Object.keys(client)) {
    let delegate;
    try {
      delegate = client[key];
    } catch {
      continue; // a getter that needs a connection: not our business
    }
    if (!looksLikeDelegate(delegate)) continue;
    for (const method of MODEL_WRITE_METHODS) {
      const original = delegate[method];
      if (typeof original !== 'function' || original.__readOnlyGuarded) continue;
      try {
        delegate[method] = guarded(`${key}.${method}`, original);
      } catch {
        // a frozen delegate: the $use net below still covers it
      }
    }
  }

  for (const method of CLIENT_WRITE_METHODS) {
    const original = client[method];
    if (typeof original !== 'function' || original.__readOnlyGuarded) continue;
    try {
      client[method] = guarded(method, original);
    } catch {
      // ignore
    }
  }

  if (typeof client.$use === 'function') {
    try {
      client.$use(async (params, next) => {
        const scope = readOnlyScope();
        const action = String(params?.action || '');
        const vettedRaw = action === 'queryRaw' && Boolean(scope && scope.vettedRawRead);
        if (scope && !vettedRaw && !action.startsWith('find') && action !== 'count' && action !== 'aggregate' && action !== 'groupBy') {
          throw new ReadOnlyViolationError(`${params?.model || 'unknown'}.${action}`, scope.label);
        }
        return next(params);
      });
    } catch {
      // a client without middleware support: the wrapping above is the guard
    }
  }

  return client;
}

module.exports = {
  installReadOnlyGuard,
  runReadOnly,
  runWritable,
  runVettedRawRead,
  readOnlyScope,
  ReadOnlyViolationError,
  MODEL_WRITE_METHODS,
};
