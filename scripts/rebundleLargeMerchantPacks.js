/**
 * Merge existing uploaded merchant-table listings into a few large Official packs.
 * Does not invent rows. Safe to re-run (same rebundleBatch).
 *
 *   node scripts/rebundleLargeMerchantPacks.js --dry-run
 *   node scripts/rebundleLargeMerchantPacks.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const {
  asRecords,
  emailFieldName,
  rowFingerprint,
} = require('../src/utils/packRecords');

const prisma = new PrismaClient();

const BATCH = 'merchant-atlas-2026-09-05';
const SELLER_EMAIL = 'official@datadance.io';
const SELLER_NAME = 'DataDance Official';

const ATLASES = [
  {
    key: 'na',
    regions: ['North America'],
    name: 'North America Merchant Atlas',
    image: '/data-pack/Electronics Data Pack.svg',
    blurb: 'Checkout rows from the uploaded North America merchant table.',
  },
  {
    key: 'eu',
    regions: ['Europe'],
    name: 'Europe Merchant Atlas',
    image: '/data-pack/Fashion & Apparel Data Pack.svg',
    blurb: 'Checkout rows from the uploaded Europe merchant table.',
  },
  {
    key: 'asia',
    regions: ['Asia'],
    name: 'Asia Merchant Atlas',
    image: '/data-pack/Beauty & Personal Care Data Pack.svg',
    blurb: 'Checkout rows from the uploaded Asia merchant table.',
  },
  {
    key: 'me',
    regions: ['Middle East'],
    name: 'Gulf & Levant Merchant Atlas',
    image: '/data-pack/Automotive Data Pack.svg',
    blurb: 'Checkout rows from the uploaded Gulf and Levant merchant table.',
  },
  {
    key: 'row',
    regions: ['Other', 'Oceania'],
    name: 'Rest of World Merchant Atlas',
    image: '/data-pack/Other Data Pack.svg',
    blurb: 'Checkout rows from the uploaded rest-of-world merchant table (Oceania and unassigned geo).',
  },
];

function parseArgs() {
  return { dryRun: process.argv.includes('--dry-run') };
}

function recordCount(dataRecords) {
  const rec = dataRecords && typeof dataRecords === 'object' ? dataRecords : {};
  if (typeof rec.recordCount === 'number') return rec.recordCount;
  return asRecords(dataRecords).length;
}

function isTrialPack(pack) {
  const name = String(pack.name || '');
  const count = recordCount(pack.dataRecords);
  if (/sample cut/i.test(name)) return true;
  return count < 20 && Number(pack.price) <= 50;
}

function isAtlasPack(pack) {
  const rec = pack.dataRecords && typeof pack.dataRecords === 'object' ? pack.dataRecords : {};
  return rec.rebundleBatch === BATCH;
}

function priceForCount(count) {
  if (count >= 100000) return 4900;
  if (count >= 50000) return 2650;
  if (count >= 20000) return 1490;
  if (count >= 10000) return 1290;
  return 890;
}

function describePack(atlas, count) {
  return [
    `${atlas.blurb} ${count.toLocaleString()} records. Published by ${SELLER_NAME}.`,
    'Prove a known email is in this pack — we answer yes or no, and do not list other addresses.',
  ].join(' ');
}

function mergeRecords(packs) {
  const headers = [];
  const seenHeaders = new Set();
  const records = [];
  const seen = new Set();
  let emailField = 'email';
  const sourceIds = [];

  for (const pack of packs) {
    const rec = pack.dataRecords && typeof pack.dataRecords === 'object' ? pack.dataRecords : {};
    emailField = rec.emailField || emailField;
    sourceIds.push(pack.id);
    for (const header of rec.headers || []) {
      if (!seenHeaders.has(header)) {
        seenHeaders.add(header);
        headers.push(header);
      }
    }
    for (const row of asRecords(rec)) {
      const fingerprint = rowFingerprint(row, emailFieldName(rec));
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      records.push(row);
    }
  }

  records.forEach((row, index) => {
    if (row && typeof row === 'object' && row.recordId == null) {
      row.recordId = index + 1;
    }
  });

  return {
    source: BATCH,
    fileName: `${BATCH}.json`,
    importDate: new Date().toISOString(),
    recordCount: records.length,
    totalRecords: records.length,
    skippedRecords: 0,
    headers: headers.length ? headers : Object.keys(records[0] || {}),
    emailField,
    rebundleBatch: BATCH,
    sourcePackIds: sourceIds,
    records,
  };
}

async function ensureOfficial() {
  let user = await prisma.user.findFirst({
    where: { email: SELLER_EMAIL },
  });
  if (!user) {
    throw new Error(`Missing ${SELLER_EMAIL}`);
  }
  if (user.name !== SELLER_NAME) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { name: SELLER_NAME, isOrganization: true, userType: 'organization' },
    });
  }
  return user;
}

async function ensureTags() {
  const names = ['Data Pack', 'Merchant Atlas'];
  const tags = [];
  for (const name of names) {
    const existing = await prisma.tag.findFirst({ where: { name } });
    tags.push(existing || await prisma.tag.create({ data: { name } }));
  }
  return tags;
}

async function main() {
  const { dryRun } = parseArgs();
  const official = await ensureOfficial();
  const tags = dryRun ? [] : await ensureTags();

  const packs = await prisma.dataNFT.findMany({
    where: { dataSource: 'upload' },
    select: {
      id: true,
      name: true,
      price: true,
      isPublished: true,
      merchantId: true,
      dataRecords: true,
    },
  });

  const sources = packs.filter((pack) => !isAtlasPack(pack) && !isTrialPack(pack));
  const trials = packs.filter((pack) => isTrialPack(pack));
  const existingAtlas = packs.filter((pack) => isAtlasPack(pack));

  const byRegion = new Map();
  for (const pack of sources) {
    const rec = pack.dataRecords && typeof pack.dataRecords === 'object' ? pack.dataRecords : {};
    const region = rec.region || 'Other';
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(pack);
  }

  const plan = [];
  for (const atlas of ATLASES) {
    const group = atlas.regions.flatMap((region) => byRegion.get(region) || []);
    const merged = mergeRecords(group);
    plan.push({
      atlas,
      sourceCount: group.length,
      count: merged.recordCount,
      price: priceForCount(merged.recordCount),
      existing: existingAtlas.find((pack) => {
        const rec = pack.dataRecords && typeof pack.dataRecords === 'object' ? pack.dataRecords : {};
        return rec.atlasKey === atlas.key || pack.name === atlas.name;
      }),
      dataRecords: { ...merged, region: atlas.regions[0], atlasKey: atlas.key },
    });
  }

  console.log(JSON.stringify({
    dryRun,
    seller: { name: official.name, email: official.email },
    sources: sources.length,
    trials: trials.length,
    atlases: plan.map((item) => ({
      name: item.atlas.name,
      count: item.count,
      price: item.price,
      sources: item.sourceCount,
      existingId: item.existing?.id || null,
    })),
  }, null, 2));

  if (dryRun) {
    await prisma.$disconnect();
    return;
  }

  for (const item of plan) {
    if (!item.count) {
      console.log('skip empty', item.atlas.name);
      continue;
    }
    const payload = {
      name: item.atlas.name,
      description: describePack(item.atlas, item.count),
      price: item.price,
      image: item.atlas.image,
      merchantId: official.id,
      dataSource: 'upload',
      dataRecords: item.dataRecords,
      isPublished: true,
      maxSales: 999,
    };
    if (item.existing) {
      await prisma.dataNFT.update({
        where: { id: item.existing.id },
        data: {
          ...payload,
          tags: { set: tags.map((tag) => ({ id: tag.id })) },
        },
      });
      console.log('updated', item.atlas.name, item.count, item.price);
    } else {
      await prisma.dataNFT.create({
        data: {
          ...payload,
          tags: { connect: tags.map((tag) => ({ id: tag.id })) },
        },
      });
      console.log('created', item.atlas.name, item.count, item.price);
    }
  }

  const unpublishIds = sources.filter((pack) => pack.isPublished).map((pack) => pack.id);
  if (unpublishIds.length) {
    const result = await prisma.dataNFT.updateMany({
      where: { id: { in: unpublishIds } },
      data: { isPublished: false },
    });
    console.log('unpublished', result.count);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  prisma.$disconnect().finally(() => process.exit(1));
});
