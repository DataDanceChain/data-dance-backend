/**
 * Schema ↔ migrations drift.
 *
 * `prisma migrate deploy` builds a database from prisma/migrations ONLY; schema.prisma only shapes
 * the generated client. A column declared in the schema that no migration creates is therefore
 * absent from every freshly built database while the client still selects it — and then EVERY
 * query on that model fails ("The column User.legacyReferralCode does not exist"), which the
 * user-session middleware reports as a plain 401. That happened: `User.legacyReferralCode` was
 * added to the schema with no migration.
 *
 * This replays the migration SQL (CREATE TABLE / ADD / DROP / RENAME COLUMN, CREATE [UNIQUE] INDEX,
 * including the IF [NOT] EXISTS forms) into a table → column / index model and checks that every
 * scalar field of every model, and every single-field @unique, exists in it. No database needed.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PRISMA_DIR = path.join(__dirname, '../../prisma');

function readSchema() {
  const src = fs.readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8');
  const models = {};
  const enums = new Set([...src.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));
  for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) models[m[1]] = m[2];
  const modelNames = new Set(Object.keys(models));
  const out = {};
  for (const [model, body] of Object.entries(models)) {
    const fields = [];
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const [name, type, ...rest] = line.split(/\s+/);
      if (!name || !type) continue;
      const base = type.replace(/[?[\]]/g, '');
      if (modelNames.has(base)) continue; // relation field, no column
      if (/^Unsupported\(/.test(base)) continue;
      fields.push({ name, unique: rest.join(' ').split(/\s+/).includes('@unique'), isEnum: enums.has(base) });
    }
    out[model] = fields;
  }
  return out;
}

function replayMigrations() {
  const dir = path.join(PRISMA_DIR, 'migrations');
  const tables = {};
  const indexes = new Set();
  const table = (t) => (tables[t] = tables[t] || new Set());
  const dirs = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'migration.sql'))).sort();
  for (const d of dirs) {
    const sql = fs.readFileSync(path.join(dir, d, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "(\w+)" \(([\s\S]*?)\n\);/g)) {
      for (const c of m[2].matchAll(/^\s*"(\w+)"\s/gm)) table(m[1]).add(c[1]);
    }
    for (const m of sql.matchAll(/ALTER TABLE(?: IF EXISTS)? "(\w+)"([\s\S]*?);/g)) {
      const t = table(m[1]);
      for (const c of m[2].matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+"(\w+)"/g)) t.add(c[1]);
      for (const c of m[2].matchAll(/DROP COLUMN(?: IF EXISTS)?\s+"(\w+)"/g)) t.delete(c[1]);
      for (const c of m[2].matchAll(/RENAME COLUMN "(\w+)" TO "(\w+)"/g)) { t.delete(c[1]); t.add(c[2]); }
    }
    for (const m of sql.matchAll(/ALTER TABLE(?: IF EXISTS)? "(\w+)" RENAME TO "(\w+)"/g)) {
      tables[m[2]] = table(m[1]);
      delete tables[m[1]];
    }
    for (const m of sql.matchAll(/CREATE UNIQUE INDEX(?: IF NOT EXISTS)? "(\w+)"/g)) indexes.add(m[1]);
    for (const m of sql.matchAll(/DROP INDEX(?: IF EXISTS)? "(\w+)"/g)) indexes.delete(m[1]);
  }
  return { tables, indexes };
}

describe('prisma/schema.prisma is fully created by prisma/migrations', () => {
  const schema = readSchema();
  const { tables, indexes } = replayMigrations();

  it('every model has a table', () => {
    const missing = Object.keys(schema).filter((m) => !tables[m]);
    assert.deepEqual(missing, [], `models with no CREATE TABLE in any migration: ${missing.join(', ')}`);
  });

  it('every scalar field has a column', () => {
    const missing = [];
    for (const [model, fields] of Object.entries(schema)) {
      for (const f of fields) if (tables[model] && !tables[model].has(f.name)) missing.push(`${model}.${f.name}`);
    }
    assert.deepEqual(missing, [], `schema fields no migration creates (a fresh database will not have them): ${missing.join(', ')}`);
  });

  it('every single-field @unique has its unique index', () => {
    const missing = [];
    for (const [model, fields] of Object.entries(schema)) {
      for (const f of fields) if (f.unique && !indexes.has(`${model}_${f.name}_key`)) missing.push(`${model}_${f.name}_key`);
    }
    assert.deepEqual(missing, [], `@unique fields with no unique index in any migration: ${missing.join(', ')}`);
  });

  it('User.legacyReferralCode is created idempotently (safe where production already has it)', () => {
    const dir = path.join(PRISMA_DIR, 'migrations');
    const sql = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'migration.sql')))
      .map((d) => fs.readFileSync(path.join(dir, d, 'migration.sql'), 'utf8')).join('\n');
    assert.match(sql, /ALTER TABLE "User" ADD COLUMN IF NOT EXISTS\s+"legacyReferralCode"/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "User_legacyReferralCode_key" ON "User"\("legacyReferralCode"\)/);
  });
});
