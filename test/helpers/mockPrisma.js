/**
 * Hand-rolled in-memory Prisma stand-in for unit tests. Installed into require.cache in place
 * of src/utils/prisma.js BEFORE any service is required, so no test needs a database.
 *
 * Supported: findUnique / findFirst / findMany / count / create / update / upsert / updateMany /
 * delete / deleteMany / groupBy (`by` one or more columns, optional `_max` and `_count`) with `where`
 * conditions on scalar equality, null, { gt, gte, lt, lte, not, in, equals }, `NOT: {...}`,
 * `OR: [...]` and JSON path filters (`{ path: [...], equals }`); `{ increment }` in update data;
 * `include` for the relations declared below (to-one with optional `select`, to-many with optional
 * `where`); column defaults on create for the models that declare them below.
 * `select` is ignored on reads — the whole row comes back — so a test must never rely on it to
 * hide a column.
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
    if (key === 'OR') return cond.some((alt) => matches(row, alt));
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

function makeModel(store, name, { relations = {}, defaults = () => ({}) } = {}) {
  const rows = (store[name] = store[name] || []);
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
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) row[key] = (row[key] || 0) + value.increment;
      else row[key] = value;
    }
    return row;
  };
  return {
    rows,
    findUnique: async ({ where, include }) => withInclude(rows.find((r) => matches(r, where)) || null, include),
    findFirst: async ({ where, include } = {}) => withInclude(rows.find((r) => matches(r, where)) || null, include),
    findMany: async ({ where, include } = {}) => rows.filter((r) => matches(r, where)).map((r) => withInclude({ ...r }, include)),
    count: async ({ where } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }) => {
      const row = { id: crypto.randomUUID(), createdAt: new Date(), ...defaults(), ...data };
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
      const created = { id: crypto.randomUUID(), createdAt: new Date(), ...defaults(), ...create };
      rows.push(created);
      return { ...created };
    },
    updateMany: async ({ where, data }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }) => {
      const index = rows.findIndex((r) => matches(r, where));
      if (index < 0) throw new Error(`mockPrisma: ${name} record not found`);
      return rows.splice(index, 1)[0];
    },
    groupBy: async ({ by, where, _max, _count } = {}) => {
      if (!Array.isArray(by) || by.length === 0) throw new Error('mockPrisma: groupBy needs at least one `by` column');
      // One column groups on the raw value (as before); several on their JSON tuple.
      const groupKey = (row) => (by.length === 1 ? row[by[0]] : JSON.stringify(by.map((column) => row[column])));
      const groups = new Map();
      for (const r of rows.filter((row) => matches(row, where))) {
        const key = groupKey(r);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      return [...groups.values()].map((members) => {
        const out = Object.fromEntries(by.map((column) => [column, members[0][column]]));
        if (_max) {
          out._max = {};
          for (const field of Object.keys(_max).filter((k) => _max[k])) {
            out._max[field] = members.reduce((best, m) => (best == null || m[field] > best ? m[field] : best), null);
          }
        }
        if (_count) {
          out._count = {};
          for (const field of Object.keys(_count).filter((k) => _count[k])) {
            out._count[field] = field === '_all' ? members.length : members.filter((m) => m[field] != null).length;
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

function createMockPrisma() {
  const store = {};
  const prisma = {
    store,
    user: makeModel(store, 'user'),
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
    // Commerce rows that attestHashOnChain writes to (purchase orders and disbursement items).
    purchaseOrder: makeModel(store, 'purchaseOrder', {
      relations: {
        lineItems: { model: 'orderLineItem', field: 'id', references: 'orderId', many: true },
        payments: { model: 'payment', field: 'id', references: 'orderId', many: true },
        allocations: { model: 'procurementAllocation', field: 'id', references: 'orderId', many: true },
      },
    }),
    orderLineItem: makeModel(store, 'orderLineItem'),
    payment: makeModel(store, 'payment'),
    procurementAllocation: makeModel(store, 'procurementAllocation'),
    dataNFT: makeModel(store, 'dataNFT'),
    disbursementPartner: makeModel(store, 'disbursementPartner'),
    disbursementItem: makeModel(store, 'disbursementItem', {
      relations: { partner: { model: 'disbursementPartner', field: 'partnerId', references: 'id' } },
    }),
    // Column defaults as in prisma/migrations/20260929010000_tracked_links.
    trackedLink: makeModel(store, 'trackedLink', {
      defaults: () => ({ body: '', buttonLabel: '', targetUrl: null, active: true, updatedAt: new Date() }),
    }),
    trackedLinkHit: makeModel(store, 'trackedLinkHit', {
      defaults: () => ({ dest: null, referrerHost: null }),
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
function installMockPrisma() {
  unrefModuleTimers();
  const prisma = createMockPrisma();
  installIntoCache(path.join(__dirname, '../../src/utils/prisma.js'), prisma);
  // authMiddleware constructs its own PrismaClient at load time; keep it inert in tests.
  installIntoCache('@prisma/client', { PrismaClient: class PrismaClient {} });
  return prisma;
}

module.exports = { createMockPrisma, installMockPrisma, matches };
