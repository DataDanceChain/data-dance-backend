/**
 * Hand-rolled in-memory Prisma stand-in for unit tests. Installed into require.cache in place
 * of src/utils/prisma.js BEFORE any service is required, so no test needs a database.
 *
 * Supported: findUnique / findFirst / findMany / create / update / updateMany / delete /
 * deleteMany with `where` conditions on scalar equality, null, and { gt, gte, lt, lte, not,
 * in, equals }; `include` for the relations declared below (with optional `select`).
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

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    // Prisma passes a compound unique key as `a_b: { a, b }`; match its parts against the row.
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date) && !isConditionObject(cond)) {
      return matches(row, cond);
    }
    return matchValue(row[key], cond);
  });
}

function makeModel(store, name, { relations = {} } = {}) {
  const rows = (store[name] = store[name] || []);
  const withInclude = (row, include) => {
    if (!row || !include) return row;
    const out = { ...row };
    for (const [rel, spec] of Object.entries(include)) {
      if (!spec) continue;
      const def = relations[rel];
      if (!def) throw new Error(`mockPrisma: unknown relation ${name}.${rel}`);
      const target = (store[def.model] || []).find((t) => t[def.references] === row[def.field]) || null;
      if (target && spec.select) {
        out[rel] = Object.fromEntries(Object.keys(spec.select).filter((k) => spec.select[k]).map((k) => [k, target[k]]));
      } else {
        out[rel] = target ? { ...target } : null;
      }
    }
    return out;
  };
  return {
    rows,
    findUnique: async ({ where, include }) => withInclude(rows.find((r) => matches(r, where)) || null, include),
    findFirst: async ({ where, include } = {}) => withInclude(rows.find((r) => matches(r, where)) || null, include),
    findMany: async ({ where } = {}) => rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    create: async ({ data }) => {
      const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`mockPrisma: ${name} record not found`);
      Object.assign(row, data);
      return { ...row };
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
    referral: makeModel(store, 'referral'),
    ssoTicket: makeModel(store, 'ssoTicket'),
    /** Interactive transactions run inline: the mock is single-threaded and never rolls back. */
    async $transaction(arg) {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    },
    reset() {
      Object.keys(store).forEach((key) => {
        store[key].length = 0;
      });
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
