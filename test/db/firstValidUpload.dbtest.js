/**
 * The reward-eligible upload filter on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing
 * at a throwaway database that `prisma migrate deploy` has built — its name must contain "test").
 *
 * What only the database can prove: a CrawlerData row whose metadata has no `importSource` key (every
 * ordinary App upload) is counted, and a data-pack import never is. `CrawlerData.metadata` is NOT NULL,
 * so "null metadata" here is the JSON value null. One user per metadata shape; fixture rows use a
 * per-run id prefix and are deleted afterwards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const prisma = require('../../src/utils/prisma');
const {
  rewardEligibleUploadWhere,
  hasCompletedFirstValidUpload,
  getUsersWithValidUploads,
} = require('../../src/utils/firstValidUpload');

const RUN = `vu${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;

// name -> metadata JSON literal
const SHAPES = {
  empty: '{}',
  sourceUrl: '{"sourceUrl":"https://example.test/order/1"}',
  jsonNull: 'null',
  importSourceNull: '{"importSource":null}',
  nonObject: '"text"',
  other: '{"importSource":"other"}',
  dataPack: '{"importSource":"data-pack","importBatch":"b1"}',
};
const ORDINARY = Object.keys(SHAPES).filter((k) => k !== 'dataPack');

async function user(name) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "User"(id, email, "referralCode", "updatedAt") VALUES ($1, $2, $3, now())',
    id(name), `${id(name)}@example.test`, id(name).toUpperCase(),
  );
  await prisma.$executeRawUnsafe(
    'INSERT INTO "CrawlerTask"(id, title, source, "userId", "updatedAt") VALUES ($1, $2, $3, $4, now())',
    id(`task-${name}`), 'dbtest', 'amazon', id(name),
  );
}
async function upload(owner, rowName, metadataJson) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CrawlerData"(id, source, type, timestamp, metadata, payload, "taskId", "userId", "contentHash", "updatedAt")
     VALUES ($1, 'amazon', 'order', now(), $2::jsonb, '{}'::jsonb, $3, $4, $1, now())`,
    id(`cd-${rowName}`), metadataJson, id(`task-${owner}`), id(owner),
  );
}

describe('reward-eligible uploads on Postgres', () => {
  before(async () => {
    for (const [name, json] of Object.entries(SHAPES)) {
      await user(name);
      await upload(name, name, json);
    }
    // A user with both a data-pack import and one ordinary upload counts once.
    await user('mixed');
    await upload('mixed', 'mixed-pack', SHAPES.dataPack);
    await upload('mixed', 'mixed-app', SHAPES.empty);
  });

  after(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "CrawlerData" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "CrawlerTask" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
  });

  for (const name of ORDINARY) {
    it(`an ordinary upload counts: metadata ${SHAPES[name]}`, async () => {
      assert.equal(await hasCompletedFirstValidUpload(id(name)), true);
    });
  }

  it('a data-pack import never counts', async () => {
    assert.equal(await hasCompletedFirstValidUpload(id('dataPack')), false);
  });

  it('getUsersWithValidUploads returns every user except the data-pack-only one', async () => {
    const all = [...Object.keys(SHAPES), 'mixed'];
    const got = await getUsersWithValidUploads(all.map(id));
    const expected = [...ORDINARY, 'mixed'].map(id).sort();
    assert.deepEqual([...got].sort(), expected);
  });

  it('row-level count and findMany exclude exactly the data-pack rows', async () => {
    const where = rewardEligibleUploadWhere({ id: { startsWith: `${RUN}-` } });
    const rows = await prisma.crawlerData.findMany({ where, select: { id: true } });
    const names = rows.map((r) => r.id.slice(RUN.length + 4)).sort();
    assert.deepEqual(names, [...ORDINARY, 'mixed-app'].sort());
    assert.equal(await prisma.crawlerData.count({ where }), ORDINARY.length + 1);
  });

  it('caller conditions still combine with the filter (source, createdAt window)', async () => {
    const where = rewardEligibleUploadWhere({ userId: id('mixed'), source: { in: ['amazon'] } });
    where.createdAt = { gte: new Date(Date.now() - 3_600_000) };
    assert.equal(await prisma.crawlerData.count({ where }), 1);
  });
});
