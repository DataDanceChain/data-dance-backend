/**
 * Import published Data Pack snapshots into the current database.
 *
 * The JSON is produced from production (or any env) and is not committed.
 * Users are upserted by email — the same identity used by Wallet login.
 *
 *   node scripts/importPublishedDataPacks.js --file /tmp/dd-packs.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { generateReferralCode } = require('../src/utils/referralUtils');

const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { file: '', dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--file' && args[i + 1]) options.file = path.resolve(args[++i]);
    else if (args[i] === '--dry-run') options.dryRun = true;
  }
  return options;
}

function normalizeEmail(value) {
  if (!value || typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.includes('@') ? email : null;
}

function emailsFromPack(pack) {
  const records = pack.dataRecords || {};
  const field = records.emailField || 'email';
  const rows = Array.isArray(records.records) ? records.records : [];
  const emails = new Set();
  for (const row of rows) {
    const email = normalizeEmail(row.email || row[field] || row['buyer-email']);
    if (email) emails.add(email);
  }
  return [...emails];
}

function nameFromEmail(email) {
  return (email.split('@')[0] || 'user').slice(0, 80);
}

async function ensureMerchant(email, name) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      name: name || email,
      authType: 'traditional',
      userType: 'organization',
      isOrganization: true,
      referralCode: generateReferralCode(),
      profile: { create: { language: 'en' } },
    },
  });
}

async function ensureUsers(emails) {
  const existing = new Set();
  for (let i = 0; i < emails.length; i += 1000) {
    const chunk = emails.slice(i, i + 1000);
    const rows = await prisma.user.findMany({
      where: { email: { in: chunk } },
      select: { email: true },
    });
    for (const row of rows) existing.add(row.email.toLowerCase());
  }
  const toCreate = emails.filter((email) => !existing.has(email));
  const now = new Date();
  for (let i = 0; i < toCreate.length; i += 500) {
    const chunk = toCreate.slice(i, i + 500);
    const codes = new Set();
    while (codes.size < chunk.length) codes.add(generateReferralCode());
    const referralCodes = [...codes];
    await prisma.user.createMany({
      data: chunk.map((email, index) => ({
        email,
        name: nameFromEmail(email),
        authType: 'web3auth',
        userType: 'regular',
        isOrganization: false,
        referralCode: referralCodes[index],
        walletAddress: null,
        createdAt: now,
        updatedAt: now,
      })),
      skipDuplicates: true,
    });
    const created = await prisma.user.findMany({
      where: { email: { in: chunk } },
      select: { id: true },
    });
    const haveProfile = new Set(
      (await prisma.userProfile.findMany({
        where: { userId: { in: created.map((row) => row.id) } },
        select: { userId: true },
      })).map((row) => row.userId),
    );
    const profiles = created
      .filter((row) => !haveProfile.has(row.id))
      .map((row) => ({ userId: row.id, language: 'en', createdAt: now, updatedAt: now }));
    if (profiles.length) {
      await prisma.userProfile.createMany({ data: profiles, skipDuplicates: true });
    }
  }
  return { existing: existing.size, created: toCreate.length };
}

function loadPacks(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (raw.startsWith('[')) return JSON.parse(raw);
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function importPack(pack, dryRun) {
  const merchantEmail = normalizeEmail(pack.merchantEmail);
  if (!merchantEmail) throw new Error(`Pack ${pack.name} is missing merchantEmail`);
  const emails = emailsFromPack(pack);
  console.log(`  ${pack.name}: ${emails.length} emails, merchant ${merchantEmail}`);
  if (dryRun) return;

  const merchant = await ensureMerchant(merchantEmail, pack.merchantName);
  const users = await ensureUsers(emails);
  const existing = await prisma.dataNFT.findFirst({
    where: { name: pack.name, merchantId: merchant.id, dataSource: 'upload' },
  });
  const payload = {
    description: pack.description || null,
    price: Number(pack.price || 0),
    image: pack.image || null,
    dataSource: 'upload',
    dataRecords: pack.dataRecords,
    isPublished: true,
    maxSales: pack.maxSales || 999999,
  };
  if (existing) {
    await prisma.dataNFT.update({ where: { id: existing.id }, data: payload });
  } else {
    await prisma.dataNFT.create({
      data: { name: pack.name, merchantId: merchant.id, ...payload },
    });
  }
  return users;
}

async function main() {
  const options = parseArgs();
  if (!options.file) throw new Error('Usage: node scripts/importPublishedDataPacks.js --file /tmp/dd-packs.json');
  const packs = loadPacks(options.file);
  console.log(`Import ${packs.length} data pack(s)${options.dryRun ? ' (dry run)' : ''}`);
  for (const pack of packs) {
    await importPack(pack, options.dryRun);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
