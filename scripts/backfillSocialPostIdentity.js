/**
 * One-time backfill of record identity, in two parts.
 *
 * 1. Social posts: give the X / Instagram / Threads / TikTok rows stored before the per-user
 *    permalink identity that identity (sourceId and contentHash), so the first sync after the
 *    release finds each post as already stored instead of storing it, and paying for it, a second
 *    time. When one user already holds several rows of the same post (a changed like count used to
 *    look like a new post), the oldest row takes the new identity and the others keep theirs: they
 *    are listed by id under "conflicts" for ops to decide.
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
 * its old identity and is listed as a conflict.
 *
 * Usage (where the API runs, so DATABASE_URL is the server's):
 *   node scripts/backfillSocialPostIdentity.js                # dry run (default): counts, writes nothing
 *   node scripts/backfillSocialPostIdentity.js --apply        # rewrites sourceId / contentHash
 *   node scripts/backfillSocialPostIdentity.js --user=<id>    # only this user's rows (repeatable); in
 *                                                             # part 2 every record holding a row of this
 *                                                             # user is repaired as a whole
 *   node scripts/backfillSocialPostIdentity.js --batch=500    # rows read per page and written per transaction
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

/**
 * Ids of the rows that may hold the previous release's key, in one pass over the table: the key
 * itself looks like a post link, or (other sources) the payload holds one.
 */
async function linkKeyCandidateIds(client) {
  const rows = await client.$queryRaw`
    SELECT id FROM "CrawlerData"
    WHERE "sourceId" LIKE 'title:%'
      AND "sourceId" NOT LIKE 'title:post:%'
      AND "sourceId" NOT LIKE 'title:superseded:%'
      AND ("sourceId" ~* ${LEGACY_POST_LINK_SQL}
        OR (source NOT IN (${Prisma.join(STORED_SOURCES)})
          AND (payload->>'href' ~* ${LEGACY_POST_LINK_SQL} OR payload->>'id' ~* ${LEGACY_POST_LINK_SQL}
            OR payload->>'orderId' ~* ${LEGACY_POST_LINK_SQL} OR payload->>'orderid' ~* ${LEGACY_POST_LINK_SQL})))
    ORDER BY id`;
  return rows.map((row) => row.id);
}

class ChangedDuringRun extends Error {}

const RETRYABLE = new Set(['P2002', 'P2034']);

/** Writes a set of planned records in one transaction; every write is checked against the row read. */
async function writePlans(client, plans, linkIds) {
  await client.$transaction(
    async (tx) => {
      // Nothing stored or changed since the read: the same stored rows hold each identity.
      const now = await tx.crawlerData.findMany({ where: { OR: plans.map((p) => scopeWhere(p.record)) }, select: ROW_SELECT });
      for (const plan of plans) {
        const ids = now
          .filter((row) => !linkIds.has(row.id) && storedScope(row) === plan.record.scope)
          .map((row) => row.id)
          .sort();
        if (ids.join(',') !== plan.storedIds.join(',')) throw new ChangedDuringRun();
      }
      for (const plan of plans) {
        for (const write of plan.writes) {
          const { count } = await tx.crawlerData.updateMany({
            where: { id: write.id, sourceId: write.from.sourceId, contentHash: write.from.contentHash },
            data: write.to,
          });
          if (count !== 1) throw new ChangedDuringRun();
        }
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 120000 },
  );
}

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
 * Part 2. Finds the rows of other sources stored under the previous release's post link key,
 * groups them by the record they are a copy of, and gives each record its identity back (earliest
 * copy) or marks the copy superseded. Returns a report; writes only with `apply: true`.
 */
async function backfillRecordIdentity({ client = prisma, apply = false, userIds = [], batch = DEFAULT_BATCH } = {}) {
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    linkKeyRows: 0,
    records: 0,
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
  const userWhere = userIds.length > 0 ? { userId: { in: userIds } } : {};
  const earlier = await client.crawlerData.findMany({
    where: { ...userWhere, sourceId: { startsWith: SUPERSEDED_PREFIX } },
    select: { id: true, userId: true, createdAt: true },
  });
  report.alreadySuperseded = earlier.length;

  // 1. The link-key rows (all users, so a record is always repaired as a whole), grouped by the
  //    record they are a copy of.
  const ids = await linkKeyCandidateIds(client);
  const records = new Map();
  for (let i = 0; i < ids.length; i += batch) {
    const rows = await client.crawlerData.findMany({
      where: { id: { in: ids.slice(i, i + batch) } },
      select: { ...ROW_SELECT, payload: true, metadata: true },
    });
    report.scanned += rows.length;
    for (const row of rows) {
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
  report.records = list.length;
  report.linkKeyRows = list.reduce((sum, record) => sum + record.rows.length, 0);

  const claimedHashes = new Set();
  const superseded = [];
  const conflict = (plan, reason) => {
    for (const row of plan.record.rows) report.conflicts.push({ id: row.id, userId: row.userId, reason });
  };
  const count = (plan) => {
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
  };

  // 2. Records in chunks of about `batch` link-key rows: plan, then write in one transaction.
  for (let i = 0; i < list.length; ) {
    const chunk = [];
    let size = 0;
    while (i < list.length && (chunk.length === 0 || size + list[i].rows.length <= batch)) {
      size += list[i].rows.length;
      chunk.push(list[i]);
      i += 1;
    }

    // Stored rows already holding each record's identity (never a link-key row: those hold a link key).
    const stored = await client.crawlerData.findMany({ where: { OR: chunk.map(scopeWhere) }, select: ROW_SELECT });
    const holdersOf = new Map(chunk.map((record) => [record.scope, []]));
    for (const row of stored) {
      const scope = storedScope(row);
      if (!linkIds.has(row.id) && holdersOf.has(scope)) holdersOf.get(scope).push(row);
    }
    const plans = chunk.map((record) => planRecord(record, holdersOf.get(record.scope)));

    // A restored holder takes its content hash unless a row outside its record already holds it.
    const restoring = plans.filter((plan) => plan.restore);
    const hashHolders = restoring.length
      ? await client.crawlerData.findMany({
          where: { contentHash: { in: restoring.map((plan) => plan.restore.targetHash) } },
          select: { id: true, contentHash: true },
        })
      : [];
    for (const plan of plans) {
      const writes = plan.supersede.map(({ row }) => ({
        id: row.id,
        from: { sourceId: row.sourceId, contentHash: row.contentHash },
        to: supersededIdentity(row.id),
      }));
      if (plan.restore) {
        const own = new Set([plan.restore.id, ...plan.supersede.map(({ row }) => row.id)]);
        const hash = plan.restore.targetHash;
        plan.hashKept =
          claimedHashes.has(hash) || hashHolders.some((row) => row.contentHash === hash && !own.has(row.id));
        if (!plan.hashKept) claimedHashes.add(hash);
        writes.push({
          id: plan.restore.id,
          from: { sourceId: plan.restore.sourceId, contentHash: plan.restore.contentHash },
          to: { sourceId: plan.record.sourceId, contentHash: plan.hashKept ? plan.restore.contentHash : hash },
        });
      }
      plan.writes = writes;
    }

    if (!apply) {
      plans.forEach(count);
      continue;
    }
    try {
      await writePlans(client, plans, linkIds);
      plans.forEach(count);
    } catch (error) {
      if (!(error instanceof ChangedDuringRun) && !RETRYABLE.has(error && error.code)) throw error;
      // Something changed under one of the records: retry them one by one, skip the changed ones.
      for (const plan of plans) {
        try {
          await writePlans(client, [plan], linkIds);
          count(plan);
        } catch (single) {
          if (!(single instanceof ChangedDuringRun) && !RETRYABLE.has(single && single.code)) throw single;
          conflict(plan, 'changed during the run');
        }
      }
    }
  }

  report.users = await supersededPoints(client, [...superseded, ...earlier], batch);
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
};
