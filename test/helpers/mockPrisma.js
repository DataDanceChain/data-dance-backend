/**
 * Hand-rolled in-memory Prisma stand-in for unit tests. Installed into require.cache in place
 * of src/utils/prisma.js BEFORE any service is required, so no test needs a database.
 *
 * Supported: findUnique / findFirst / findMany / count / create / update / upsert / updateMany /
 * delete / deleteMany / groupBy (`by` one column, optional `_max`) with `where` conditions on scalar
 * equality, null, { gt, gte, lt, lte, not, in, equals }, `NOT: {...}` and JSON path filters
 * (`{ path: [...], equals }`); `{ increment }` in update data; `include` for the relations
 * declared below (to-one with optional `select`, to-many with optional `where`).
 * `select` is ignored on reads — the whole row comes back — so a test must never rely on it to
 * hide a column.
 *
 * Unique constraints: a model declared with `uniques` (the native-login models always; `user`
 * only when `createMockPrisma({ enforceUnique: true })` / `installMockPrisma({ enforceUnique:
 * true })`) rejects a create / update / upsert that would duplicate one of them with an error
 * shaped like Prisma's (`code: 'P2002'`, `meta.target`), so the race paths can be unit-tested.
 * NULL never collides, as in Postgres. `defaults` fills the columns Prisma would default (a
 * function default is called per row, like `now()`).
 */
const path = require('path');
const crypto = require('crypto');

function matchValue(actual, cond) {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond === 'object' && !Array.isArray(cond)) {
    // Prisma's `mode: 'insensitive'` applies to the string comparisons in the same condition.
    const fold = (v) =>
      cond.mode === 'insensitive' && typeof v === 'string' ? v.toLowerCase() : v;
    return Object.entries(cond).every(([op, value]) => {
      switch (op) {
        case 'mode': return true;
        case 'gt': return actual > value;
        case 'gte': return actual >= value;
        case 'lt': return actual < value;
        case 'lte': return actual <= value;
        case 'not': return !matchValue(actual, value);
        case 'in': return value.map(fold).includes(fold(actual));
        case 'equals': return fold(actual) === fold(value);
        default: throw new Error(`mockPrisma: unsupported operator "${op}"`);
      }
    });
  }
  return actual === cond;
}

const OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'not', 'in', 'equals', 'mode']);

/** `{ gt: 1 }` is a condition; `{ web3authVerifier: 'x', web3authVerifierId: 'y' }` is a compound key. */
function isConditionObject(cond) {
  return (
    cond &&
    typeof cond === 'object' &&
    !Array.isArray(cond) &&
    !(cond instanceof Date) &&
    Object.keys(cond).every((key) => OPERATORS.has(key))
  );
}

/** Prisma JSON filter: `metadata: { path: ['a', 'b'], equals: 'x' }`. */
function isJsonPathFilter(cond) {
  return cond && typeof cond === 'object' && Array.isArray(cond.path);
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'NOT') return !matches(row, cond);
    if (isJsonPathFilter(cond)) {
      const { path: jsonPath, ...rest } = cond;
      const value = jsonPath.reduce((obj, part) => (obj == null ? undefined : obj[part]), row[key]);
      return matchValue(value, rest);
    }
    // Prisma passes a compound unique key as `a_b: { a, b }`; match its parts against the row.
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date) && !isConditionObject(cond)) {
      return matches(row, cond);
    }
    return matchValue(row[key], cond);
  });
}

/** The error Prisma throws for a unique violation, reduced to what callers inspect. */
function uniqueViolation(model, fields) {
  const err = new Error(`Unique constraint failed on the fields: (${fields.map((f) => `\`${f}\``).join(',')})`);
  err.name = 'PrismaClientKnownRequestError';
  err.code = 'P2002';
  err.meta = { modelName: model, target: [...fields] };
  return err;
}

function makeModel(store, name, { relations = {}, uniques = [], defaults = {} } = {}) {
  const rows = (store[name] = store[name] || []);
  /** Throws P2002 when `candidate` would duplicate a unique key of another row (`self` excluded). */
  const assertUnique = (candidate, self) => {
    for (const fields of uniques) {
      if (fields.some((f) => candidate[f] === null || candidate[f] === undefined)) continue;
      const clash = rows.some((r) => r !== self && fields.every((f) => r[f] === candidate[f]));
      if (clash) throw uniqueViolation(name, fields);
    }
  };
  const newRow = (data) => {
    const filled = Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, typeof v === 'function' ? v() : v]));
    const row = { id: crypto.randomUUID(), createdAt: new Date(), ...filled, ...data };
    assertUnique(row, null);
    return row;
  };
  const withInclude = (row, include) => {
    if (!row || !include) return row;
    const out = { ...row };
    for (const [rel, spec] of Object.entries(include)) {
      if (!spec) continue;
      const def = relations[rel];
      if (!def) throw new Error(`mockPrisma: unknown relation ${name}.${rel}`);
      if (def.many) {
        out[rel] = (store[def.model] || [])
          .filter((t) => t[def.references] === row[def.field] && matches(t, spec.where || {}))
          .map((t) => ({ ...t }));
        continue;
      }
      const target = (store[def.model] || []).find((t) => t[def.references] === row[def.field]) || null;
      if (target && spec.select) {
        out[rel] = Object.fromEntries(Object.keys(spec.select).filter((k) => spec.select[k]).map((k) => [k, target[k]]));
      } else {
        out[rel] = target ? { ...target } : null;
      }
    }
    return out;
  };
  const applyData = (row, data) => {
    if (uniques.length) assertUnique({ ...row, ...resolveData(row, data) }, row);
    Object.assign(row, resolveData(row, data));
    return row;
  };
  const resolveData = (row, data) => {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) out[key] = (row[key] || 0) + value.increment;
      else out[key] = value;
    }
    return out;
  };
  return {
    rows,
    findUnique: async ({ where, include }) => withInclude(rows.find((r) => matches(r, where)) || null, include),
    findFirst: async ({ where, include } = {}) => withInclude(rows.find((r) => matches(r, where)) || null, include),
    findMany: async ({ where, include } = {}) => rows.filter((r) => matches(r, where)).map((r) => withInclude({ ...r }, include)),
    count: async ({ where } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }) => {
      const row = newRow(data);
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`mockPrisma: ${name} record not found`);
      return { ...applyData(row, data) };
    },
    upsert: async ({ where, update, create }) => {
      const row = rows.find((r) => matches(r, where));
      if (row) return { ...applyData(row, update || {}) };
      const created = newRow(create);
      rows.push(created);
      return { ...created };
    },
    updateMany: async ({ where, data }) => {
      const hit = rows.filter((r) => matches(r, where));
      if (!uniques.length) {
        // Unchanged for the models without declared uniques (plain assignment, as before),
        // except that `{ increment }` is applied instead of stored as an object.
        hit.forEach((r) => Object.assign(r, resolveData(r, data)));
      } else {
        hit.forEach((r) => applyData(r, data));
      }
      return { count: hit.length };
    },
    delete: async ({ where }) => {
      const index = rows.findIndex((r) => matches(r, where));
      if (index < 0) throw new Error(`mockPrisma: ${name} record not found`);
      return rows.splice(index, 1)[0];
    },
    groupBy: async ({ by, where, _max } = {}) => {
      if (!Array.isArray(by) || by.length !== 1) throw new Error('mockPrisma: groupBy supports one `by` column');
      const [column] = by;
      const groups = new Map();
      for (const r of rows.filter((row) => matches(row, where))) {
        if (!groups.has(r[column])) groups.set(r[column], []);
        groups.get(r[column]).push(r);
      }
      return [...groups.entries()].map(([value, members]) => {
        const out = { [column]: value };
        if (_max) {
          out._max = {};
          for (const field of Object.keys(_max).filter((k) => _max[k])) {
            out._max[field] = members.reduce((best, m) => (best == null || m[field] > best ? m[field] : best), null);
          }
        }
        return out;
      });
    },
    deleteMany: async ({ where } = {}) => {
      const before = rows.length;
      const keep = rows.filter((r) => !matches(r, where));
      rows.length = 0;
      rows.push(...keep);
      return { count: before - keep.length };
    },
  };
}

/** Unique keys of the User columns native login races on (email, wallet, X id, legacy pair). */
const USER_UNIQUES = [['email'], ['walletAddress'], ['xid'], ['referralCode'], ['legacyReferralCode'], ['web3authVerifier', 'web3authVerifierId']];

function createMockPrisma({ enforceUnique = false } = {}) {
  const store = {};
  const prisma = {
    store,
    user: makeModel(store, 'user', enforceUnique ? { uniques: USER_UNIQUES } : {}),
    oAuthClient: makeModel(store, 'oAuthClient'),
    oAuthAuthorization: makeModel(store, 'oAuthAuthorization'),
    oAuthRefreshToken: makeModel(store, 'oAuthRefreshToken'),
    mcpToken: makeModel(store, 'mcpToken', {
      relations: { user: { model: 'user', field: 'userId', references: 'id' } },
    }),
    dataLicenceConsent: makeModel(store, 'dataLicenceConsent'),
    referral: makeModel(store, 'referral', {
      relations: {
        invitee: { model: 'user', field: 'inviteeId', references: 'id' },
        inviter: { model: 'user', field: 'inviterId', references: 'id' },
      },
    }),
    crawlerData: makeModel(store, 'crawlerData'),
    point: makeModel(store, 'point'),
    task: makeModel(store, 'task', {
      relations: { UserTasks: { model: 'userTask', field: 'id', references: 'taskId', many: true } },
    }),
    userTask: makeModel(store, 'userTask'),
    userAward: makeModel(store, 'userAward'),
    userDailyEvent: makeModel(store, 'userDailyEvent'),
    crawlerTask: makeModel(store, 'crawlerTask'),
    ssoTicket: makeModel(store, 'ssoTicket'),
    // Native login (prisma/migrations/20260930090000_native_auth_identity). Uniques and defaults
    // mirror the schema.
    authIdentity: makeModel(store, 'authIdentity', {
      relations: { user: { model: 'user', field: 'userId', references: 'id' } },
      uniques: [['provider', 'subject']],
      defaults: { email: null, emailLinkGrade: 'none', isPrivateRelay: false, lastLoginAt: null },
    }),
    nativeWalletBinding: makeModel(store, 'nativeWalletBinding', {
      relations: { user: { model: 'user', field: 'userId', references: 'id' } },
      uniques: [['userId'], ['subject'], ['connection', 'subject']],
      defaults: { boundAt: () => new Date() },
    }),
    authLoginAttempt: makeModel(store, 'authLoginAttempt', {
      relations: { user: { model: 'user', field: 'userId', references: 'id' } },
      uniques: [['id']],
      defaults: {
        email: null,
        emailLinkGrade: 'none',
        isPrivateRelay: false,
        profile: null,
        userId: null,
        pendingUserId: null,
        w3aSubject: null,
        walletProof: null,
        w3aTokenCount: 0,
        lastJti: null,
        state: 'identified',
        ipHash: null,
        completedAt: null,
      },
    }),
    authEmailChallenge: makeModel(store, 'authEmailChallenge', {
      uniques: [['id']],
      defaults: { attempts: 0, ipHash: null, consumedAt: null, lockedAt: null },
    }),
    authFlowState: makeModel(store, 'authFlowState', {
      uniques: [['id'], ['valueHash']],
      defaults: { valueHash: null, consumedAt: null },
    }),
    walletAddressHistory: makeModel(store, 'walletAddressHistory', {
      uniques: [['id']],
      defaults: { oldVerifier: null, oldVerifierId: null, chainRef: null, appliedAt: null },
    }),
    /** Interactive transactions run inline: the mock is single-threaded and never rolls back. */
    async $transaction(arg) {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    },
    /**
     * Raw statements have no in-memory meaning; the only one the unit-tested paths issue is the
     * late-bind advisory lock (referralService.createLateBindReferral). Recorded, not run.
     */
    rawStatements: [],
    async $executeRaw(strings, ...values) {
      prisma.rawStatements.push({ sql: Array.isArray(strings) ? strings.join('?') : String(strings), values });
      return 0;
    },
    /** Same as $executeRaw (recorded, not run); answers an empty result set. */
    async $queryRaw(strings, ...values) {
      prisma.rawStatements.push({ sql: Array.isArray(strings) ? strings.join('?') : String(strings), values });
      return [];
    },
    reset() {
      Object.keys(store).forEach((key) => {
        store[key].length = 0;
      });
      prisma.rawStatements.length = 0;
    },
  };
  return prisma;
}

function installIntoCache(specifier, exportsValue) {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
  return filename;
}

/**
 * Module-level `setInterval` calls (e.g. the rate-limit store sweeper) would keep the test
 * process alive after the last assertion; unref them so `node --test` can exit.
 */
function unrefModuleTimers() {
  if (global.setInterval.__unrefPatched) return;
  const original = global.setInterval;
  const patched = (...args) => {
    const timer = original(...args);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };
  patched.__unrefPatched = true;
  global.setInterval = patched;
}

/** Call once at the top of a test file, before requiring anything under src/. */
function installMockPrisma(options = {}) {
  unrefModuleTimers();
  const prisma = createMockPrisma(options);
  installIntoCache(path.join(__dirname, '../../src/utils/prisma.js'), prisma);
  // authMiddleware constructs its own PrismaClient at load time; keep it inert in tests.
  installIntoCache('@prisma/client', { PrismaClient: class PrismaClient {} });
  return prisma;
}

module.exports = { createMockPrisma, installMockPrisma, matches, uniqueViolation };
