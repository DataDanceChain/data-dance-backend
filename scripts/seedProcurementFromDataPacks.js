/**
 * Build procurement deals from published Data Packs already in this database.
 *
 * Same script locally and on production:
 *   - buyer / seller are organization accounts
 *   - Users / costs come from pack emails (User.email, Wallet login key)
 *   - dataset bytes stay off-chain; order metadata can be attested
 *
 *   node scripts/seedProcurementFromDataPacks.js --dry-run
 *   node scripts/seedProcurementFromDataPacks.js --clear-demo-seed
 *   node scripts/seedProcurementFromDataPacks.js --name "Electronics Data Pack - North America"
 */

require('dotenv').config();
const crypto = require('crypto');
const prisma = require('../src/utils/prisma');
const { nextNumber } = require('../src/services/commerceService');
const { normalizeEmail, isValidEmail, maskEmail } = require('../src/utils/emailMask');

const SEED_TAG = '[pack-procurement]';
const DEMO_TAG = '[demo-seed]';
const DEFAULT_BUYER = 'test-buyer@datadance.io';
const UNIT_PRICE = 0.01;

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    clearDemoSeed: false,
    buyerEmail: DEFAULT_BUYER,
    names: [],
    limitUsers: 0,
    minRecords: 0,
    minPrice: 0,
    sellerEmail: '',
    replaceExisting: true,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--clear-demo-seed') options.clearDemoSeed = true;
    else if (arg === '--buyer-email' && args[i + 1]) options.buyerEmail = String(args[++i]).toLowerCase();
    else if (arg === '--name' && args[i + 1]) options.names.push(String(args[++i]));
    else if (arg === '--limit-users' && args[i + 1]) options.limitUsers = Math.max(0, parseInt(args[++i], 10) || 0);
    else if (arg === '--min-records' && args[i + 1]) options.minRecords = Math.max(0, parseInt(args[++i], 10) || 0);
    else if (arg === '--min-price' && args[i + 1]) options.minPrice = Math.max(0, Number(args[++i]) || 0);
    else if (arg === '--seller-email' && args[i + 1]) options.sellerEmail = String(args[++i]).toLowerCase();
    else if (arg === '--no-replace') options.replaceExisting = false;
  }
  return options;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function pointsFor(email) {
  const n = parseInt(sha256(email).slice(0, 6), 16);
  return 80 + (n % 141);
}

function emailsFromRecords(dataRecords) {
  const records = dataRecords || {};
  const field = records.emailField || 'email';
  const rows = Array.isArray(records.records) ? records.records : [];
  const emails = [];
  const seen = new Set();
  for (const row of rows) {
    const email = normalizeEmail(row.email || row[field] || row['buyer-email']);
    if (!email || !isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

async function deleteOrders(orderIds) {
  if (!orderIds.length) return 0;
  await prisma.pointsRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.procurementCostItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.procurementAllocation.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: orderIds } } });
  return orderIds.length;
}

async function clearTaggedOrders(tag) {
  const seeded = await prisma.purchaseOrder.findMany({
    where: { notes: { contains: tag } },
    select: { id: true },
  });
  return deleteOrders(seeded.map((row) => row.id));
}

async function clearOrdersForPacks(packIds, buyerId) {
  const seeded = await prisma.purchaseOrder.findMany({
    where: { dataNFTId: { in: packIds }, buyerId },
    select: { id: true },
  });
  return deleteOrders(seeded.map((row) => row.id));
}

function packCreatedAt(pack) {
  const imported = pack.dataRecords?.importDate;
  const parsed = imported ? new Date(imported) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  return pack.createdAt || new Date();
}

function dealShape(recordCount, index, total) {
  if (recordCount >= 3000) {
    return { status: 'paid', invoiceStatus: 'paid', paymentStatus: 'confirmed', attest: true, paymentTerms: 'Due on receipt' };
  }
  if (recordCount >= 800) {
    return { status: 'invoiced', invoiceStatus: 'issued', paymentStatus: 'pending', attest: false, paymentTerms: 'Net 15' };
  }
  if (index >= total - 2) {
    return { status: 'confirmed', invoiceStatus: 'issued', paymentStatus: null, attest: false, paymentTerms: 'Net 30' };
  }
  return { status: 'invoiced', invoiceStatus: 'partial', paymentStatus: 'confirmed', attest: false, paymentTerms: 'Net 15' };
}

async function upsertEntity(user) {
  const fallback = {
    companyName: user.name || user.email,
    email: user.email,
    country: 'Singapore',
    currency: 'USD',
  };
  return prisma.legalEntity.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, ...fallback },
  });
}

async function requireOrg(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(user.isOrganization || user.userType === 'organization')) {
    throw new Error(`Missing organization account: ${email}`);
  }
  return user;
}

async function ensureBuyer(email, name, password) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!(existing.isOrganization || existing.userType === 'organization')) {
      throw new Error(`${email} exists but is not an organization`);
    }
    return existing;
  }
  const bcrypt = require('bcryptjs');
  const { generateReferralCode } = require('../src/utils/referralUtils');
  return prisma.user.create({
    data: {
      email,
      name,
      password: await bcrypt.hash(password, 10),
      authType: 'traditional',
      userType: 'organization',
      isOrganization: true,
      referralCode: generateReferralCode(),
      profile: { create: { language: 'en' } },
      legalEntity: {
        create: {
          companyName: name,
          taxId: 'SG-202401188B',
          address: '8 Marina View, #12-01, Singapore 018960',
          country: 'Singapore',
          email,
          bankName: 'DBS Bank',
          bankAccount: '072-884210-001',
          currency: 'USD',
        },
      },
    },
  });
}

async function loadUsersByEmail(emails) {
  const byEmail = new Map();
  for (let i = 0; i < emails.length; i += 1000) {
    const chunk = emails.slice(i, i + 1000);
    const rows = await prisma.user.findMany({
      where: { email: { in: chunk } },
      select: { id: true, email: true },
    });
    for (const row of rows) byEmail.set(row.email.toLowerCase(), row);
  }
  return byEmail;
}

async function referrerEmailsFor(userIds) {
  if (!userIds.length) return [];
  const found = new Map();
  for (let i = 0; i < userIds.length; i += 1000) {
    const chunk = userIds.slice(i, i + 1000);
    const rows = await prisma.referral.findMany({
      where: { inviteeId: { in: chunk } },
      include: { inviter: { select: { email: true, name: true, id: true } } },
    });
    for (const row of rows) {
      const email = normalizeEmail(row.inviter?.email);
      if (email) found.set(email, row.inviter);
    }
  }
  return [...found.entries()].map(([email, user]) => ({ email, user }));
}

function partySnapshot(entity, user) {
  return {
    userId: user.id,
    companyName: entity.companyName,
    taxId: entity.taxId || '',
    address: entity.address || '',
    country: entity.country || '',
    email: entity.email || user.email,
    bankName: entity.bankName || '',
    bankAccount: entity.bankAccount || '',
    currency: entity.currency || 'USD',
  };
}

async function attestOrder(orderId) {
  const full = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { lineItems: true, allocations: true },
  });
  const emailsHash = sha256(
    (full.allocations || []).map((row) => row.emailNormalized).sort().join('|'),
  );
  const payload = {
    type: 'datadance.procurement.metadata.v1',
    orderNumber: full.orderNumber,
    dataNFTId: full.dataNFTId,
    currency: full.currency,
    total: full.total,
    serviceFeeAmount: full.serviceFeeAmount || 0,
    allocationCount: full.allocations.filter((row) => row.kind === 'user').length,
    referralCount: full.allocations.filter((row) => row.kind === 'referral').length,
    allocationEmailsHash: emailsHash,
    datasetBytesExcluded: true,
    note: 'On-chain attestation stores order metadata only. The AI dataset itself is not written to the chain.',
    attestedAt: new Date().toISOString(),
  };
  return prisma.purchaseOrder.update({
    where: { id: full.id },
    data: {
      attestationPayload: payload,
      attestationHash: sha256(JSON.stringify(payload)),
      attestedAt: new Date(),
    },
  });
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

async function seedDeal({
  pack, buyer, seller, buyerEntity, sellerEntity, emails, limitUsers, shape, withRedeem, redeem,
}) {
  const category = pack.dataRecords?.category || 'dataset';
  const region = pack.dataRecords?.region || '';
  const selected = limitUsers ? emails.slice(0, limitUsers) : emails;
  const usersByEmail = await loadUsersByEmail(selected);
  const userIds = [...usersByEmail.values()].map((row) => row.id);
  const referrers = await referrerEmailsFor(userIds);

  const quantity = selected.length;
  const catalogPrice = Number(pack.price || 0);
  const unitPrice = catalogPrice > 0
    ? Number((catalogPrice / Math.max(quantity, 1)).toFixed(6))
    : 0.08;
  const lineTotal = catalogPrice > 0 ? catalogPrice : Number((quantity * unitPrice).toFixed(2));
  const serviceFeeAmount = Number((lineTotal * 0.08).toFixed(2));
  const createdAt = packCreatedAt(pack);
  const paidAt = addDays(createdAt, shape.paymentStatus === 'pending' ? 0 : 4);

  const order = await prisma.purchaseOrder.create({
    data: {
      orderNumber: nextNumber('PO'),
      buyerId: buyer.id,
      sellerId: seller.id,
      status: shape.status,
      currency: 'USD',
      subtotal: lineTotal,
      taxAmount: 0,
      total: lineTotal,
      paymentTerms: shape.paymentTerms,
      notes: `License for ${pack.name} contributor set.`,
      dataNFTId: pack.id,
      pointsUnitPriceUsd: UNIT_PRICE,
      serviceFeeAmount,
      contractStatus: 'none',
      createdAt,
      updatedAt: paidAt,
      lineItems: {
        create: [{
          description: `${pack.name}${region ? ` · ${region}` : ''} contributor license`,
          category,
          quantity,
          unit: 'records',
          unitPrice,
          total: lineTotal,
        }],
      },
    },
  });

  await prisma.invoice.create({
    data: {
      invoiceNumber: nextNumber('INV'),
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      status: shape.invoiceStatus,
      currency: 'USD',
      subtotal: lineTotal,
      taxAmount: 0,
      total: lineTotal,
      paymentTerms: shape.paymentTerms,
      issueDate: createdAt,
      paidAt: shape.invoiceStatus === 'paid' ? paidAt : null,
      sellerSnapshot: partySnapshot(sellerEntity, seller),
      buyerSnapshot: partySnapshot(buyerEntity, buyer),
      createdAt,
      updatedAt: paidAt,
    },
  });

  if (shape.paymentStatus) {
    const paidAmount = shape.invoiceStatus === 'partial' ? Number((lineTotal * 0.4).toFixed(2)) : lineTotal;
    await prisma.payment.create({
      data: {
        paymentNumber: nextNumber('PAY'),
        orderId: order.id,
        payerId: buyer.id,
        payeeId: seller.id,
        amount: paidAmount,
        currency: 'USD',
        method: 'bank_transfer',
        status: shape.paymentStatus,
        matchStatus: shape.paymentStatus === 'confirmed' ? (shape.invoiceStatus === 'partial' ? 'partial' : 'matched') : 'unmatched',
        paidAt: shape.paymentStatus === 'confirmed' ? paidAt : null,
        reference: `TT-${createdAt.getFullYear()}${String(createdAt.getMonth() + 1).padStart(2, '0')}-${order.orderNumber.slice(-4)}`,
        notes: `Wire for ${pack.name}`,
        createdAt: addDays(createdAt, 2),
        updatedAt: paidAt,
      },
    });
  }

  const allocationRows = selected.map((email) => {
    const user = usersByEmail.get(email);
    return {
      orderId: order.id,
      kind: 'user',
      email,
      emailNormalized: email,
      displayName: email.split('@')[0],
      role: 'data_contributor',
      points: pointsFor(email),
      userId: user?.id || null,
      claimStatus: user ? 'claimable' : 'reserved',
      note: null,
    };
  });
  for (const row of referrers) {
    allocationRows.push({
      orderId: order.id,
      kind: 'referral',
      email: row.email,
      emailNormalized: row.email,
      displayName: row.user.name || row.email.split('@')[0],
      role: 'referrer',
      points: Math.max(40, Math.round(pointsFor(row.email) * 0.2)),
      userId: row.user.id,
      claimStatus: 'claimable',
      note: null,
    });
  }

  for (let i = 0; i < allocationRows.length; i += 500) {
    await prisma.procurementAllocation.createMany({ data: allocationRows.slice(i, i + 500) });
  }

  const userPoints = allocationRows.filter((row) => row.kind === 'user').reduce((sum, row) => sum + row.points, 0);
  const referralPoints = allocationRows.filter((row) => row.kind === 'referral').reduce((sum, row) => sum + row.points, 0);
  if (userPoints) {
    await prisma.procurementCostItem.create({
      data: {
        orderId: order.id,
        kind: 'points_issue',
        description: `User points reserved for ${allocationRows.filter((row) => row.kind === 'user').length} pack contributors`,
        points: userPoints,
        unitPriceUsd: UNIT_PRICE,
        amountUsd: Number((userPoints * UNIT_PRICE).toFixed(4)),
        sourceType: 'pack_allocation',
        sourceId: pack.id,
      },
    });
  }
  if (referralPoints) {
    await prisma.procurementCostItem.create({
      data: {
        orderId: order.id,
        kind: 'points_issue',
        description: `Referral points reserved for ${referrers.length} referrers`,
        points: referralPoints,
        unitPriceUsd: UNIT_PRICE,
        amountUsd: Number((referralPoints * UNIT_PRICE).toFixed(4)),
        sourceType: 'pack_referral',
        sourceId: pack.id,
      },
    });
  }

  if (withRedeem && redeem) {
    const redemption = await prisma.pointsRedemption.create({
      data: {
        orderId: order.id,
        createdById: seller.id,
        email: redeem.email,
        emailNormalized: redeem.email,
        userId: usersByEmail.get(redeem.email)?.id || null,
        points: redeem.points,
        asset: 'USDT',
        amount: redeem.amount,
        vendor: redeem.vendor,
        vendorReference: redeem.reference,
        status: 'paid',
        paidAt: addDays(createdAt, 18),
        notes: 'Settled through payout vendor; not a direct user transfer.',
      },
    });
    await prisma.procurementCostItem.create({
      data: {
        orderId: order.id,
        kind: 'points_redeem',
        description: `USDT payout via ${redeem.vendor} (${maskEmail(redeem.email)})`,
        points: redeem.points,
        unitPriceUsd: Number((redeem.amount / redeem.points).toFixed(6)),
        amountUsd: redeem.amount,
        sourceType: 'redemption',
        sourceId: redemption.id,
      },
    });
  }

  if (shape.attest) {
    await attestOrder(order.id);
  }
  return {
    orderNumber: order.orderNumber,
    status: shape.status,
    users: allocationRows.filter((row) => row.kind === 'user').length,
    referrals: referrers.length,
    missingUsers: selected.filter((email) => !usersByEmail.has(email)).length,
    redeemed: Boolean(withRedeem),
    attested: Boolean(shape.attest),
  };
}

async function main() {
  const options = parseArgs();
  const buyerPassword = process.env.PROCUREMENT_BUYER_PASSWORD || '';
  const buyer = buyerPassword
    ? await ensureBuyer(options.buyerEmail, process.env.PROCUREMENT_BUYER_NAME || 'Helios Applied Research Ltd', buyerPassword)
    : await requireOrg(options.buyerEmail);
  await prisma.commerceSettings.upsert({
    where: { id: 'default' },
    update: { pointsUnitPriceUsd: UNIT_PRICE },
    create: { id: 'default', pointsUnitPriceUsd: UNIT_PRICE },
  });

  const where = {
    dataSource: 'upload',
    isPublished: true,
    ...(options.names.length ? { name: { in: options.names } } : {}),
  };
  let packs = await prisma.dataNFT.findMany({
    where,
    include: { merchant: true },
    orderBy: { createdAt: 'asc' },
  });
  packs = packs.filter((pack) => {
    const emails = emailsFromRecords(pack.dataRecords);
    if (emails.length < options.minRecords) return false;
    if (Number(pack.price || 0) < options.minPrice) return false;
    if (options.sellerEmail && normalizeEmail(pack.merchant?.email) !== options.sellerEmail) return false;
    return true;
  }).sort((a, b) => emailsFromRecords(b.dataRecords).length - emailsFromRecords(a.dataRecords).length);
  if (!packs.length) {
    throw new Error('No published upload Data Packs found. Import packs first, or pass --name.');
  }

  const redeemVendors = [
    { vendor: 'Circle payout desk', amount: 20, points: 2000 },
    { vendor: 'Copper settlement', amount: 12, points: 1200 },
    { vendor: 'Fireblocks off-ramp', amount: 8, points: 800 },
  ];

  console.log(`Buyer ${buyer.email}`);
  console.log(`Packs ${packs.length}${options.dryRun ? ' (dry run)' : ''}`);
  for (const pack of packs) {
    const emails = emailsFromRecords(pack.dataRecords);
    console.log(`  ${pack.name}: ${emails.length} emails, seller ${pack.merchant.email}, price ${pack.price}`);
  }
  if (options.dryRun) return;

  if (options.replaceExisting) {
    const cleared = await clearOrdersForPacks(packs.map((pack) => pack.id), buyer.id);
    console.log(`Replaced ${cleared} existing pack deals`);
  }
  if (options.clearDemoSeed) {
    console.log(`Cleared demo deals ${await clearTaggedOrders(DEMO_TAG)}`);
  }

  for (const [index, pack] of packs.entries()) {
    if (!pack.merchant || pack.merchant.id === buyer.id) {
      console.warn(`Skip ${pack.name}: seller missing or same as buyer`);
      continue;
    }
    const emails = emailsFromRecords(pack.dataRecords);
    if (!emails.length) {
      console.warn(`Skip ${pack.name}: no emails in dataRecords`);
      continue;
    }
    const shape = dealShape(emails.length, index, packs.length);
    const redeemSpec = shape.status === 'paid' && index < redeemVendors.length
      ? {
        ...redeemVendors[index],
        email: emails[17] || emails[0],
        reference: `USDT-${pack.dataRecords?.category || 'PACK'}-${index + 1}`,
      }
      : null;
    const [buyerEntity, sellerEntity] = await Promise.all([
      upsertEntity(buyer),
      upsertEntity(pack.merchant),
    ]);
    const result = await seedDeal({
      pack,
      buyer,
      seller: pack.merchant,
      buyerEntity,
      sellerEntity,
      emails,
      limitUsers: options.limitUsers,
      shape,
      withRedeem: Boolean(redeemSpec),
      redeem: redeemSpec,
    });
    console.log(`  ${result.orderNumber} ${result.status} users=${result.users} refs=${result.referrals} redeem=${result.redeemed} attest=${result.attested}`);
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
