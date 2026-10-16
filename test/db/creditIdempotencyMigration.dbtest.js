/**
 * 20261016210000_merchant_credit_idempotency on a live database (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway database whose name contains "test").
 *
 * The migration adds a column to "OrganizationTransaction" and builds a unique index over it,
 * which needs short locks on the table. While another session holds a lock on it, it must fail
 * fast (lock_timeout) and leave nothing, instead of queueing every later reader of the table
 * behind it; once the lock is gone it applies over existing rows (every key NULL), and a second
 * run (the same column and index added by another migration) changes nothing.
 *
 * It runs the migration file with `prisma db execute`, the same schema engine and one-script
 * transaction `prisma migrate deploy` uses, against a per-run scratch schema that has its own
 * minimal table; the scratch schema is dropped afterwards. The migrated tables of the test
 * database itself are not touched.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const prisma = require('../../src/utils/prisma');

const SCHEMA = `mig${crypto.randomBytes(3).toString('hex')}`;
const TABLE = `"${SCHEMA}"."OrganizationTransaction"`;
const MIGRATION = path.join(__dirname, '../../prisma/migrations/20261016210000_merchant_credit_idempotency/migration.sql');
const PRISMA_CLI = require.resolve('prisma/build/index.js');

function scratchUrl() {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
}

/** `prisma db execute --file <migration>` on the scratch schema: { code, output, ms }. */
function applyMigration({ killAfterMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', scratchUrl(), '--file', MIGRATION], {
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, ms: Date.now() - started });
    });
  });
}

async function columns() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'OrganizationTransaction' ORDER BY column_name`,
    SCHEMA,
  );
  return rows.map((row) => [row.column_name, row.is_nullable, row.column_default]);
}

async function indexes() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = $1 AND tablename = 'OrganizationTransaction' AND indexname <> 'OrganizationTransaction_pkey'
     ORDER BY indexname`,
    SCHEMA,
  );
  return rows.map((row) => [row.indexname, row.indexdef.replace(`"${SCHEMA}".`, '').replace(`${SCHEMA}.`, '')]);
}

const insert = (rowId, userId, key) => prisma.$executeRawUnsafe(
  `INSERT INTO ${TABLE} ("id", "userId"${key === undefined ? '' : ', "idempotencyKey"'}) VALUES ($1, $2${key === undefined ? '' : ', $3'})`,
  ...[rowId, userId, ...(key === undefined ? [] : [key])],
);

before(async () => {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
  await prisma.$executeRawUnsafe(`CREATE TABLE ${TABLE} ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL)`);
  // Existing ledger rows: several for one merchant, all of them without a key after the migration.
  await insert('existing-1', 'merchant-1');
  await insert('existing-2', 'merchant-1');
});

after(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$disconnect();
});

describe('the merchant credit idempotency migration and a busy table', () => {
  it('fails within its lock_timeout while a reader holds "OrganizationTransaction", and changes nothing', async () => {
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let locked;
    const holding = new Promise((resolve) => { locked = resolve; });
    // A long reader: an open transaction holding ACCESS SHARE on the table until released.
    const reader = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE ${TABLE} IN ACCESS SHARE MODE`);
      locked();
      await released;
    }, { maxWait: 10000, timeout: 60000 });
    try {
      await holding;
      // Without a lock_timeout the migration would wait for the reader; give up on it after 20 s.
      const result = await applyMigration({ killAfterMs: 20000 });
      assert.notEqual(result.code, 0, 'the migration did not apply while the table was locked');
      assert.notEqual(result.code, null, 'it failed by itself instead of waiting for the reader');
      assert.match(result.output, /55P03|lock timeout/i);
      assert.ok(result.ms < 15000, `failed fast (${result.ms} ms)`);
    } finally {
      release();
      await reader;
    }
    assert.deepEqual((await columns()).map(([name]) => name), ['id', 'userId'], 'one transaction: nothing applied');
    assert.deepEqual(await indexes(), []);
  });

  it('applies once the lock is gone: a nullable key column and one unique index over the merchant and the key', async () => {
    const result = await applyMigration();
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await columns(), [
      ['id', 'NO', null],
      ['idempotencyKey', 'YES', null],
      ['userId', 'NO', null],
    ]);
    assert.deepEqual(await indexes(), [[
      'OrganizationTransaction_userId_idempotencyKey_key',
      'CREATE UNIQUE INDEX "OrganizationTransaction_userId_idempotencyKey_key" ON "OrganizationTransaction" USING btree ("userId", "idempotencyKey")',
    ]]);
  });

  it('existing rows keep a NULL key and never conflict; one row per merchant and key', async () => {
    const keys = await prisma.$queryRawUnsafe(`SELECT "idempotencyKey" FROM ${TABLE} WHERE "id" LIKE 'existing-%'`);
    assert.deepEqual(keys.map((row) => row.idempotencyKey), [null, null]);
    await insert('plain-3', 'merchant-1', null);
    await insert('keyed-1', 'merchant-1', 'key-00000001');
    await assert.rejects(insert('keyed-2', 'merchant-1', 'key-00000001'), /unique|23505/i);
    await insert('keyed-3', 'merchant-2', 'key-00000001');
  });

  it('running it a second time (the same column and index added by another migration) changes nothing and succeeds', async () => {
    const result = await applyMigration();
    assert.equal(result.code, 0, result.output);
    assert.deepEqual((await columns()).map(([name]) => name), ['id', 'idempotencyKey', 'userId']);
    assert.equal((await indexes()).length, 1);
  });

  it('the file sets lock_timeout before its first statement and resets it at the end', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const statements = sql.split('\n').filter((line) => line.trim() && !line.trim().startsWith('--'));
    assert.match(statements[0], /^SET lock_timeout = '\d+s';$/);
    assert.equal(statements[statements.length - 1], 'RESET lock_timeout;');
    for (const statement of statements.filter((line) => /^(ALTER|CREATE)/.test(line))) {
      assert.match(statement, /IF NOT EXISTS/, statement);
    }
  });
});
