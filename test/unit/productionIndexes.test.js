/**
 * Production's database has five indexes on foreign-key columns that no migration used to create
 * (live schema-only dump, 2026-10-05). 20261005120100_production_fk_indexes creates them, and it
 * must stay idempotent: production already has them, so a plain CREATE INDEX would fail the
 * cutover's `prisma migrate deploy`. schema.prisma must declare the same indexes, or
 * `prisma migrate diff` would propose dropping them from production.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PRISMA_DIR = path.join(__dirname, '../../prisma');
const INDEXES = [
  ['CrawlerData', 'taskId'],
  ['CrawlerTask', 'userId'],
  ['Point', 'userId'],
  ['ProcurementAllocation', 'userId'],
  ['User', 'organizationId'],
];

describe('foreign-key indexes that production already has', () => {
  const dir = path.join(PRISMA_DIR, 'migrations');
  const sql = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'migration.sql')))
    .map((d) => fs.readFileSync(path.join(dir, d, 'migration.sql'), 'utf8')).join('\n');
  const schema = fs.readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8');

  for (const [model, column] of INDEXES) {
    const name = `${model}_${column}_idx`;

    it(`${name} is created only with IF NOT EXISTS (a no-op on production)`, () => {
      assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS "${name}" ON "${model}"\\("${column}"\\);`));
      assert.doesNotMatch(sql, new RegExp(`CREATE INDEX "${name}"`));
    });

    it(`schema.prisma declares @@index([${column}]) on ${model}`, () => {
      const body = schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm'));
      assert.ok(body, `model ${model} not found`);
      assert.match(body[1], new RegExp(`^\\s*@@index\\(\\[${column}\\]\\)\\s*$`, 'm'));
    });
  }
});
