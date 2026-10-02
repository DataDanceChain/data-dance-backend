/**
 * Attest each 2026 revenue-book pack purchase the same way Buy Data does.
 *
 * The order already points at a published DataNFT and a DataNFTPurchase.
 * The earlier chain transaction hashed procurement metadata. This replaces
 * that local receipt with datadance.commerce.licence.v1 and sends attest(bytes32).
 * Dataset rows and emails stay off chain. A purchase that already has a
 * licence receipt and a real transaction hash is skipped.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../src/utils/prisma');
const { attestPaidOrder, isLicenceReceipt } = require('../src/services/commerceAttest');

const LICENCE_VERSION = '2026-09-04';
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

async function alignOrder(order) {
  const purchase = await prisma.dataNFTPurchase.findUnique({
    where: { id: order.purchaseId },
    select: { id: true, licenceAcceptedAt: true, licenceVersion: true, createdAt: true },
  });
  const acceptedAt = purchase?.licenceAcceptedAt || purchase?.createdAt || order.createdAt;
  if (!order.licenceAcceptedAt || order.licenceVersion !== LICENCE_VERSION) {
    await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        licenceAcceptedAt: acceptedAt,
        licenceVersion: LICENCE_VERSION,
      },
    });
  }

  const ledgers = await prisma.organizationTransaction.findMany({
    where: { userId: order.buyerId, type: 'WITHDRAW', status: 'COMPLETED' },
    select: { id: true, metadata: true },
  });
  for (const ledger of ledgers) {
    const meta = ledger.metadata && typeof ledger.metadata === 'object' ? ledger.metadata : {};
    if (meta.orderNumber !== order.orderNumber) continue;
    await prisma.organizationTransaction.update({
      where: { id: ledger.id },
      data: {
        metadata: {
          ...meta,
          dataNFTId: order.dataNFTId,
          purchaseId: order.purchaseId,
          merchantId: order.sellerId,
          quantity: 1,
        },
      },
    });
  }
}

async function main() {
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      orderNumber: { startsWith: 'PO-RB-' },
      dataNFTId: { not: null },
      purchaseId: { not: null },
    },
    select: {
      id: true,
      orderNumber: true,
      buyerId: true,
      sellerId: true,
      dataNFTId: true,
      purchaseId: true,
      createdAt: true,
      licenceAcceptedAt: true,
      licenceVersion: true,
      attestationTxHash: true,
      attestationPayload: true,
    },
    orderBy: { orderNumber: 'asc' },
  });

  let sent = 0;
  let skipped = 0;
  let pending = 0;

  for (const order of orders) {
    await alignOrder(order);
    const alreadyLicence = isLicenceReceipt(order.attestationPayload)
      && TX_HASH.test(String(order.attestationTxHash || ''));
    if (alreadyLicence) {
      skipped += 1;
      console.log(`skip ${order.orderNumber} ${order.attestationTxHash}`);
      continue;
    }

    await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        attestationPayload: Prisma.DbNull,
        attestationHash: null,
        attestationTxHash: null,
      },
    });

    const result = await attestPaidOrder(order.id);
    const txHash = String(result.attestationTxHash || '');
    if (TX_HASH.test(txHash) && result.attestationStatus === 'on_chain') {
      sent += 1;
      console.log(`ok ${order.orderNumber} ${txHash}`);
    } else {
      pending += 1;
      console.log(`pending ${order.orderNumber} ${result.chainReason || ''}`);
    }
  }

  console.log(JSON.stringify({ orders: orders.length, sent, skipped, pending }));
  await prisma.$disconnect();
  if (pending) process.exitCode = 1;
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
