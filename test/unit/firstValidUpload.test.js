/**
 * The reward-eligible upload filter (decision 27 A, 2026-09-28): ordinary App uploads count, data-pack
 * imports never do.
 *
 * Postgres evaluates `metadata #> '{importSource}'` to SQL NULL when the key is missing, and a NOT over
 * NULL stays NULL, which drops the row. The in-memory mock treats a missing key as `undefined` and so
 * hid that bug; this file evaluates the Prisma `where` with SQL three-valued logic instead. The real
 * database proof is test/db/firstValidUpload.dbtest.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Prisma } = require('@prisma/client');

// firstValidUpload requires ../utils/prisma; the functions under test take `db` explicitly, so a stub
// keeps the suite free of any database connection.
require.cache[path.resolve(__dirname, '../../src/utils/prisma.js')] = {
  id: 'prisma-stub',
  loaded: true,
  exports: {},
};

const {
  NOT_DATA_PACK_IMPORT,
  rewardEligibleUploadWhere,
  hasCompletedFirstValidUpload,
  getUsersWithValidUploads,
} = require('../../src/utils/firstValidUpload');

/** `metadata #> path` as Postgres returns it: SQL NULL (here `undefined`) when any step is missing. */
function jsonPath(metadata, keys) {
  let cur = metadata;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const not3 = (v) => (v === undefined ? undefined : !v);
function and3(values) {
  if (values.some((v) => v === false)) return false;
  if (values.some((v) => v === undefined)) return undefined;
  return true;
}

/** Three-valued (TRUE / FALSE / NULL=undefined) evaluation of the subset of Prisma `where` used here. */
function evalWhere(row, where) {
  const parts = Object.entries(where).map(([key, cond]) => {
    if (key === 'NOT') return not3(evalWhere(row, cond));
    if (key === 'AND') return and3((Array.isArray(cond) ? cond : [cond]).map((c) => evalWhere(row, c)));
    if (cond && Array.isArray(cond.path)) {
      const v = jsonPath(row[key], cond.path);
      if (cond.equals === Prisma.DbNull) return v === undefined; // `IS NULL`
      if (v === undefined) return undefined; // NULL = 'x' is NULL
      return JSON.stringify(v) === JSON.stringify(cond.equals);
    }
    if (cond && typeof cond === 'object' && Array.isArray(cond.in)) return cond.in.includes(row[key]);
    return row[key] === cond;
  });
  return and3(parts);
}
const kept = (row, where) => evalWhere(row, where) === true; // WHERE keeps only TRUE rows

const ROWS = {
  emptyObject: { metadata: {} },
  sourceUrlOnly: { metadata: { sourceUrl: 'https://example.test/order/1' } },
  jsonNull: { metadata: null },
  importSourceNull: { metadata: { importSource: null } },
  nonObjectString: { metadata: 'text' },
  nonObjectArray: { metadata: [1, 2] },
  otherImport: { metadata: { importSource: 'other' } },
  dataPack: { metadata: { importSource: 'data-pack', importBatch: 'b1' } },
};
const ORDINARY = Object.keys(ROWS).filter((k) => k !== 'dataPack');

describe('rewardEligibleUploadWhere under SQL NULL semantics', () => {
  it('the previous filter dropped every upload without an importSource key (the bug)', () => {
    const previous = { NOT: { metadata: { path: ['importSource'], equals: 'data-pack' } } };
    assert.equal(kept(ROWS.emptyObject, previous), false);
    assert.equal(kept(ROWS.sourceUrlOnly, previous), false);
    assert.equal(kept(ROWS.otherImport, previous), true);
  });

  for (const name of ORDINARY) {
    it(`counts an ordinary upload: ${name}`, () => {
      assert.equal(kept(ROWS[name], rewardEligibleUploadWhere()), true);
    });
  }

  it('never counts a data-pack import', () => {
    assert.equal(kept(ROWS.dataPack, rewardEligibleUploadWhere()), false);
    assert.equal(kept({ ...ROWS.dataPack, userId: 'u1' }, rewardEligibleUploadWhere({ userId: 'u1' })), false);
  });

  it('keeps the caller conditions and does not mutate the input', () => {
    const input = { userId: 'u1', source: { in: ['airbnb'] } };
    const where = rewardEligibleUploadWhere(input);
    assert.deepEqual(input, { userId: 'u1', source: { in: ['airbnb'] } });
    assert.equal(where.userId, 'u1');
    assert.deepEqual(where.source, { in: ['airbnb'] });
    assert.equal(where.NOT, NOT_DATA_PACK_IMPORT.NOT);
    assert.equal(kept({ userId: 'u2', source: 'airbnb', metadata: {} }, where), false);
    assert.equal(kept({ userId: 'u1', source: 'booking', metadata: {} }, where), false);
    assert.equal(kept({ userId: 'u1', source: 'airbnb', metadata: {} }, where), true);
  });
});

function fakeDb(rows) {
  const calls = [];
  const filter = (where) => rows.filter((r) => kept(r, where));
  return {
    calls,
    crawlerData: {
      async count({ where }) {
        calls.push(['count', where]);
        return filter(where).length;
      },
      async groupBy({ by, where }) {
        calls.push(['groupBy', where]);
        const seen = new Map();
        for (const r of filter(where)) seen.set(r[by[0]], { [by[0]]: r[by[0]] });
        return [...seen.values()];
      },
    },
  };
}

describe('valid-upload helpers', () => {
  const rows = [
    { userId: 'app', metadata: {} },
    { userId: 'app2', metadata: { sourceUrl: 'x' } },
    { userId: 'pack', metadata: { importSource: 'data-pack' } },
    { userId: 'mixed', metadata: { importSource: 'data-pack' } },
    { userId: 'mixed', metadata: {} },
  ];

  it('hasCompletedFirstValidUpload: ordinary uploads count, data-pack only does not', async () => {
    const db = fakeDb(rows);
    assert.equal(await hasCompletedFirstValidUpload('app', db), true);
    assert.equal(await hasCompletedFirstValidUpload('app2', db), true);
    assert.equal(await hasCompletedFirstValidUpload('mixed', db), true);
    assert.equal(await hasCompletedFirstValidUpload('pack', db), false);
    assert.equal(await hasCompletedFirstValidUpload('nobody', db), false);
    for (const [, where] of db.calls) assert.equal(where.NOT, NOT_DATA_PACK_IMPORT.NOT);
  });

  it('getUsersWithValidUploads returns exactly the users with an ordinary upload', async () => {
    const db = fakeDb(rows);
    const got = await getUsersWithValidUploads(['app', 'app2', 'pack', 'mixed', 'nobody'], db);
    assert.deepEqual([...got].sort(), ['app', 'app2', 'mixed']);
    assert.deepEqual([...(await getUsersWithValidUploads([], db))], []);
    assert.equal(db.calls.length, 1); // an empty id list never queries
  });
});
