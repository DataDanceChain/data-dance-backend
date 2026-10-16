/**
 * One-time backfill of record identity, in two parts.
 *
 * 1. Social posts: give the X / Instagram / Threads / TikTok / Facebook rows stored before the
 *    per-user permalink identity that identity (sourceId and contentHash), so the first sync after
 *    the release finds each post as already stored instead of storing it, and paying for it, a
 *    second time. When one user already holds several rows of the same post (a changed like count
 *    or caption used to look like a new post), the oldest row takes the new identity and the others
 *    keep theirs: they are listed by id under "conflicts" for ops to decide. Facebook rows that hold
 *    no post link (stored from App versions before 2.0.6, which sent the profile page) keep their
 *    title key; the upload looks them up by it (legacyPostTitleSourceId in crawlerRecordIdentity.js).
 *
 * 2. Other records: the previous release stored some rows of other sources (orders, trips, events)
 *    under a post link key (`title:<host>:<link>`) when the row held a social link. Each such
 *    record gets back the identity the current code gives it (its order id, else its title key,
 *    else its content hash), so an upload of the same record finds it as already stored. When
 *    several rows are copies of one record (the same order id in that source; the same title key
 *    or content for that user), the earliest copy (createdAt, then id) keeps or gets the identity
 *    and every later copy is marked superseded: sourceId `title:superseded:<row id>` and a content
 *    hash derived from the row id. No upload produces either, so a superseded row never collides
 *    and is never matched as the record. Points stay as they are: the superseded rows are listed
 *    per user with the points their upload batches paid for them, for a separate decision.
 *
 * Run it right after the release that ships the new identity, before users sync again. Rows a user
 * syncs in between are stored under the new identity; the older row of the same post then keeps
 * its old identity and is listed as a conflict. With --apply, part 2 reads and writes in one
 * transaction that holds a write lock on CrawlerData (seconds on a few million rows); an upload in
 * that time waits until it commits, then either finds the repaired identity or fails with a
 * retryable conflict. Part 2 plans again inside that transaction after its writes, while a record
 * that waited for another record's link key has become ready, so one --apply settles.
 *
 * Usage (where the API runs, so DATABASE_URL is the server's):
 *   node scripts/backfillSocialPostIdentity.js                # dry run (default): counts, writes nothing
 *   node scripts/backfillSocialPostIdentity.js --apply        # rewrites sourceId / contentHash
 *   node scripts/backfillSocialPostIdentity.js --user=<id>    # only this user's rows (repeatable). Part 2
 *                                                             # selects only the records in which this user
 *                                                             # has a row under a link key, and repairs each
 *                                                             # as a whole (every user's copies); a record
 *                                                             # where only another user's copy is under a
 *                                                             # link key is left to a run without --user
 *   node scripts/backfillSocialPostIdentity.js --batch=500    # rows read per page and per statement; part 2
 *                                                             # writes all its batches in one transaction
 *
 * It never deletes a row and never touches points. Safe to re-run: rows that already carry their
 * identity are left alone, and a second --apply writes nothing. Output holds row and user ids,
 * sources, counts and points only, never payloads, titles, links or order ids.
 */
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../src/utils/prisma');
const businessRules = require('../config/business-rules.json');
const { generateContentHash } = require('../src/services/crawlerService');
const { POINT_SOURCE_CONNECT_BOOST } = require('../src/utils/campaignRules');
const { POINT_SOURCE_SUMMER_TRAVEL_BONUS } = require('../src/constants/referralCampaigns');
const { normalizeCrawlerSource } = require('../src/constants/crawlerSources');
const {
  TITLE_BACKED_PREFIX,
  SOCIAL_PERMALINK_SOURCES,
  asRecord,
  extractSourceId,
  hostFromMetadata,
  isTitleBackedSourceId,
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

/** A unique index refused the write (P2010 is how a raw statement reports it). */
const isUniqueViolation = (error) =>
  Boolean(error && (error.code === 'P2002' || (error.code === 'P2010' && error.meta && error.meta.code === '23505')));

/**
 * Rewrites sourceId / contentHash of these rows in one statement, each only if it still holds the
 * identity read (compare and set). Returns the ids written.
 */
async function updateRows(db, writes) {
  if (writes.length === 0) return new Set();
  const rows = JSON.stringify(
    writes.map((w) => ({ id: w.id, from_sid: w.from.sourceId, from_hash: w.from.contentHash, to_sid: w.to.sourceId, to_hash: w.to.contentHash })),
  );
  const done = await db.$queryRaw`
    UPDATE "CrawlerData" AS c
    SET "sourceId" = w.to_sid, "contentHash" = w.to_hash, "updatedAt" = (now() AT TIME ZONE 'UTC')
    FROM jsonb_to_recordset(${rows}::jsonb) AS w(id text, from_sid text, from_hash text, to_sid text, to_hash text)
    WHERE c.id = w.id AND c."sourceId" IS NOT DISTINCT FROM w.from_sid AND c."contentHash" = w.from_hash
    RETURNING c.id`;
  return new Set(done.map((row) => row.id));
}

/**
 * One page of social rows, in (userId, createdAt, id) order after the given row: keyset paging on
 * the (userId, createdAt) index, so each page reads only its own rows.
 */
async function socialRowsPage(client, { userIds, batch, after }) {
  const users = userIds.length > 0 ? Prisma.sql`AND "userId" IN (${Prisma.join(userIds)})` : Prisma.empty;
  const from = after
    ? Prisma.sql`AND ("userId", "createdAt", id) > (${after.userId}, ${after.createdKey}::timestamp, ${after.id})`
    : Prisma.empty;
  return client.$queryRaw`
    SELECT id, "userId", source, "sourceId", "contentHash", payload, metadata,
      to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdKey"
    FROM "CrawlerData"
    WHERE source IN (${Prisma.join(STORED_SOURCES)}) ${users} ${from}
    ORDER BY "userId", "createdAt", id
    LIMIT ${batch}`;
}

/**
 * Walks each user's social rows oldest first and gives each the new identity unless another row
 * already holds it (in the database, or claimed earlier in this run). A social identity and its
 * content hash are per user, so the order across users does not matter, and the identities claimed
 * are kept for the current user only. Returns a report; writes only with `apply: true`.
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
  // Identities the current user's rows took during this run, so a dry run reports what --apply
  // would do. Rows come in (userId, createdAt, id) order, so both sets start empty for each user.
  const claimedHashes = new Set();
  const claimedKeys = new Set();
  let claimsOf = null;

  let after = null;
  for (;;) {
    const rows = await socialRowsPage(client, { userIds, batch, after });
    if (rows.length === 0) break;
    after = rows[rows.length - 1];
    report.scanned += rows.length;

    const items = [];
    for (const row of rows) {
      if (!socialPostUrl(row.source, row.payload)) {
        report.noPermalink += 1;
        continue;
      }
      const sourceId = extractSourceId(row.source, row.payload, row.metadata);
      const contentHash = generateContentHash(row.payload, { source: row.source, userId: row.userId });
      const current = row.sourceId === sourceId && row.contentHash === contentHash;
      if (current) report.current += 1;
      items.push({ row, sourceId, contentHash, current });
    }
    const planned = items.filter((item) => !item.current);

    // Rows elsewhere in the table that already hold one of the target identities (a current row
    // of this page among them).
    const holders =
      planned.length === 0
        ? []
        : await client.crawlerData.findMany({
            where: {
              OR: [
                { contentHash: { in: planned.map((p) => p.contentHash) } },
                ...planned.map((p) => ({ userId: p.row.userId, source: p.row.source, sourceId: p.sourceId })),
              ],
            },
            select: { id: true, userId: true, source: true, sourceId: true, contentHash: true },
          });

    const writes = [];
    for (const { row, sourceId, contentHash, current } of items) {
      if (row.userId !== claimsOf) {
        claimedHashes.clear();
        claimedKeys.clear();
        claimsOf = row.userId;
      }
      const key = identityKey(row.userId, row.source, sourceId);
      if (current) {
        claimedHashes.add(contentHash);
        claimedKeys.add(key);
        continue;
      }
      const holder = holders.find(
        (other) =>
          other.id !== row.id &&
          (other.contentHash === contentHash || identityKey(other.userId, other.source, other.sourceId) === key),
      );
      if (holder || claimedHashes.has(contentHash) || claimedKeys.has(key)) {
        report.conflicts.push({ id: row.id, userId: row.userId, keptBy: holder ? holder.id : 'earlier row in this run' });
        continue;
      }
      claimedHashes.add(contentHash);
      claimedKeys.add(key);
      writes.push({ id: row.id, from: { sourceId: row.sourceId, contentHash: row.contentHash }, to: { sourceId, contentHash }, row });
    }
    if (!apply) {
      report.updated += writes.length;
      continue;
    }
    // The page in one statement; if a sync stored one of these posts since the read above (a unique
    // index refuses the statement), row by row instead.
    let written;
    try {
      written = await updateRows(client, writes);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      written = new Set();
      for (const write of writes) {
        try {
          if ((await updateRows(client, [write])).size === 1) written.add(write.id);
        } catch (single) {
          if (!isUniqueViolation(single)) throw single;
        }
      }
    }
    for (const write of writes) {
      if (written.has(write.id)) report.updated += 1;
      else report.conflicts.push({ id: write.id, userId: write.row.userId, keptBy: 'row stored or changed during the run' });
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

// ---------------------------------------------------------------------------------------------
// Part 2: records of other sources stored under a post link key.

/*
 * The post link key of the previous release: `title:<host>:<link>` for a row whose href / id /
 * orderId / orderid held a link matching this pattern, whatever its source. Kept only to recognise
 * the rows stored that way; the current code never stores it.
 */
const LEGACY_POST_LINK =
  /(?:instagram\.com\/(?:p|reel|reels|tv)\/[^/?#]+|(?:x|twitter)\.com\/[^/]+\/status\/\d+|threads\.(?:net|com)\/@?[^/]+\/post\/[^/?#]+|tiktok\.com\/@[^/]+\/video\/\d+)/i;
// The same pattern for Postgres (case-insensitive match), to read only rows that may hold the key.
const LEGACY_POST_LINK_SQL =
  'instagram\\.com/(p|reel|reels|tv)/[^/?#]+|(x|twitter)\\.com/[^/]+/status/[0-9]+|threads\\.(net|com)/@?[^/]+/post/[^/?#]+|tiktok\\.com/@[^/]+/video/[0-9]+';

/** The link part of the previous release's key, or '' when the payload held no such link. */
function legacyPostLink(payload) {
  const row = asRecord(payload);
  for (const value of [row.href, row.id, row.orderId, row.orderid]) {
    const text = String(value || '').trim();
    if (!text || !LEGACY_POST_LINK.test(text)) continue;
    try {
      const url = new URL(text);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      const parts = url.pathname.split('/').filter(Boolean);
      const media = parts.findIndex((part) => part === 'p' || part === 'reel' || part === 'reels' || part === 'tv');
      if (host.endsWith('instagram.com') && media >= 0 && parts[media + 1]) {
        return `https://${host}/${parts[media]}/${parts[media + 1]}`;
      }
      const status = parts.indexOf('status');
      if ((host === 'x.com' || host === 'twitter.com') && status > 0 && parts[status + 1]) {
        return `https://${host}/${parts[status - 1]}/status/${parts[status + 1]}`;
      }
      return `https://${host}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return text.split('?')[0].split('#')[0];
    }
  }
  return '';
}

/** The key the previous release stored for this row, or '' when it stored none. */
function legacyLinkKey(row) {
  const link = legacyPostLink(row && row.payload);
  if (!link) return '';
  const host = hostFromMetadata(row.metadata) || row.source;
  return `${TITLE_BACKED_PREFIX}${host}:${link}`.slice(0, 190);
}

/** True for a row stored under that key whose current identity is not a social post (part 1 owns those). */
function isRecordLinkKeyRow(row) {
  if (!row || !isTitleBackedSourceId(row.sourceId)) return false;
  if (socialPostUrl(row.source, row.payload)) return false;
  return legacyLinkKey(row) === row.sourceId;
}

/**
 * The identity the current code gives this row, and the scope in which it is one record: an order
 * id, per source across all users; a title key, per user; a row with neither, by its content hash
 * for that user and source.
 */
function recordIdentity(row) {
  const sourceId = extractSourceId(row.source, row.payload, row.metadata) || null;
  const contentHash = generateContentHash(row.payload, { source: row.source, userId: row.userId });
  if (!sourceId) {
    return { kind: 'content', sourceId: null, contentHash, scope: `h\u0000${identityKey(row.userId, row.source, contentHash)}` };
  }
  if (isTitleBackedSourceId(sourceId)) {
    return { kind: 'title', sourceId, contentHash, scope: `t\u0000${identityKey(row.userId, row.source, sourceId)}` };
  }
  return { kind: 'order', sourceId, contentHash, scope: `o\u0000${row.source}\u0000${sourceId}` };
}

/** The record scope a stored row's current identity holds (matched against the records being planned). */
function storedScope(row) {
  if (!row.sourceId) return `h\u0000${identityKey(row.userId, row.source, row.contentHash)}`;
  if (isTitleBackedSourceId(row.sourceId)) return `t\u0000${identityKey(row.userId, row.source, row.sourceId)}`;
  return `o\u0000${row.source}\u0000${row.sourceId}`;
}

function scopeWhere(record) {
  if (record.kind === 'order') return { source: record.source, sourceId: record.sourceId };
  if (record.kind === 'title') return { userId: record.userId, source: record.source, sourceId: record.sourceId };
  return { userId: record.userId, source: record.source, sourceId: null, contentHash: record.contentHash };
}

const SUPERSEDED_PREFIX = `${TITLE_BACKED_PREFIX}superseded:`;

/** The identity of a superseded copy: unique per row, and never produced by an upload. */
function supersededIdentity(rowId) {
  return {
    sourceId: `${SUPERSEDED_PREFIX}${rowId}`,
    contentHash: crypto.createHash('sha256').update(`superseded:${rowId}`).digest('hex'),
  };
}

const byAge = (a, b) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * One record: its link-key rows plus the stored rows that already hold its identity. The earliest
 * copy is the holder (restored if it is a link-key row); every later copy is superseded.
 */
function planRecord(record, storedHolders) {
  const members = [
    ...record.rows.map((row) => ({ row, linkKey: true })),
    ...storedHolders.map((row) => ({ row, linkKey: false })),
  ].sort((a, b) => byAge(a.row, b.row));
  const [first, ...later] = members;
  return {
    record,
    holder: first.row,
    restore: first.linkKey ? first.row : null,
    supersede: later,
    storedIds: storedHolders.map((row) => row.id).sort(),
  };
}

const ROW_SELECT = { id: true, userId: true, source: true, sourceId: true, contentHash: true, createdAt: true };

const PAYLOAD_LINK_FIELDS = ['href', 'id', 'orderId', 'orderid'];

/*
 * Links that socialPostUrl() always reads as a post permalink of that platform (a strict subset of
 * what it accepts: plain host, fixed path shape, no dot segments). The query below skips a social
 * row only when one of its link fields has this shape; every other row is decided in code.
 */
const TAIL_SQL = '(/[a-z0-9_-]*)*([?#].*)?$';
const HOST_SQL = (hosts) => `^https?://((www|m|mobile)\\.)?${hosts}`;
const CERTAIN_PERMALINK_SQL = {
  x: `${HOST_SQL('(x|twitter)\\.com')}/[a-z0-9_]{1,50}/status(es)?/[0-9]{1,25}${TAIL_SQL}`,
  instagram: `${HOST_SQL('instagram\\.com')}/(p|reel|reels|tv)/[a-z0-9_-]{4,64}${TAIL_SQL}`,
  threads: `${HOST_SQL('threads\\.(net|com)')}/@?[a-z0-9_][a-z0-9_.]{0,63}/post/[a-z0-9_-]{4,64}${TAIL_SQL}`,
  tiktok: `${HOST_SQL('tiktok\\.com')}/@[a-z0-9_.]{1,64}/(video|photo)/[0-9]{1,25}${TAIL_SQL}`,
  facebook: `${HOST_SQL('facebook\\.com')}/[a-z0-9_][a-z0-9_.-]{0,99}/posts/[a-z0-9_-]{4,200}${TAIL_SQL}`,
};

/** SQL: this social row holds a link that socialPostUrl() reads as a permalink. Never NULL. */
function certainPermalinkSql() {
  return Prisma.join(
    STORED_SOURCES.map((source) => {
      const pattern = CERTAIN_PERMALINK_SQL[normalizeCrawlerSource(source)];
      const fields = PAYLOAD_LINK_FIELDS.map(
        (field) => Prisma.sql`coalesce(octet_length(payload->>${field}) <= 2048 AND payload->>${field} ~* ${pattern}, false)`,
      );
      return Prisma.sql`(source = ${source} AND (${Prisma.join(fields, ' OR ')}))`;
    }),
    ' OR ',
  );
}

/**
 * Ids of the rows that may hold the previous release's key, in one pass over the table: the key
 * itself or a payload link field looks like a post link. Skipped here: rows this script marked
 * superseded (exact match for superseded rows), and social rows that hold a post permalink (part
 * 1's). isRecordLinkKeyRow() makes the final decision on each row read.
 */
async function linkKeyCandidateIds(client) {
  const link = LEGACY_POST_LINK_SQL;
  const rows = await client.$queryRaw`
    SELECT id FROM "CrawlerData"
    WHERE "sourceId" LIKE 'title:%'
      AND "sourceId" <> ('title:superseded:' || id)
      AND ("sourceId" ~* ${link} OR payload->>'href' ~* ${link} OR payload->>'id' ~* ${link}
        OR payload->>'orderId' ~* ${link} OR payload->>'orderid' ~* ${link})
      AND NOT (${certainPermalinkSql()})
    ORDER BY id`;
  return rows.map((row) => row.id);
}

/**
 * Stored rows holding one of these order ids. No index leads with source, so this is one pass over
 * the table for all records together (a hash join), never one per batch.
 */
async function orderIdHolders(client, records) {
  if (records.length === 0) return [];
  const keys = JSON.stringify(records.map((record) => ({ source: record.source, sourceId: record.sourceId })));
  return client.$queryRaw`
    SELECT c.id, c."userId", c.source, c."sourceId", c."contentHash", c."createdAt"
    FROM "CrawlerData" c
    JOIN (SELECT DISTINCT k.source, k."sourceId" FROM jsonb_to_recordset(${keys}::jsonb) AS k(source text, "sourceId" text)) k
      ON c.source = k.source AND c."sourceId" = k."sourceId"`;
}

/**
 * Writes planned rows in one statement (compare and set). The caller holds the table lock, so a row
 * that no longer holds what was read means something is wrong: it throws and the whole transaction
 * rolls back.
 */
async function writeRows(tx, writes) {
  const written = await updateRows(tx, writes);
  if (written.size !== writes.length) {
    throw new Error(`record repair: ${writes.length - written.size} of ${writes.length} rows changed during the run; nothing was written`);
  }
}

// --apply: the whole of part 2 runs in one transaction; long enough for a large table.
const APPLY_TIMEOUT_MS = 60 * 60 * 1000;

const roundPoints = (value) => Math.round(value * 100) / 100;

/**
 * Points each superseded row was paid, read only: its share of its upload batch (the uploader's
 * rows and Point rows written in one transaction carry the same createdAt) of the base crawler
 * Point, of the campaign boost and stay bonus, and of the upline Points paid to the uploader's
 * inviters at that time.
 */
async function supersededPoints(client, rows, batch) {
  const users = new Map();
  const batches = new Map();
  for (const row of rows) {
    const key = `${row.userId}\u0000${row.createdAt.getTime()}`;
    if (!batches.has(key)) batches.set(key, { userId: row.userId, createdAt: row.createdAt, rows: 0 });
    batches.get(key).rows += 1;
    if (!users.has(row.userId)) users.set(row.userId, { userId: row.userId, rows: 0, base: 0, bonus: 0, upline: 0, noBatch: 0 });
    users.get(row.userId).rows += 1;
  }

  // Inviter chains (as they stand now) for the upline share.
  const levels = Math.min(businessRules.rewardDistribution.maxLevels, businessRules.rewardDistribution.uplineRewardPercentages.length);
  const chains = new Map([...users.keys()].map((userId) => [userId, []]));
  let frontier = new Map([...users.keys()].map((userId) => [userId, userId]));
  for (let level = 0; level < levels && frontier.size > 0; level += 1) {
    const refs = await client.referral.findMany({
      where: { inviteeId: { in: [...new Set(frontier.values())] } },
      select: { inviteeId: true, inviterId: true },
    });
    const inviterOf = new Map(refs.map((ref) => [ref.inviteeId, ref.inviterId]));
    const next = new Map();
    for (const [userId, current] of frontier) {
      const inviter = inviterOf.get(current);
      if (!inviter) continue;
      chains.get(userId).push(inviter);
      next.set(userId, inviter);
    }
    frontier = next;
  }

  const list = [...batches.values()];
  for (let i = 0; i < list.length; i += batch) {
    const chunk = list.slice(i, i + batch);
    const at = chunk.map((b) => ({ userId: b.userId, createdAt: b.createdAt }));
    const inviterAt = chunk.flatMap((b) => chains.get(b.userId).map((inviter) => ({ userId: inviter, createdAt: b.createdAt })));
    const [counts, own, upline] = await Promise.all([
      client.crawlerData.groupBy({ by: ['userId', 'createdAt'], where: { OR: at }, _count: { _all: true } }),
      client.point.findMany({
        where: { OR: at, source: { in: ['crawler', POINT_SOURCE_CONNECT_BOOST, POINT_SOURCE_SUMMER_TRAVEL_BONUS] } },
        select: { userId: true, source: true, sourceId: true, amount: true, createdAt: true },
      }),
      inviterAt.length > 0
        ? client.point.findMany({
            where: { source: 'upline_reward', sourceId: 'crawler_data_upload', OR: inviterAt },
            select: { userId: true, amount: true, createdAt: true },
          })
        : [],
    ]);
    const timeKey = (userId, createdAt) => `${userId}\u0000${createdAt.getTime()}`;
    const rowsIn = new Map(counts.map((c) => [timeKey(c.userId, c.createdAt), c._count._all]));
    for (const b of chunk) {
      const share = (amount) => (amount * b.rows) / Math.max(rowsIn.get(timeKey(b.userId, b.createdAt)) || 0, 1);
      const same = (p) => p.userId === b.userId && p.createdAt.getTime() === b.createdAt.getTime();
      const base = own.filter((p) => same(p) && p.source === 'crawler' && p.sourceId === 'data_upload');
      const bonus = own.filter((p) => same(p) && p.source !== 'crawler');
      const up = upline.filter((p) => chains.get(b.userId).includes(p.userId) && p.createdAt.getTime() === b.createdAt.getTime());
      const user = users.get(b.userId);
      if (base.length === 0) user.noBatch += b.rows;
      user.base += share(base.reduce((sum, p) => sum + Number(p.amount), 0));
      user.bonus += share(bonus.reduce((sum, p) => sum + Number(p.amount), 0));
      user.upline += share(up.reduce((sum, p) => sum + Number(p.amount), 0));
    }
  }
  return [...users.values()]
    .map((u) => ({ ...u, base: roundPoints(u.base), bonus: roundPoints(u.bonus), upline: roundPoints(u.upline) }))
    .sort((a, b) => b.base + b.bonus - (a.base + a.bonus) || b.rows - a.rows || (a.userId < b.userId ? -1 : 1));
}

/**
 * Plans part 2 from what `db` reads (the client for a dry run, the locked transaction for --apply):
 * the link-key rows grouped by record, the stored rows already holding each record's identity, and
 * the writes. The first pass reads the whole table at most three times (superseded rows,
 * candidates, order-id holders); every other lookup uses an index. A later pass re-reads only the
 * link-key rows left (`candidateIds`). `pending` holds the writes of the earlier passes of a dry
 * run (which writes nothing), so a dry run plans every pass as --apply does.
 */
async function planRecordRepair(db, { userIds, batch, candidateIds = null, pending = new Map() }) {
  const seen = (row) => {
    const write = pending.get(row.id);
    return write ? { ...row, sourceId: write.sourceId, contentHash: write.contentHash } : row;
  };
  const userWhere = userIds.length > 0 ? { userId: { in: userIds } } : {};
  const earlier = candidateIds
    ? []
    : (
        await db.crawlerData.findMany({
          where: { ...userWhere, sourceId: { startsWith: SUPERSEDED_PREFIX } },
          select: { id: true, userId: true, createdAt: true, sourceId: true },
        })
      ).filter((row) => row.sourceId === `${SUPERSEDED_PREFIX}${row.id}`);

  // 1. The link-key rows (all users, so a record is always repaired as a whole), grouped by the
  //    record they are a copy of.
  const ids = candidateIds || (await linkKeyCandidateIds(db));
  const records = new Map();
  let scanned = 0;
  for (let i = 0; i < ids.length; i += batch) {
    const rows = await db.crawlerData.findMany({
      where: { id: { in: ids.slice(i, i + batch) } },
      select: { ...ROW_SELECT, payload: true, metadata: true },
    });
    scanned += rows.length;
    for (const row of rows.map(seen)) {
      if (!isRecordLinkKeyRow(row)) continue;
      const target = recordIdentity(row);
      if (target.sourceId === row.sourceId) continue; // already its own identity
      if (!records.has(target.scope)) {
        records.set(target.scope, { ...target, source: row.source, userId: row.userId, rows: [] });
      }
      const { payload, metadata, ...kept } = row;
      records.get(target.scope).rows.push({ ...kept, targetHash: target.contentHash });
    }
  }
  const users = new Set(userIds);
  const list = [...records.values()]
    .filter((record) => users.size === 0 || record.rows.some((row) => users.has(row.userId)))
    .map((record) => ({ ...record, rows: record.rows.sort(byAge) }))
    .sort((a, b) => byAge(a.rows[0], b.rows[0]));
  const linkIds = new Set([...records.values()].flatMap((record) => record.rows.map((row) => row.id)));

  // 2. Stored rows already holding each record's identity (never a link-key row: those hold a link
  //    key). Order ids in one pass; title keys and content hashes by their unique indexes; in a dry
  //    run also the rows an earlier pass would have given an identity.
  const found = new Map();
  (await orderIdHolders(db, list.filter((record) => record.kind === 'order'))).forEach((row) => found.set(row.id, seen(row)));
  const indexed = list.filter((record) => record.kind !== 'order');
  for (let i = 0; i < indexed.length; i += batch) {
    const rows = await db.crawlerData.findMany({ where: { OR: indexed.slice(i, i + batch).map(scopeWhere) }, select: ROW_SELECT });
    rows.forEach((row) => found.set(row.id, seen(row)));
  }
  for (const row of pending.values()) found.set(row.id, row);
  const holdersOf = new Map(list.map((record) => [record.scope, []]));
  const blockedBy = new Map();
  for (const row of found.values()) {
    const scope = storedScope(row);
    if (!holdersOf.has(scope)) continue;
    // A row of another record still under its link key holds this title key: this record waits
    // until that row is repaired (a later pass).
    if (linkIds.has(row.id)) blockedBy.set(scope, [...(blockedBy.get(scope) || []), row.id]);
    else holdersOf.get(scope).push(row);
  }
  const plans = list.map((record) => ({
    ...planRecord(record, holdersOf.get(record.scope)),
    blocked: blockedBy.has(record.scope),
    blockedBy: blockedBy.get(record.scope) || [],
  }));

  // 3. A restored holder takes its content hash unless a row outside its record already holds it.
  const restoring = plans.filter((plan) => plan.restore && !plan.blocked);
  const targets = new Set(restoring.map((plan) => plan.restore.targetHash));
  const hashHeldBy = new Map();
  const holdsHash = (row) => {
    if (!targets.has(row.contentHash)) return;
    if (!hashHeldBy.has(row.contentHash)) hashHeldBy.set(row.contentHash, new Set());
    hashHeldBy.get(row.contentHash).add(row.id);
  };
  for (let i = 0; i < restoring.length; i += batch) {
    const rows = await db.crawlerData.findMany({
      where: { contentHash: { in: restoring.slice(i, i + batch).map((plan) => plan.restore.targetHash) } },
      select: { id: true, contentHash: true },
    });
    rows.filter((row) => !pending.has(row.id)).forEach(holdsHash);
  }
  for (const row of pending.values()) holdsHash(row);
  const claimedHashes = new Set();
  for (const plan of plans) {
    if (plan.blocked) continue;
    plan.writes = plan.supersede.map(({ row }) => ({
      id: row.id,
      from: { sourceId: row.sourceId, contentHash: row.contentHash },
      to: supersededIdentity(row.id),
      row,
    }));
    plan.restoreWrite = null;
    if (plan.restore) {
      const own = new Set([plan.restore.id, ...plan.supersede.map(({ row }) => row.id)]);
      const hash = plan.restore.targetHash;
      plan.hashKept = claimedHashes.has(hash) || [...(hashHeldBy.get(hash) || [])].some((id) => !own.has(id));
      if (!plan.hashKept) claimedHashes.add(hash);
      plan.restoreWrite = {
        id: plan.restore.id,
        from: { sourceId: plan.restore.sourceId, contentHash: plan.restore.contentHash },
        to: { sourceId: plan.record.sourceId, contentHash: plan.hashKept ? plan.restore.contentHash : hash },
        row: plan.restore,
      };
    }
  }
  return { earlier, scanned, plans, linkRowIds: [...linkIds] };
}

/** Every write of a ready plan: its superseded copies first, then its restored holder. */
const planWrites = (plan) => [...plan.writes, ...(plan.restoreWrite ? [plan.restoreWrite] : [])];

/**
 * Writes the ready plans in batches of about `batch` records, one statement each for the superseded
 * copies and then for the restored holders, so a holder can take the identity a later copy gives up.
 */
async function writePlans(tx, plans, batch) {
  for (let i = 0; i < plans.length; i += batch) {
    const chunk = plans.slice(i, i + batch);
    await writeRows(tx, chunk.flatMap((plan) => plan.writes));
    await writeRows(tx, chunk.filter((plan) => plan.restoreWrite).map((plan) => plan.restoreWrite));
  }
}

// A record whose identity is the link key of another record's row waits for that row: each pass
// repairs the records that are ready, then plans again while a waiting record's blocking rows were
// all repaired in that pass. A chain of such records takes one pass per link; rows that block each
// other never become ready and stay listed.
const MAX_PASSES = 20;

/**
 * Plans and writes (`write`: the locked transaction) or only plans (a dry run) pass after pass,
 * while a waiting record has become ready.
 */
async function repairRecords(db, opts, write) {
  const pending = new Map();
  const settled = [];
  let first = null;
  let candidateIds = null;
  let passes = 0;
  for (;;) {
    passes += 1;
    const result = await planRecordRepair(db, { ...opts, candidateIds, pending });
    first ||= result;
    const ready = result.plans.filter((plan) => !plan.blocked);
    const waiting = result.plans.filter((plan) => plan.blocked);
    if (write) await writePlans(db, ready, opts.batch);
    const done = ready.flatMap(planWrites);
    if (!write) {
      for (const w of done) pending.set(w.id, { ...w.row, sourceId: w.to.sourceId, contentHash: w.to.contentHash });
    }
    settled.push(...ready);
    const doneIds = new Set(done.map((w) => w.id));
    const readyNext = waiting.some((plan) => plan.blockedBy.every((id) => doneIds.has(id)));
    if (!readyNext || passes === MAX_PASSES) {
      return { earlier: first.earlier, scanned: first.scanned, records: first.plans, settled, waiting, passes, capped: readyNext };
    }
    candidateIds = result.linkRowIds.filter((id) => !doneIds.has(id));
  }
}

/**
 * Part 2. Finds the rows of other sources stored under the previous release's post link key,
 * groups them by the record they are a copy of, and gives each record its identity back (earliest
 * copy) or marks the copy superseded. Returns a report; writes only with `apply: true`.
 *
 * --apply plans and writes in one serializable transaction that first locks CrawlerData against
 * writes (SHARE ROW EXCLUSIVE; reads go on): nothing can store a copy between the read and the
 * write, and an error rolls back everything. After the writes it plans again in that transaction
 * while a record that waited for another record's link key has become ready, so one --apply
 * settles and a second one writes nothing. A dry run plans the same passes without writing.
 */
async function backfillRecordIdentity({ client = prisma, apply = false, userIds = [], batch = DEFAULT_BATCH } = {}) {
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    linkKeyRows: 0,
    records: 0,
    passes: 0,
    restored: 0,
    restoredByKind: { order: 0, title: 0, content: 0 },
    hashKept: 0,
    heldAlready: 0,
    superseded: 0,
    supersededLinkKey: 0,
    supersededStored: 0,
    alreadySuperseded: 0,
    bySource: {},
    conflicts: [],
    users: [],
  };

  const opts = { userIds, batch };
  const run = apply
    ? await client.$transaction(
        async (tx) => {
          await tx.$executeRaw`LOCK TABLE "CrawlerData" IN SHARE ROW EXCLUSIVE MODE`;
          return repairRecords(tx, opts, true);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: APPLY_TIMEOUT_MS },
      )
    : await repairRecords(client, opts, false);

  report.scanned = run.scanned;
  report.alreadySuperseded = run.earlier.length;
  report.records = run.records.length;
  report.linkKeyRows = run.records.reduce((sum, plan) => sum + plan.record.rows.length, 0);
  report.passes = run.passes;
  const superseded = [];
  for (const plan of run.settled) {
    const tally = (report.bySource[plan.record.source] ||= { restore: 0, supersede: 0 });
    if (plan.restore) {
      report.restored += 1;
      report.restoredByKind[plan.record.kind] += 1;
      if (plan.hashKept) report.hashKept += 1;
      tally.restore += 1;
    } else {
      report.heldAlready += 1;
    }
    for (const { row, linkKey } of plan.supersede) {
      report.superseded += 1;
      if (linkKey) report.supersededLinkKey += 1;
      else report.supersededStored += 1;
      tally.supersede += 1;
      superseded.push(row);
    }
  }
  const reason = run.capped
    ? `identity held as a link key by a row of another record, still waiting after ${MAX_PASSES} passes; run again`
    : 'identity held as a link key by a row of another record that cannot be repaired first (rows that block each other, or a record outside --user); left as it is';
  for (const plan of run.waiting) {
    for (const row of plan.record.rows) report.conflicts.push({ id: row.id, userId: row.userId, reason });
  }

  report.users = await supersededPoints(client, [...superseded, ...run.earlier], batch);
  return report;
}

function printRecordReport(report) {
  const done = report.mode === 'apply';
  const pts = (value) => value.toFixed(2);
  console.log(`other sources: ${report.linkKeyRows} rows stored under a post link key, ${report.records} records (${report.scanned} rows read)`);
  console.log(
    `  ${done ? 'restored' : 'would restore'} own identity: ${report.restored} (order id ${report.restoredByKind.order}, ` +
      `title key ${report.restoredByKind.title}, content only ${report.restoredByKind.content}; ` +
      `content hash kept, held by another row: ${report.hashKept})`,
  );
  console.log(`  earliest copy already holds the identity: ${report.heldAlready}`);
  console.log(
    `  ${done ? 'marked' : 'would mark'} superseded (later copies): ${report.superseded} ` +
      `(stored under a link key ${report.supersededLinkKey}, under the identity itself ${report.supersededStored})`,
  );
  console.log(`  already superseded by an earlier run: ${report.alreadySuperseded}`);
  console.log(`  passes: ${report.passes} (a record whose identity was the link key of another record's row is repaired in the pass after it)`);
  for (const source of Object.keys(report.bySource).sort()) {
    const tally = report.bySource[source];
    console.log(`    ${source}: restore ${tally.restore}, supersede ${tally.supersede}`);
  }
  console.log(`  conflicts (left unchanged, nothing deleted): ${report.conflicts.length}`);
  for (const conflict of report.conflicts) {
    console.log(`    row ${conflict.id} user ${conflict.userId}: ${conflict.reason}`);
  }
  const total = report.users.reduce(
    (sum, u) => ({ rows: sum.rows + u.rows, base: sum.base + u.base, bonus: sum.bonus + u.bonus, upline: sum.upline + u.upline, noBatch: sum.noBatch + u.noBatch }),
    { rows: 0, base: 0, bonus: 0, upline: 0, noBatch: 0 },
  );
  console.log('superseded rows per user, this run and earlier runs (points unchanged; each row\'s share of its upload batch):');
  for (const u of report.users) {
    console.log(
      `  user ${u.userId}: rows ${u.rows}, points ${pts(u.base + u.bonus)} (base ${pts(u.base)}, bonus ${pts(u.bonus)}), ` +
        `upline ${pts(u.upline)}, no batch ${u.noBatch}`,
    );
  }
  console.log(
    `  total: users ${report.users.length}, rows ${total.rows}, points ${pts(total.base + total.bonus)} ` +
      `(base ${pts(total.base)}, bonus ${pts(total.bonus)}), upline ${pts(total.upline)}, no batch ${total.noBatch}`,
  );
}

async function main(argv) {
  const opts = parseArgs(argv);
  try {
    printReport(await backfillSocialPostIdentity(opts));
    printRecordReport(await backfillRecordIdentity(opts));
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

module.exports = {
  parseArgs,
  backfillSocialPostIdentity,
  printReport,
  STORED_SOURCES,
  backfillRecordIdentity,
  printRecordReport,
  legacyLinkKey,
  isRecordLinkKeyRow,
  recordIdentity,
  planRecord,
  supersededIdentity,
  SUPERSEDED_PREFIX,
  CERTAIN_PERMALINK_SQL,
};
