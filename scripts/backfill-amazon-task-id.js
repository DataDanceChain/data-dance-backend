#!/usr/bin/env node
/**
 * Backfill script: associate all existing Amazon CrawlerData with the canonical
 * Amazon CrawlerTask (taskId = 'amazon_orders'). Fixes users whose data was
 * created before taskId was set or linked to a task without taskId.
 *
 * Run: node scripts/backfill-amazon-task-id.js
 * Dry run (no DB writes): DRY_RUN=1 node scripts/backfill-amazon-task-id.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const AMAZON_TASK_ID = 'amazon_orders';
const AMAZON_TEMPLATE = {
  taskId: AMAZON_TASK_ID,
  title: 'Amazon Order History',
  description: 'Crawl your Amazon order history to earn rewards',
  source: 'amazon',
};

function log(msg) {
  console.log(`[backfill-amazon] ${msg}`);
}

async function backfillAmazonTaskId() {
  const dryRun = process.env.DRY_RUN === '1';
  if (dryRun) log('DRY RUN – no changes will be written');

  // 1. Users who have any Amazon CrawlerData
  const amazonData = await prisma.crawlerData.findMany({
    where: { source: 'amazon' },
    select: { userId: true, taskId: true },
  });
  const userIds = [...new Set(amazonData.map((d) => d.userId))];
  if (userIds.length === 0) {
    log('No Amazon CrawlerData found. Nothing to do.');
    return;
  }
  log(`Found ${amazonData.length} Amazon records for ${userIds.length} user(s).`);

  let updatedData = 0;
  let updatedTasks = 0;
  let createdTasks = 0;

  for (const userId of userIds) {
    const userAmazonData = amazonData.filter((d) => d.userId === userId);

    // 2. Resolve canonical CrawlerTask for this user (taskId = 'amazon_orders')
    let task = await prisma.crawlerTask.findFirst({
      where: { userId, source: 'amazon', taskId: AMAZON_TASK_ID },
      select: { id: true, taskId: true, title: true },
    });

    if (!task) {
      const anyAmazonTask = await prisma.crawlerTask.findFirst({
        where: { userId, source: 'amazon' },
        select: { id: true, taskId: true, title: true },
      });
      if (anyAmazonTask) {
        if (!dryRun) {
          await prisma.crawlerTask.update({
            where: { id: anyAmazonTask.id },
            data: {
              taskId: AMAZON_TASK_ID,
              title: AMAZON_TEMPLATE.title,
              description: AMAZON_TEMPLATE.description,
              updatedAt: new Date(),
            },
          });
        }
        task = { id: anyAmazonTask.id, taskId: AMAZON_TASK_ID, title: AMAZON_TEMPLATE.title };
        updatedTasks += 1;
        log(`User ${userId}: updated existing CrawlerTask to taskId=${AMAZON_TASK_ID}`);
      } else {
        if (!dryRun) {
          task = await prisma.crawlerTask.create({
            data: {
              userId,
              source: 'amazon',
              taskId: AMAZON_TASK_ID,
              title: AMAZON_TEMPLATE.title,
              description: AMAZON_TEMPLATE.description,
            },
          });
        } else {
          task = { id: null, taskId: AMAZON_TASK_ID, title: AMAZON_TEMPLATE.title };
        }
        createdTasks += 1;
        log(`User ${userId}: created CrawlerTask with taskId=${AMAZON_TASK_ID}`);
      }
    }

    if (!task || (task.id == null && !dryRun)) continue;
    if (dryRun && task.id == null) {
      updatedData += userAmazonData.length;
      continue;
    }

    // 3. Point all this user's Amazon CrawlerData to the canonical task
    const needUpdate = userAmazonData.filter((d) => d.taskId !== task.id);
    if (needUpdate.length === 0) {
      log(`User ${userId}: all Amazon data already linked to canonical task.`);
      continue;
    }

    if (!dryRun) {
      await prisma.crawlerData.updateMany({
        where: {
          userId,
          source: 'amazon',
        },
        data: { taskId: task.id, updatedAt: new Date() },
      });
    }
    updatedData += needUpdate.length;
    log(`User ${userId}: (re)linked ${needUpdate.length} Amazon record(s) to task ${task.id}.`);
  }

  // 4. Recompute recordCount for affected CrawlerTasks
  if (!dryRun && (updatedData > 0 || updatedTasks > 0 || createdTasks > 0)) {
    const tasksToRecount = await prisma.crawlerTask.findMany({
      where: { source: 'amazon', taskId: AMAZON_TASK_ID },
      select: { id: true },
    });
    for (const t of tasksToRecount) {
      const count = await prisma.crawlerData.count({
        where: { taskId: t.id },
      });
      await prisma.crawlerTask.update({
        where: { id: t.id },
        data: { recordCount: count, updatedAt: new Date() },
      });
      log(`Task ${t.id}: recordCount set to ${count}.`);
    }
  }

  log(
    `Done. Updated CrawlerData links: ${updatedData}, CrawlerTasks updated: ${updatedTasks}, created: ${createdTasks}.`
  );
  if (dryRun) log('Re-run without DRY_RUN=1 to apply changes.');
}

backfillAmazonTaskId()
  .catch((e) => {
    console.error('[backfill-amazon]', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
