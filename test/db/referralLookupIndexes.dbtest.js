const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Prisma } = require('@prisma/client');

const url = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost/missing');
if (!/test/i.test(url.pathname)) throw new Error('An isolated TEST_DATABASE_URL is required');
const schema = 'refidx_' + randomUUID().replace(/-/g, '');
url.searchParams.set('schema', schema);
process.env.DATABASE_URL = url.toString();
const db = require('../../src/utils/prisma');
const { findUserByReferralCode, referralCodeLookupValues } = require('../../src/utils/referralUtils');

const migrations = [
  ['20261203120000_referral_lookup_lower', 'User_referralCode_lower_lookup_idx'],
  ['20261203120100_legacy_referral_lookup_lower', 'User_legacyReferralCode_lower_lookup_idx'],
];
const cases = [
  ['DDC-AB23CD', ['current']],
  ['dd-98765432', ['legacy']],
  ['DD98765432', ['legacy']],
  ['yz89wx', []],
  ['dd-01234567', ['hyphenated', 'plain']],
  ['DD01234567', ['hyphenated', 'plain']],
  ['ddc-rt23np', ['display', 'prefixed']],
];

function predicate(input) {
  const values = Prisma.join([...new Set(referralCodeLookupValues(input).map(value => value.toLowerCase()))]);
  return Prisma.sql`LOWER("referralCode") IN (${values})
      OR LOWER(COALESCE("legacyReferralCode", '')) IN (${values})`;
}

async function verifyRows() {
  for (const blank of [null, '', '  ', '-', ' - -- ']) {
    assert.deepEqual(referralCodeLookupValues(blank), []);
    assert.equal(await findUserByReferralCode(blank, { id: true }), null);
  }
  for (const [input, expected] of cases) {
    const rows = await db.$queryRaw`SELECT id FROM "User" WHERE ${predicate(input)} ORDER BY id`;
    assert.deepEqual(rows.map(row => row.id), expected, input);
    const selected = await findUserByReferralCode(input, { id: true });
    if (expected.length) assert.ok(expected.includes(selected?.id), input);
    else assert.equal(selected, null);
  }
}

async function plan(input) {
  const rows = await db.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id, email, name, "referralCode" FROM "User" WHERE ${predicate(input)} LIMIT 1`;
  return rows[0]['QUERY PLAN'][0];
}

test('concurrent referral indexes preserve both spelling sets and serve the lookup', async (t) => {
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    try { await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await db.$disconnect(); }
  });
  await db.$executeRawUnsafe(`CREATE TABLE "User" (
    id text PRIMARY KEY, email text, name text, "referralCode" text UNIQUE, "legacyReferralCode" text UNIQUE)`);
  await db.$executeRawUnsafe(`INSERT INTO "User" (id, "referralCode")
    SELECT i::text, 'fixture-' || i FROM generate_series(1, 150000) AS i`);
  await db.$executeRawUnsafe(`INSERT INTO "User" (id, "referralCode", "legacyReferralCode") VALUES
    ('current','aB23Cd',NULL), ('legacy',NULL,'Dd98765432'),
    ('hyphenated',NULL,'DD-01234567'), ('plain','dd01234567',NULL),
    ('prefixed',NULL,'DDC-RT23NP'), ('display','Rt23Np',NULL)`);
  await db.$executeRawUnsafe('ANALYZE "User"');
  await verifyRows();
  async function measure(phase) {
    for (const [input] of [cases[0], cases[1], cases[3]]) {
      await plan(input);
      const samples = [];
      for (let i = 0; i < 7; i++) {
        const measured = await plan(input);
        const nodes = JSON.stringify(measured.Plan);
        if (phase === 'before') assert.match(nodes, /Seq Scan/);
        else for (const [, name] of migrations) assert.ok(nodes.includes(name), input);
        samples.push(measured['Execution Time']);
      }
      t.diagnostic(JSON.stringify({ phase, input, executorMs: samples }));
    }
  }
  await measure('before');
  for (const [directory] of migrations) {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'execute',
      '--url', url.toString(), '--file', path.join(__dirname, '../../prisma/migrations', directory, 'migration.sql')],
    { env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' }, timeout: 60000 });
  }
  await db.$executeRawUnsafe('ANALYZE "User"');
  const indexes = await db.$queryRaw`SELECT c.relname AS name, i.indisvalid AS valid,
    i.indisready AS ready, i.indisunique AS unique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = '"User"'::regclass AND c.relname IN (${Prisma.join(migrations.map(m => m[1]))})`;
  assert.equal(indexes.length, 2);
  for (const index of indexes) assert.ok(index.valid && index.ready && !index.unique);
  await verifyRows();
  await measure('after');
});
