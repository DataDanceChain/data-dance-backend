/**
 * Pre-create DDC accounts from data-pack emails (no wallet).
 *
 * Users can later claim these accounts by logging in with Web3Auth
 * using the same email; the wallet is bound on first login.
 *
 * Usage:
 *   node scripts/preCreateUsersFromDataPack.js --dry-run
 *   node scripts/preCreateUsersFromDataPack.js
 *   node scripts/preCreateUsersFromDataPack.js --file data-pack-4.csv --batch-size 1000
 *
 * Sources (merged, unique emails):
 *   - data-pack-4.csv (default)
 *   - cleaned-data/data-pack-1_cleaned.json
 *   - cleaned-data/data-pack-2_cleaned.json
 * Use --csv-only to skip the cleaned JSON packs.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { generateReferralCode } = require('../src/utils/referralUtils');

const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    csvOnly: false,
    file: path.join(__dirname, '../data-pack-4.csv'),
    batchSize: 500,
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
      options.batchSize = Math.max(1, parseInt(args[++i], 10) || 500);
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

function loadEmailsFromCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return new Set();

  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  const emailIdx = headers.findIndex((h) => {
    const key = h.toLowerCase();
    return key.includes('email') || key.includes('mail') || h.includes('邮箱');
  });
  if (emailIdx < 0) {
    throw new Error(`No email column found in ${filePath}. Headers: ${headers.join(', ')}`);
  }

  const emails = new Set();
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const email = normalizeEmail(values[emailIdx]);
    if (email) emails.add(email);
  }
  return emails;
}

function loadEmailsFromCleanedJson(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(data)) return new Set();

  const emails = new Set();
  for (const row of data) {
    const email = normalizeEmail(row['buyer-email'] || row.email || row['邮箱']);
    if (email) emails.add(email);
  }
  return emails;
}

function nameFromEmail(email) {
  const local = email.split('@')[0] || 'user';
  return local.slice(0, 80);
}

function uniqueReferralCodes(count) {
  const codes = new Set();
  while (codes.size < count) {
    codes.add(generateReferralCode());
  }
  return [...codes];
}

async function findExistingEmails(emails) {
  const existing = new Set();
  const batchSize = 1000;

  for (let i = 0; i < emails.length; i += batchSize) {
    const chunk = emails.slice(i, i + batchSize);
    const rows = await prisma.user.findMany({
      where: { email: { in: chunk } },
      select: { email: true },
    });
    for (const row of rows) {
      existing.add(row.email.toLowerCase());
    }
  }

  return existing;
}

async function createBatch(emails) {
  const referralCodes = uniqueReferralCodes(emails.length);
  const now = new Date();

  const users = emails.map((email, index) => ({
    email,
    name: nameFromEmail(email),
    authType: 'web3auth',
    userType: 'regular',
    isOrganization: false,
    referralCode: referralCodes[index],
    walletAddress: null,
    createdAt: now,
    updatedAt: now,
  }));

  await prisma.$transaction(async (tx) => {
    await tx.user.createMany({
      data: users,
      skipDuplicates: true,
    });

    const created = await tx.user.findMany({
      where: { email: { in: emails } },
      select: { id: true, email: true },
    });

    const existingProfiles = await tx.userProfile.findMany({
      where: { userId: { in: created.map((u) => u.id) } },
      select: { userId: true },
    });
    const hasProfile = new Set(existingProfiles.map((p) => p.userId));

    const profiles = created
      .filter((u) => !hasProfile.has(u.id))
      .map((u) => ({
        userId: u.id,
        language: 'en',
        createdAt: now,
        updatedAt: now,
      }));

    if (profiles.length > 0) {
      await tx.userProfile.createMany({
        data: profiles,
        skipDuplicates: true,
      });
    }
  });

  return emails.length;
}

async function main() {
  const options = parseArgs();
  const startedAt = Date.now();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Pre-create DDC users from data-pack emails');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'WRITE'}`);
  console.log(`CSV: ${options.file}`);
  console.log(`Batch size: ${options.batchSize}`);
  console.log(`Include cleaned JSON packs: ${!options.csvOnly}`);

  if (!fs.existsSync(options.file)) {
    throw new Error(`CSV not found: ${options.file}`);
  }

  const emailSet = loadEmailsFromCsv(options.file);
  console.log(`Emails from CSV: ${emailSet.size}`);

  if (!options.csvOnly) {
    const pack1 = loadEmailsFromCleanedJson(
      path.join(__dirname, '../cleaned-data/data-pack-1_cleaned.json')
    );
    const pack2 = loadEmailsFromCleanedJson(
      path.join(__dirname, '../cleaned-data/data-pack-2_cleaned.json')
    );
    for (const email of pack1) emailSet.add(email);
    for (const email of pack2) emailSet.add(email);
    console.log(`+ pack-1 unique: ${pack1.size}`);
    console.log(`+ pack-2 unique: ${pack2.size}`);
  }

  const allEmails = [...emailSet].sort();
  console.log(`Total unique emails: ${allEmails.length}`);

  const existing = await findExistingEmails(allEmails);
  const toCreate = allEmails.filter((email) => !existing.has(email));

  console.log(`Already in DB: ${existing.size}`);
  console.log(`To create: ${toCreate.length}`);

  if (options.dryRun) {
    console.log('\nDry run complete — no users were written.');
    console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
    return;
  }

  if (toCreate.length === 0) {
    console.log('\nNothing to create.');
    return;
  }

  let created = 0;
  for (let i = 0; i < toCreate.length; i += options.batchSize) {
    const batch = toCreate.slice(i, i + options.batchSize);
    try {
      await createBatch(batch);
      created += batch.length;
    } catch (error) {
      // Retry one-by-one for rare referralCode / race collisions.
      console.warn(
        `Batch ${i / options.batchSize + 1} failed (${error.code || error.message}), retrying row-by-row...`
      );
      for (const email of batch) {
        try {
          await prisma.user.create({
            data: {
              email,
              name: nameFromEmail(email),
              authType: 'web3auth',
              userType: 'regular',
              isOrganization: false,
              referralCode: generateReferralCode(),
              profile: { create: { language: 'en' } },
            },
          });
          created += 1;
        } catch (rowError) {
          if (rowError.code === 'P2002') {
            console.warn(`Skip duplicate: ${email}`);
          } else {
            console.error(`Failed ${email}:`, rowError.message);
          }
        }
      }
    }

    const done = Math.min(i + options.batchSize, toCreate.length);
    if (done % (options.batchSize * 5) === 0 || done === toCreate.length) {
      console.log(`Progress: ${done}/${toCreate.length} (${created} created)`);
    }
  }

  console.log('\nDone.');
  console.log(`Created: ${created}`);
  console.log(`Skipped existing: ${existing.size}`);
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
