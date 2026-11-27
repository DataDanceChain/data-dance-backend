const { createHash } = require('node:crypto');

function sharedAuthStateEnabled() {
  return process.env.DDC_SHARED_AUTH_STATE === 'true';
}

// Serialize even the first use of an absent key. Lock collisions only affect
// scheduling: the full hash is used for every read and write.
async function withState(namespace, key, ttlMs, update) {
  const prisma = require('./prisma');
  const digest = createHash('sha256').update(JSON.stringify([namespace, key])).digest();
  const keyHash = digest.toString('hex');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Invalid state lifetime');
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${digest.readInt32BE(0)}::integer, ${digest.readInt32BE(4)}::integer)`;
    const [row] = await tx.$queryRaw`
      SELECT "state" FROM "DdcAuthWindow" WHERE "keyHash" = ${keyHash} AND "expiresAt" > clock_timestamp()`;
    const result = update(row ? row.state : null);
    if (!result || result.state === undefined) throw new Error('Invalid state transition');
    if (result.state === null) {
      await tx.$executeRaw`DELETE FROM "DdcAuthWindow" WHERE "keyHash" = ${keyHash}`;
    } else {
      await tx.$executeRaw`
        INSERT INTO "DdcAuthWindow" ("keyHash", "state", "expiresAt")
        VALUES (${keyHash}, ${JSON.stringify(result.state)}::jsonb, clock_timestamp() + ${ttlMs} * interval '1 millisecond')
        ON CONFLICT ("keyHash") DO UPDATE SET "state" = EXCLUDED."state", "expiresAt" = EXCLUDED."expiresAt"`;
    }
    return result.value;
  });
}

async function pruneExpired() {
  const prisma = require('./prisma');
  return prisma.$executeRaw`
    DELETE FROM "DdcAuthWindow" WHERE "keyHash" IN (
      SELECT "keyHash" FROM "DdcAuthWindow" WHERE "expiresAt" <= clock_timestamp()
      ORDER BY "expiresAt" LIMIT 2000 FOR UPDATE SKIP LOCKED
    )`;
}

module.exports = { sharedAuthStateEnabled, withState, pruneExpired };
