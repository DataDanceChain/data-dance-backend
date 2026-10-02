/**
 * Turn each 2026 revenue-book purchase into a listed DataNFT the buyer actually bought.
 *
 * The procurement order, invoice, and payment stay as the commercial record.
 * This adds the market object My Data reads: a published upload pack whose rows
 * are the contributor uploads gathered for that order, plus a DataNFTPurchase
 * by the agency that paid. Emails stay on the user account. The pack table
 * carries the display name, source, and whether the row was in the sale.
 *
 * Idempotent: an order that already has dataNFTId and purchaseId is skipped.
 * Licence receipts are written by scripts/attestRevenueBookLicences.js.
 */
const prisma = require('../src/utils/prisma');

const LICENCE_VERSION = '2026-09-04';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const COVERS = {
  ECOM: [
    'p-na-elec.jpg', 'p-asia-elec.jpg', 'p-eu-elec.jpg', 'p-me-elec.jpg',
    'cover-orders.jpg', 'p-asia-atlas.jpg', 'p-gulf-atlas.jpg', 'p-ea-books.jpg',
    'p-eu-books.jpg', 'p-gcc-books.jpg',
  ],
  TRAVEL: [
    'p-eu-atlas.jpg', 'p-anz-well.jpg', 'p-asia-well.jpg', 'p-aunz-well.jpg',
    'p-mix-books.jpg', 'p-eu-home.jpg', 'p-x-home.jpg', 'anz-home.jpg',
  ],
  AUTO: [
    'p-europe-auto.jpg', 'p-asia-auto.jpg', 'p-eu-fashion.jpg', 'p-asia-fashion.jpg',
    'p-europe-beauty.jpg', 'p-asia-beauty.jpg',
  ],
  BUILD: [
    'p-eu-home.jpg', 'p-me-kids.jpg', 'p-eu-kids.jpg', 'p-asia-kids.jpg',
    'p-me-beauty.jpg', 'p-eu-atlas.jpg',
  ],
};

const LABELS = {
  ECOM: 'e-commerce orders',
  TRAVEL: 'hotel and travel orders',
  AUTO: 'automotive orders',
  BUILD: 'building materials orders',
};

function parseOrderNumber(orderNumber) {
  const match = /^PO-RB-(\d{4})(\d{2})-(ECOM|TRAVEL|AUTO|BUILD)(-2)?$/.exec(orderNumber);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const industry = match[3];
  const second = Boolean(match[4]);
  return { year, month, industry, second };
}

function packName(parsed) {
  const month = MONTHS[parsed.month - 1] || String(parsed.month);
  const label = LABELS[parsed.industry] || 'orders';
  const base = `${month} ${parsed.year} ${label}`;
  return parsed.second ? `${base} — second cut` : base;
}

function coverFor(industry, index) {
  const list = COVERS[industry] || COVERS.ECOM;
  return `/data-pack/covers/${list[index % list.length]}`;
}

function titleFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.title || payload.hotelName || payload.listingTitle || '').slice(0, 160);
}

function amountFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const price = payload.price;
  return price == null || price === '' ? '' : String(price);
}

async function rowsForOrder(orderId) {
  return prisma.$queryRaw`
    SELECT
      u.name AS "contributor",
      cd.source AS "source",
      cd.type AS "recordType",
      cd.timestamp AS "recordedAt",
      cd.metadata AS "metadata",
      cd.payload AS "payload"
    FROM "ProcurementAllocation" a
    JOIN "User" u ON u.id = a."userId"
    JOIN "CrawlerData" cd ON cd."userId" = a."userId"
    WHERE a."orderId" = ${orderId} AND a.kind = 'user'
    ORDER BY cd.timestamp ASC
  `;
}

function toPackRecords(rows) {
  return rows.map((row) => {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const when = row.recordedAt instanceof Date ? row.recordedAt.toISOString().slice(0, 10) : String(row.recordedAt || '').slice(0, 10);
    return {
      contributor: row.contributor || '',
      source: row.source || '',
      recordType: row.recordType || '',
      recordedAt: when,
      inSale: meta.billable === false ? 'no' : 'yes',
      title: titleFromPayload(row.payload),
      amountUsd: amountFromPayload(row.payload),
    };
  });
}

async function main() {
  const orders = await prisma.purchaseOrder.findMany({
    where: { orderNumber: { startsWith: 'PO-RB-' } },
    select: {
      id: true,
      orderNumber: true,
      buyerId: true,
      sellerId: true,
      total: true,
      currency: true,
      createdAt: true,
      dataNFTId: true,
      purchaseId: true,
    },
    orderBy: { orderNumber: 'asc' },
  });

  let linked = 0;
  let skipped = 0;
  const coverIndex = { ECOM: 0, TRAVEL: 0, AUTO: 0, BUILD: 0 };

  for (const order of orders) {
    const parsed = parseOrderNumber(order.orderNumber);
    if (!parsed) {
      console.log(`skip-unparsed ${order.orderNumber}`);
      skipped += 1;
      continue;
    }
    if (order.dataNFTId && order.purchaseId) {
      console.log(`skip ${order.orderNumber}`);
      skipped += 1;
      continue;
    }

    const rawRows = await rowsForOrder(order.id);
    const records = toPackRecords(rawRows);
    const name = packName(parsed);
    const paidAt = order.createdAt;

    const dataNFT = await prisma.dataNFT.create({
      data: {
        name,
        description: `Contributor uploads gathered for ${order.orderNumber}. Each row is one record a person uploaded. Rows marked in the sale are the ones the buyer paid for.`,
        price: order.total,
        isPublished: true,
        maxSales: 1,
        currentSales: 1,
        merchantId: order.sellerId,
        image: coverFor(parsed.industry, coverIndex[parsed.industry]++),
        dataSource: 'upload',
        dataRecords: {
          recordCount: records.length,
          orderNumber: order.orderNumber,
          headers: ['contributor', 'source', 'recordType', 'recordedAt', 'inSale', 'title', 'amountUsd'],
          records,
        },
        createdAt: paidAt,
        updatedAt: paidAt,
      },
    });

    const purchase = await prisma.dataNFTPurchase.create({
      data: {
        dataNFTId: dataNFT.id,
        buyerId: order.buyerId,
        quantity: 1,
        licenceAcceptedAt: paidAt,
        licenceVersion: LICENCE_VERSION,
        createdAt: paidAt,
      },
    });

    await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        dataNFTId: dataNFT.id,
        purchaseId: purchase.id,
      },
    });

    linked += 1;
    console.log(`ok ${order.orderNumber} records=${records.length} nft=${dataNFT.id}`);
  }

  console.log(JSON.stringify({ orders: orders.length, linked, skipped }));
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error && error.message ? error.message : error);
  try {
    await prisma.$disconnect();
  } catch {
    // Exit either way.
  }
  process.exit(1);
});
