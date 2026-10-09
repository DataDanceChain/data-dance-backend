/**
 * In-memory Prisma models for the buyer data-request (DataDemand), pack purchase and market tag tests.
 * Layered on test/helpers/mockPrisma.js without changing it: the models here replace or add to the
 * ones createMockPrisma() builds, sharing its store, its `user` rows and its inline $transaction.
 *
 * Adds what these flows use and the shared helper does not: orderBy / skip / take; `include` and
 * `select` on every read and write, nested (`include: { dataNFT: { include: { tags: true } } }`,
 * `buyer: { select: {...} }`, to-many with `where` / `orderBy`); `_sum` and `_count` aggregates;
 * relation filters (`tags: { some: {...} }`) and the implicit DataNFT <-> Tag many-to-many link.
 * Created rows get a strictly increasing createdAt, so createdAt ordering is deterministic.
 * The mock never rolls a transaction back.
 */
const crypto = require('crypto');
const { installMockPrisma, matches } = require('./mockPrisma');

let clock = Date.UTC(2026, 8, 19, 12, 0, 0);
function nextDate() {
  clock += 1000;
  return new Date(clock);
}

function sortRows(rows, orderBy) {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((entry) => Object.entries(entry));
  if (!keys.length) return rows;
  const value = (v) => (v instanceof Date ? v.getTime() : v);
  return [...rows].sort((a, b) => {
    for (const [key, direction] of keys) {
      const x = value(a[key]);
      const y = value(b[key]);
      if (x === y) continue;
      const cmp = x < y ? -1 : 1;
      return direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

/**
 * Relation definitions, by model:
 *   to-one   { model, field, references }             target[references] === row[field]
 *   to-many  { model, field, references, many: true } target[references] === row[field]
 *   link     { model, link, self, other, many: true } pairs in store[link]: { [self]: row.id, [other]: target.id }
 */
const RELATIONS = {
  user: {},
  legalEntity: {},
  tag: { dataNFTs: { model: 'dataNFT', link: 'dataNFTTag', self: 'tagId', other: 'dataNFTId', many: true } },
  dataNFT: {
    merchant: { model: 'user', field: 'merchantId', references: 'id' },
    tags: { model: 'tag', link: 'dataNFTTag', self: 'dataNFTId', other: 'tagId', many: true },
    snapshots: { model: 'snapshot', field: 'id', references: 'dataNFTId', many: true },
    purchases: { model: 'dataNFTPurchase', field: 'id', references: 'dataNFTId', many: true },
  },
  dataNFTPurchase: {
    dataNFT: { model: 'dataNFT', field: 'dataNFTId', references: 'id' },
    buyer: { model: 'user', field: 'buyerId', references: 'id' },
  },
  organizationTransaction: {},
  dataDemand: {
    buyer: { model: 'user', field: 'buyerId', references: 'id' },
    dataNFT: { model: 'dataNFT', field: 'dataNFTId', references: 'id' },
    events: { model: 'demandEvent', field: 'id', references: 'demandId', many: true },
  },
  demandEvent: {
    demand: { model: 'dataDemand', field: 'demandId', references: 'id' },
  },
};

/** Column defaults as in prisma/schema.prisma for the columns these tests leave out. */
const DEFAULTS = {
  dataNFT: () => ({ isPublished: false, dataSource: 'activity', dataRecords: null, description: null, image: null }),
  dataNFTPurchase: () => ({ quantity: 1 }),
  dataDemand: () => ({
    status: 'submitted', category: null, region: null, deadline: null, similarPackId: null,
    quotedCount: null, quotedPriceUsd: null, quoteNote: null, quoteExpiresAt: null, declineReason: null,
    dataNFTId: null, purchaseId: null, orderId: null,
  }),
  demandEvent: () => ({ actorId: null, fromStatus: null, toStatus: null, note: null }),
  legalEntity: () => ({ kycStatus: 'incomplete' }),
  tag: () => ({}),
  organizationTransaction: () => ({ description: null, metadata: null }),
};

function installDemandModels(prisma) {
  const store = prisma.store;
  const rowsOf = (name) => (store[name] = store[name] || []);

  function related(name, row, relName) {
    const def = (RELATIONS[name] || {})[relName];
    if (!def) throw new Error(`demandPrisma: unknown relation ${name}.${relName}`);
    const targets = rowsOf(def.model);
    if (def.link) {
      const ids = new Set(rowsOf(def.link).filter((pair) => pair[def.self] === row.id).map((pair) => pair[def.other]));
      return targets.filter((target) => ids.has(target.id));
    }
    if (def.many) return targets.filter((target) => target[def.references] === row[def.field]);
    return targets.find((target) => target[def.references] === row[def.field]) || null;
  }

  function whereMatches(name, row, where = {}) {
    return Object.entries(where).every(([key, cond]) => {
      const def = (RELATIONS[name] || {})[key];
      if (def && cond && typeof cond === 'object') {
        const found = related(name, row, key);
        const list = Array.isArray(found) ? found : found ? [found] : [];
        if ('some' in cond) return list.some((target) => whereMatches(def.model, target, cond.some));
        if ('none' in cond) return !list.some((target) => whereMatches(def.model, target, cond.none));
        if ('every' in cond) return list.every((target) => whereMatches(def.model, target, cond.every));
        return list.some((target) => whereMatches(def.model, target, cond));
      }
      if (key === 'OR') return cond.some((alt) => whereMatches(name, row, alt));
      if (key === 'NOT') return !whereMatches(name, row, cond);
      return matches(row, { [key]: cond });
    });
  }

  function resolve(name, row, relName, spec) {
    const def = RELATIONS[name][relName];
    const args = spec === true ? {} : spec;
    const found = related(name, row, relName);
    if (!def.many) return found ? shape(def.model, found, args) : null;
    const filtered = found.filter((target) => whereMatches(def.model, target, args.where || {}));
    return sortRows(filtered, args.orderBy).map((target) => shape(def.model, target, args));
  }

  /** Apply `select` / `include` the way Prisma does: select lists exactly what comes back. */
  function shape(name, row, { select, include } = {}) {
    if (!row) return row;
    const relations = RELATIONS[name] || {};
    if (select) {
      const out = {};
      for (const [key, spec] of Object.entries(select)) {
        if (!spec) continue;
        out[key] = relations[key] ? resolve(name, row, key, spec) : row[key];
      }
      return out;
    }
    const out = { ...row };
    for (const [key, spec] of Object.entries(include || {})) {
      if (!spec) continue;
      if (!relations[key]) throw new Error(`demandPrisma: unknown relation ${name}.${key}`);
      out[key] = resolve(name, row, key, spec);
    }
    return out;
  }

  function model(name) {
    const rows = rowsOf(name);
    const find = (where) => rows.find((row) => whereMatches(name, row, where));
    return {
      rows,
      findUnique: async ({ where, ...args }) => shape(name, find(where) || null, args),
      findFirst: async ({ where = {}, orderBy, ...args } = {}) =>
        shape(name, sortRows(rows.filter((row) => whereMatches(name, row, where)), orderBy)[0] || null, args),
      findMany: async ({ where = {}, orderBy, skip = 0, take, ...args } = {}) => {
        const hit = sortRows(rows.filter((row) => whereMatches(name, row, where)), orderBy);
        const page = hit.slice(skip, take === undefined ? undefined : skip + take);
        return page.map((row) => shape(name, row, args));
      },
      count: async ({ where = {} } = {}) => rows.filter((row) => whereMatches(name, row, where)).length,
      create: async ({ data, ...args }) => {
        const now = nextDate();
        const row = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...(DEFAULTS[name] || (() => ({})))(), ...data };
        rows.push(row);
        return shape(name, row, args);
      },
      update: async ({ where, data, ...args }) => {
        const row = find(where);
        if (!row) throw Object.assign(new Error(`demandPrisma: ${name} record not found`), { code: 'P2025' });
        Object.assign(row, data, { updatedAt: nextDate() });
        return shape(name, row, args);
      },
      delete: async ({ where }) => {
        const index = rows.findIndex((row) => whereMatches(name, row, where));
        if (index < 0) throw Object.assign(new Error(`demandPrisma: ${name} record not found`), { code: 'P2025' });
        return rows.splice(index, 1)[0];
      },
      deleteMany: async ({ where = {} } = {}) => {
        const keep = rows.filter((row) => !whereMatches(name, row, where));
        const count = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { count };
      },
      aggregate: async ({ where = {}, _sum, _count } = {}) => {
        const hit = rows.filter((row) => whereMatches(name, row, where));
        const out = {};
        if (_sum) {
          out._sum = {};
          for (const key of Object.keys(_sum).filter((k) => _sum[k])) {
            out._sum[key] = hit.length ? hit.reduce((total, row) => total + (row[key] || 0), 0) : null;
          }
        }
        if (_count) {
          out._count = {};
          for (const key of Object.keys(_count).filter((k) => _count[k])) {
            out._count[key] = key === '_all' ? hit.length : hit.filter((row) => row[key] != null).length;
          }
        }
        return out;
      },
    };
  }

  for (const name of ['legalEntity', 'tag', 'dataNFT', 'dataNFTPurchase', 'organizationTransaction', 'dataDemand', 'demandEvent']) {
    prisma[name] = model(name);
  }
  rowsOf('dataNFTTag');
  rowsOf('snapshot');
  return prisma;
}

/**
 * Call once at the top of a test file, before requiring anything under src/. Every module gets the
 * same in-memory store: src/utils/prisma.js and every `new PrismaClient()` (auth middlewares,
 * dataNFTController, nftMarketController).
 */
function installDemandPrisma() {
  const prisma = installDemandModels(installMockPrisma());
  require.cache[require.resolve('@prisma/client')].exports = {
    PrismaClient: function PrismaClient() {
      return prisma;
    },
    Prisma: {},
  };
  return prisma;
}

/** Empty every table these tests use (the shared helper's reset() also clears its own tables). */
function resetDemandStore(prisma) {
  prisma.reset();
}

/** Fixtures. Synthetic values only: example.test addresses, generated ids. */
async function seedUser(prisma, over = {}) {
  const id = over.id || `user-${crypto.randomUUID()}`;
  const row = {
    id,
    email: `${id}@example.test`,
    name: over.name || id,
    isOrganization: false,
    userType: 'regular',
    disabledAt: null,
    referralCode: id.slice(0, 12),
    createdAt: nextDate(),
    ...over,
  };
  prisma.user.rows.push(row);
  return row;
}

/** An organization (merchant) account; `kyc: true` adds a complete company KYC record. */
async function seedMerchant(prisma, { kyc = true, ...over } = {}) {
  const user = await seedUser(prisma, { isOrganization: true, userType: 'organization', ...over });
  if (kyc) {
    await prisma.legalEntity.create({
      data: {
        userId: user.id,
        companyName: `${user.id} Ltd`,
        brNumber: 'BR-0001',
        beneficialOwner: 'Test Owner',
        address: '1 Test Street',
        country: 'SG',
        email: `kyc-${user.id}@example.test`,
        kycStatus: 'submitted',
      },
    });
  }
  return user;
}

async function seedPack(prisma, { merchantId, price = 10, isPublished = true, records = 3, tags = [], ...over }) {
  const pack = await prisma.dataNFT.create({
    data: {
      name: `Pack ${crypto.randomUUID().slice(0, 8)}`,
      price,
      isPublished,
      merchantId,
      dataSource: 'upload',
      dataRecords: { recordCount: records, records: Array.from({ length: records }, (_, i) => ({ row: i + 1 })) },
      ...over,
    },
  });
  for (const tagId of tags) prisma.store.dataNFTTag.push({ dataNFTId: pack.id, tagId });
  return pack;
}

async function seedBalance(prisma, userId, amount) {
  return prisma.organizationTransaction.create({
    data: { userId, amount, type: 'DEPOSIT', status: 'COMPLETED', description: 'test top-up' },
  });
}

module.exports = {
  installDemandPrisma,
  installDemandModels,
  resetDemandStore,
  seedUser,
  seedMerchant,
  seedPack,
  seedBalance,
  nextDate,
};
