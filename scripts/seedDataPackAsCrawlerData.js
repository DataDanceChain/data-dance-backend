/**
 * Seed data-pack CSV orders as personal CrawlerData (no points).
 *
 * Maps buyer-email → pre-created User, attaches rows under
 * CrawlerTask(amazon_orders). Bypasses uploadCrawlerData so no Point /
 * referral / upline rewards are written.
 *
 * Usage:
 *   node scripts/seedDataPackAsCrawlerData.js --dry-run
 *   node scripts/seedDataPackAsCrawlerData.js
 *   node scripts/seedDataPackAsCrawlerData.js --file data-pack-4.csv --batch-size 1000
 *   node scripts/seedDataPackAsCrawlerData.js --csv-only
 *   node scripts/seedDataPackAsCrawlerData.js --limit 1000
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient, Prisma } = require('@prisma/client');
const { getOrCreateCrawlerTask, generateContentHash } = require('../src/services/crawlerService');

const prisma = new PrismaClient();

const IMPORT_SOURCE = 'data-pack';
const IMPORT_BATCH = 'data-pack-4';
const AMAZON_TASK_ID = 'amazon_orders';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    csvOnly: false,
    file: path.join(__dirname, '../data-pack-4.csv'),
    batchSize: 1000,
    limit: null,
    importBatch: IMPORT_BATCH,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--csv-only') {
      options.csvOnly = true;
    } else if (arg === '--file' && args[i + 1]) {
      options.file = path.resolve(args[++i]);
    } else if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = Math.max(1, parseInt(args[++i], 10) || 1000);
    } else if (arg === '--limit' && args[i + 1]) {
      options.limit = Math.max(1, parseInt(args[++i], 10) || 1);
    } else if (arg === '--import-batch' && args[i + 1]) {
      options.importBatch = String(args[++i]).trim() || IMPORT_BATCH;
    }
  }

  return options;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function normalizeEmail(value) {
  if (!value || typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  return email;
}

function normalizeOrderId(value) {
  if (!value || typeof value !== 'string') return null;
  const id = value.trim();
  return id || null;
}

function loadOrdersFromCsv(filePath, importBatch = IMPORT_BATCH) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  const emailKey = headers.find((h) => {
    const key = h.toLowerCase();
    return key.includes('email') || key.includes('mail') || h.includes('邮箱');
  });
  const orderKey = headers.find((h) => {
    const key = h.toLowerCase();
    return key === 'order-id' || key === 'orderid' || key === '订单编号' || key.includes('order');
  });
  const titleKey = headers.find((h) => {
    const key = h.toLowerCase();
    return key === 'title' || key === '商品名称' || key.includes('title');
  });

  if (!emailKey || !orderKey) {
    throw new Error(`CSV missing email/order columns. Headers: ${headers.join(', ')}`);
  }

  const orders = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const email = normalizeEmail(values[idx[emailKey]]);
    const orderId = normalizeOrderId(values[idx[orderKey]]);
    if (!email || !orderId) continue;

    orders.push({
      email,
      orderId,
      title: (titleKey && values[idx[titleKey]] ? values[idx[titleKey]].trim() : '') || '',
      shipAddress: (idx['ship-address'] != null ? values[idx['ship-address']] : values[idx['收件地址']] || '').trim(),
      shipCity: (idx['ship-city'] != null ? values[idx['ship-city']] : '').trim(),
      shipState: (idx['ship-state'] != null ? values[idx['ship-state']] : '').trim(),
      shipPostalCode: (idx['ship-postal-code'] != null ? values[idx['ship-postal-code']] : '').trim(),
      shipCountry: (idx['ship-country'] != null ? values[idx['ship-country']] : '').trim(),
      importBatch,
    });
  }
  return orders;
}

function loadOrdersFromCleanedJson(filePath, importBatch) {
  if (!fs.existsSync(filePath)) return [];
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(data)) return [];

  const orders = [];
  for (const row of data) {
    const email = normalizeEmail(row['buyer-email'] || row.email || row['邮箱']);
    const orderId = normalizeOrderId(row['order-id'] || row.orderId || row['订单编号']);
    if (!email || !orderId) continue;

    orders.push({
      email,
      orderId,
      title: String(row.title || row['商品名称'] || '').trim(),
      shipAddress: String(row['ship-address'] || row['收件地址'] || '').trim(),
      shipCity: String(row['ship-city'] || '').trim(),
      shipState: String(row['ship-state'] || '').trim(),
      shipPostalCode: String(row['ship-postal-code'] || '').trim(),
      shipCountry: String(row['ship-country'] || '').trim(),
      importBatch,
    });
  }
  return orders;
}

/** Deduplicate by order-id; first occurrence wins. */
function dedupeOrders(orders) {
  const byOrderId = new Map();
  for (const order of orders) {
    if (!byOrderId.has(order.orderId)) {
      byOrderId.set(order.orderId, order);
    }
  }
  return [...byOrderId.values()];
}

function buildPayload(order) {
  return {
    orderid: order.orderId,
    title: order.title,
    shipAddress: order.shipAddress,
    shipCity: order.shipCity,
    shipState: order.shipState,
    shipPostalCode: order.shipPostalCode,
    shipCountry: order.shipCountry,
  };
}

async function findUsersByEmails(emails) {
  const map = new Map();
  const batchSize = 1000;
  for (let i = 0; i < emails.length; i += batchSize) {
    const chunk = emails.slice(i, i + batchSize);
    const rows = await prisma.user.findMany({
      where: { email: { in: chunk } },
      select: { id: true, email: true },
    });
    for (const row of rows) {
      map.set(row.email.toLowerCase(), row.id);
    }
  }
  return map;
}

async function findExistingSourceIds(sourceIds) {
  const existing = new Set();
  const batchSize = 1000;
  for (let i = 0; i < sourceIds.length; i += batchSize) {
    const chunk = sourceIds.slice(i, i + batchSize);
    const rows = await prisma.crawlerData.findMany({
      where: { source: 'amazon', sourceId: { in: chunk } },
      select: { sourceId: true },
    });
    for (const row of rows) {
      if (row.sourceId) existing.add(row.sourceId);
    }
  }
  return existing;
}

async function ensureAmazonTasks(userIds) {
  const taskByUserId = new Map();
  const batchSize = 1000;
  const missing = [];

  for (let i = 0; i < userIds.length; i += batchSize) {
    const chunk = userIds.slice(i, i + batchSize);
    const existing = await prisma.crawlerTask.findMany({
      where: {
        userId: { in: chunk },
        source: 'amazon',
        OR: [{ taskId: AMAZON_TASK_ID }, { title: 'Amazon Order History' }],
      },
      select: { id: true, userId: true, taskId: true },
    });

    const have = new Set();
    for (const task of existing) {
      // Prefer the amazon_orders taskId row when duplicates exist.
      if (!taskByUserId.has(task.userId) || task.taskId === AMAZON_TASK_ID) {
        taskByUserId.set(task.userId, task.id);
      }
      have.add(task.userId);
    }
    for (const userId of chunk) {
      if (!have.has(userId)) missing.push(userId);
    }
  }

  if (missing.length > 0) {
    console.log(`Creating amazon_orders tasks for ${missing.length} users...`);
    const now = new Date();
    for (let i = 0; i < missing.length; i += batchSize) {
      const chunk = missing.slice(i, i + batchSize);
      await prisma.crawlerTask.createMany({
        data: chunk.map((userId) => ({
          taskId: AMAZON_TASK_ID,
          title: 'Amazon Order History',
          description: 'Crawl your Amazon order history to earn rewards',
          source: 'amazon',
          userId,
          status: 'pending',
          recordCount: 0,
          createdAt: now,
          updatedAt: now,
        })),
        skipDuplicates: true,
      });
      const created = await prisma.crawlerTask.findMany({
        where: {
          userId: { in: chunk },
          source: 'amazon',
          taskId: AMAZON_TASK_ID,
        },
        select: { id: true, userId: true },
      });
      for (const task of created) {
        taskByUserId.set(task.userId, task.id);
      }
    }
  }

  // Fallback for any still-missing users (rare race / constraint edge cases).
  for (const userId of userIds) {
    if (!taskByUserId.has(userId)) {
      const task = await getOrCreateCrawlerTask(userId, 'amazon', AMAZON_TASK_ID);
      taskByUserId.set(userId, task.id);
    }
  }

  return taskByUserId;
}

async function refreshRecordCounts(taskIds) {
  if (taskIds.length === 0) return;
  const batchSize = 2000;
  for (let i = 0; i < taskIds.length; i += batchSize) {
    const chunk = taskIds.slice(i, i + batchSize);
    await prisma.$executeRaw`
      UPDATE "CrawlerTask" AS t
      SET "recordCount" = sub.cnt,
          "updatedAt" = NOW()
      FROM (
        SELECT "taskId" AS id, COUNT(*)::int AS cnt
        FROM "CrawlerData"
        WHERE "taskId" IN (${Prisma.join(chunk)})
        GROUP BY "taskId"
      ) AS sub
      WHERE t.id = sub.id
    `;
  }
}

async function main() {
  const options = parseArgs();
  const startedAt = Date.now();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Seed data-pack orders as personal CrawlerData');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'WRITE (no points)'}`);
  console.log(`CSV: ${options.file}`);
  console.log(`Batch size: ${options.batchSize}`);
  console.log(`Include cleaned JSON packs: ${!options.csvOnly}`);
  console.log(`Import batch: ${options.importBatch}`);
  if (options.limit) console.log(`Limit: ${options.limit}`);

  if (!fs.existsSync(options.file)) {
    throw new Error(`CSV not found: ${options.file}`);
  }

  let orders = loadOrdersFromCsv(options.file, options.importBatch);
  console.log(`Orders from CSV: ${orders.length}`);

  if (!options.csvOnly) {
    const pack1 = loadOrdersFromCleanedJson(
      path.join(__dirname, '../cleaned-data/data-pack-1_cleaned.json'),
      'data-pack-1'
    );
    const pack2 = loadOrdersFromCleanedJson(
      path.join(__dirname, '../cleaned-data/data-pack-2_cleaned.json'),
      'data-pack-2'
    );
    console.log(`+ pack-1 orders: ${pack1.length}`);
    console.log(`+ pack-2 orders: ${pack2.length}`);
    // Prefer pack-4/CSV first, then pack-2, then pack-1 for order-id conflicts.
    orders = dedupeOrders([...orders, ...pack2, ...pack1]);
  } else {
    orders = dedupeOrders(orders);
  }

  console.log(`Unique orders (by order-id): ${orders.length}`);

  if (options.limit) {
    orders = orders.slice(0, options.limit);
    console.log(`After --limit: ${orders.length}`);
  }

  const emails = [...new Set(orders.map((o) => o.email))];
  const userByEmail = await findUsersByEmails(emails);
  console.log(`Emails in file: ${emails.length}`);
  console.log(`Matched users: ${userByEmail.size}`);

  const withUser = [];
  let skippedNoUser = 0;
  for (const order of orders) {
    const userId = userByEmail.get(order.email);
    if (!userId) {
      skippedNoUser += 1;
      continue;
    }
    withUser.push({ ...order, userId });
  }

  const sourceIds = withUser.map((o) => o.orderId);
  const existingSourceIds = await findExistingSourceIds(sourceIds);
  const toInsert = [];
  let skippedDuplicateSourceId = 0;
  for (const order of withUser) {
    if (existingSourceIds.has(order.orderId)) {
      skippedDuplicateSourceId += 1;
      continue;
    }
    toInsert.push(order);
  }

  console.log(`Skipped (no user): ${skippedNoUser}`);
  console.log(`Skipped (existing sourceId): ${skippedDuplicateSourceId}`);
  console.log(`To insert: ${toInsert.length}`);

  if (options.dryRun) {
    const matchedUsers = new Set(toInsert.map((o) => o.userId));
    console.log(`Would touch users: ${matchedUsers.size}`);
    console.log(`\nDry run complete — no CrawlerData written.`);
    console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
    return;
  }

  if (toInsert.length === 0) {
    console.log('\nNothing to insert.');
    return;
  }

  const userIds = [...new Set(toInsert.map((o) => o.userId))];
  console.log(`Ensuring amazon_orders tasks for ${userIds.length} users...`);
  const taskByUserId = await ensureAmazonTasks(userIds);

  const now = new Date();
  let inserted = 0;
  const touchedTaskIds = new Set();

  for (let i = 0; i < toInsert.length; i += options.batchSize) {
    const batch = toInsert.slice(i, i + options.batchSize);
    const rows = [];
    const hashesInBatch = new Set();

    for (const order of batch) {
      const taskId = taskByUserId.get(order.userId);
      if (!taskId) continue;

      const payload = buildPayload(order);
      let contentHash = generateContentHash(payload);
      // contentHash is globally unique; disambiguate rare collisions across users.
      if (hashesInBatch.has(contentHash)) {
        contentHash = crypto
          .createHash('sha256')
          .update(`${contentHash}:${order.userId}:${order.orderId}`)
          .digest('hex');
      }
      hashesInBatch.add(contentHash);

      rows.push({
        source: 'amazon',
        type: 'order',
        timestamp: now,
        metadata: {
          importSource: IMPORT_SOURCE,
          importBatch: order.importBatch || IMPORT_BATCH,
          rewardEligible: false,
        },
        payload,
        taskId,
        userId: order.userId,
        contentHash,
        sourceId: order.orderId,
        createdAt: now,
        updatedAt: now,
      });
      touchedTaskIds.add(taskId);
    }

    try {
      const result = await prisma.crawlerData.createMany({
        data: rows,
        skipDuplicates: true,
      });
      inserted += result.count;
    } catch (error) {
      console.warn(
        `Batch at ${i} failed (${error.code || error.message}), retrying row-by-row...`
      );
      for (const row of rows) {
        try {
          await prisma.crawlerData.create({ data: row });
          inserted += 1;
        } catch (rowError) {
          if (rowError.code === 'P2002') {
            // duplicate contentHash / sourceId — skip
          } else {
            console.error(`Failed order ${row.sourceId}:`, rowError.message);
          }
        }
      }
    }

    const done = Math.min(i + options.batchSize, toInsert.length);
    if (done % (options.batchSize * 5) === 0 || done === toInsert.length) {
      console.log(`Progress: ${done}/${toInsert.length} (inserted≈${inserted})`);
    }
  }

  console.log(`Refreshing recordCount for ${touchedTaskIds.size} tasks...`);
  await refreshRecordCounts([...touchedTaskIds]);

  console.log('\nDone.');
  console.log(`Inserted: ${inserted}`);
  console.log(`Skipped (no user): ${skippedNoUser}`);
  console.log(`Skipped (existing sourceId): ${skippedDuplicateSourceId}`);
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
}

main()
  .catch((error) => {
    console.error('\nFailed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
