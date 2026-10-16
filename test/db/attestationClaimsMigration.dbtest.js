/**
 * 20261016200000_attestation_claims on a live database (`npm run test:db`; needs TEST_DATABASE_URL
 * pointing at a throwaway database whose name contains "test").
 *
 * The migration adds a column to "PurchaseOrder" and to "DisbursementItem", which needs a short
 * lock on each table. While another session holds a lock on one of them, it must fail fast
 * (lock_timeout) and leave nothing, instead of queueing every later reader of the table behind it;
 * once the lock is gone it applies, and a second run (the same columns added by another
 * migration) changes nothing.
 *
 * It runs the migration file with `prisma db execute`, the same schema engine and one-script
 * transaction `prisma migrate deploy` uses, against a per-run scratch schema that has its own
 * minimal tables; the scratch schema is dropped afterwards. The migrated tables of the test
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
const MIGRATION = path.join(__dirname, '../../prisma/migrations/20261016200000_attestation_claims/migration.sql');
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

async function scratchColumns(table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
    SCHEMA,
    table,
  );
  return rows.map((row) => row.column_name);
}

before(async () => {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"."PurchaseOrder" ("id" TEXT PRIMARY KEY)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"."DisbursementItem" ("id" TEXT PRIMARY KEY)`);
});

after(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$disconnect();
});

describe('the attestation claims migration and a busy table', () => {
  for (const table of ['PurchaseOrder', 'DisbursementItem']) {
    it(`fails within its lock_timeout while a reader holds "${table}", and changes nothing`, async () => {
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      let locked;
      const holding = new Promise((resolve) => { locked = resolve; });
      // A long reader: an open transaction holding ACCESS SHARE on the table until released.
      const reader = prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`LOCK TABLE "${SCHEMA}"."${table}" IN ACCESS SHARE MODE`);
        locked();
        await released;
      }, { maxWait: 10000, timeout: 60000 });
      try {
        await holding;
        // Without a lock_timeout the migration would wait for the reader; give up on it after 20 s.
        const result = await applyMigration({ killAfterMs: 20000 });
        assert.notEqual(result.code, 0, `the migration did not apply while "${table}" was locked`);
        assert.notEqual(result.code, null, 'it failed by itself instead of waiting for the reader');
        assert.match(result.output, /55P03|lock timeout/i);
        assert.ok(result.ms < 15000, `failed fast (${result.ms} ms)`);
      } finally {
        release();
        await reader;
      }
      assert.deepEqual(await scratchColumns('PurchaseOrder'), ['id'], 'one transaction: nothing applied');
      assert.deepEqual(await scratchColumns('DisbursementItem'), ['id'], 'one transaction: nothing applied');
    });
  }

  it('applies once the lock is gone: one nullable claim column on each table', async () => {
    const result = await applyMigration();
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await scratchColumns('PurchaseOrder'), ['attestationClaimedAt', 'id']);
    assert.deepEqual(await scratchColumns('DisbursementItem'), ['id', 'reconcileClaimedAt']);
    const nullable = await prisma.$queryRawUnsafe(
      `SELECT table_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 AND column_name IN ('attestationClaimedAt', 'reconcileClaimedAt') ORDER BY table_name`,
      SCHEMA,
    );
    assert.deepEqual(nullable.map((row) => [row.table_name, row.is_nullable, row.column_default]), [
      ['DisbursementItem', 'YES', null],
      ['PurchaseOrder', 'YES', null],
    ]);
  });

  it('running it a second time (the same columns added by another migration) changes nothing and succeeds', async () => {
    const result = await applyMigration();
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await scratchColumns('PurchaseOrder'), ['attestationClaimedAt', 'id']);
    assert.deepEqual(await scratchColumns('DisbursementItem'), ['id', 'reconcileClaimedAt']);
  });

  it('the file sets lock_timeout before its first statement and resets it at the end', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const statements = sql.split('\n').filter((line) => line.trim() && !line.trim().startsWith('--'));
    assert.match(statements[0], /^SET lock_timeout = '\d+s';$/);
    assert.equal(statements[statements.length - 1], 'RESET lock_timeout;');
  });
});
