/**
 * One-time backfill: give the X / Instagram / Threads / TikTok rows stored before the per-user
 * permalink identity that identity (sourceId and contentHash), so the first sync after the release
 * finds each post as already stored instead of storing it, and paying for it, a second time.
 *
 * Run it right after the release that ships the new identity, before users sync again. Rows a user
 * syncs in between are stored under the new identity; the older row of the same post then keeps
 * its old identity and is listed as a conflict.
 *
 * Usage (where the API runs, so DATABASE_URL is the server's):
 *   node scripts/backfillSocialPostIdentity.js                # dry run (default): counts, writes nothing
 *   node scripts/backfillSocialPostIdentity.js --apply        # rewrites sourceId / contentHash
 *   node scripts/backfillSocialPostIdentity.js --user=<id>    # only this user's rows (repeatable)
 *   node scripts/backfillSocialPostIdentity.js --batch=500    # rows read per page
 *
 * It never deletes a row and never touches points. When one user already holds several rows of the
 * same post (a changed like count used to look like a new post), the oldest row takes the new
 * identity and the others keep theirs: they are listed by id under "conflicts" for ops to decide.
 * Safe to re-run: rows that already carry the new identity are counted as current and left alone.
 * Output holds row and user ids and counts only, never payloads.
 */
const prisma = require('../src/utils/prisma');
const { generateContentHash } = require('../src/services/crawlerService');
const {
  SOCIAL_PERMALINK_SOURCES,
  extractSourceId,
  socialPostUrl,
} = require('../src/utils/crawlerRecordIdentity');

// Stored source values to scan: the social sources with a permalink identity, plus the old alias.
const STORED_SOURCES = [...SOCIAL_PERMALINK_SOURCES, 'twitter'];
const DEFAULT_BATCH = 500;

function usageError(message) {
  const error = new Error(`${message}\nUsage: node scripts/backfillSocialPostIdentity.js [--apply] [--user=<id>] [--batch=<n>]`);
  error.usage = true;
  return error;
}

function parseArgs(argv) {
  const opts = { apply: false, userIds: [], batch: DEFAULT_BATCH };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg.startsWith('--user=')) {
      const value = arg.slice('--user='.length).trim();
      if (!value) throw usageError('--user needs an id');
      opts.userIds.push(value);
    } else if (arg.startsWith('--batch=')) {
      const value = Number.parseInt(arg.slice('--batch='.length), 10);
      if (!Number.isInteger(value) || value < 1 || value > 5000) throw usageError('--batch must be 1-5000');
      opts.batch = value;
    } else {
      throw usageError(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

const identityKey = (userId, source, sourceId) => `${userId}\u0000${source}\u0000${sourceId}`;

/**
 * Walks the social rows oldest first and gives each the new identity unless another row already
 * holds it (in the database, or claimed earlier in this run). Returns a report; writes only with
 * `apply: true`.
 */
async function backfillSocialPostIdentity({ client = prisma, apply = false, userIds = [], batch = DEFAULT_BATCH } = {}) {
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    current: 0,
    noPermalink: 0,
    updated: 0,
    conflicts: [],
  };
  // Identities taken during this run, so a dry run reports what --apply would do.
  const claimedHashes = new Set();
  const claimedKeys = new Set();
  const where = { source: { in: STORED_SOURCES } };
  if (userIds.length > 0) where.userId = { in: userIds };

  let cursor = null;
  for (;;) {
    const rows = await client.crawlerData.findMany({
      where,
      select: { id: true, userId: true, source: true, sourceId: true, contentHash: true, payload: true, metadata: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: batch,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    report.scanned += rows.length;

    const planned = [];
    for (const row of rows) {
      if (!socialPostUrl(row.source, row.payload)) {
        report.noPermalink += 1;
        continue;
      }
      const sourceId = extractSourceId(row.source, row.payload, row.metadata);
      const contentHash = generateContentHash(row.payload, { source: row.source, userId: row.userId });
      if (row.sourceId === sourceId && row.contentHash === contentHash) {
        report.current += 1;
        claimedHashes.add(contentHash);
        claimedKeys.add(identityKey(row.userId, row.source, sourceId));
        continue;
      }
      planned.push({ row, sourceId, contentHash });
    }
    if (planned.length === 0) continue;

    // Rows elsewhere in the table that already hold one of the target identities.
    const holders = await client.crawlerData.findMany({
      where: {
        OR: [
          { contentHash: { in: planned.map((p) => p.contentHash) } },
          ...planned.map((p) => ({ userId: p.row.userId, source: p.row.source, sourceId: p.sourceId })),
        ],
      },
      select: { id: true, userId: true, source: true, sourceId: true, contentHash: true },
    });

    for (const { row, sourceId, contentHash } of planned) {
      const key = identityKey(row.userId, row.source, sourceId);
      const holder = holders.find(
        (other) =>
          other.id !== row.id &&
          (other.contentHash === contentHash || identityKey(other.userId, other.source, other.sourceId) === key),
      );
      if (holder || claimedHashes.has(contentHash) || claimedKeys.has(key)) {
        report.conflicts.push({ id: row.id, userId: row.userId, keptBy: holder ? holder.id : 'earlier row in this run' });
        continue;
      }
      if (apply) {
        try {
          await client.crawlerData.update({ where: { id: row.id }, data: { sourceId, contentHash } });
        } catch (error) {
          // A sync stored the same post between the read above and this write.
          if (error && error.code === 'P2002') {
            report.conflicts.push({ id: row.id, userId: row.userId, keptBy: 'row stored during the run' });
            continue;
          }
          throw error;
        }
      }
      claimedHashes.add(contentHash);
      claimedKeys.add(key);
      report.updated += 1;
    }
  }
  return report;
}

function printReport(report) {
  const verb = report.mode === 'apply' ? 'updated' : 'would update';
  console.log(`mode ${report.mode}: scanned ${report.scanned} social rows`);
  console.log(`  ${verb}: ${report.updated}`);
  console.log(`  already current: ${report.current}`);
  console.log(`  no permalink (unchanged): ${report.noPermalink}`);
  console.log(`  conflicts (left unchanged, nothing deleted): ${report.conflicts.length}`);
  for (const conflict of report.conflicts) {
    console.log(`    row ${conflict.id} user ${conflict.userId}: identity kept by ${conflict.keptBy}`);
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  try {
    printReport(await backfillSocialPostIdentity(opts));
    if (!opts.apply) console.log('Dry run: nothing was written. Re-run with --apply to write.');
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(error && error.usage ? 2 : 1);
  });
}

module.exports = { parseArgs, backfillSocialPostIdentity, printReport, STORED_SOURCES };
