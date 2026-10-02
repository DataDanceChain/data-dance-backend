/**
 * Send CommerceAttester receipts for the 2026 revenue-book purchase orders.
 *
 * The seed stores a short local checksum. This script replaces that with the
 * canonical procurement metadata hash, then calls attest(bytes32). Emails and
 * dataset bytes stay off chain; allocations contribute only a hash of the
 * normalized emails.
 *
 * Idempotent: an order that already has a real transaction hash and a
 * canonical payload is left alone. Run inside the API container so the
 * backend wallet and RPC env are the ones the server uses.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../src/utils/prisma');
const procurement = require('../src/services/procurementService');

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function isCanonicalPayload(payload) {
  return Boolean(payload && payload.type === 'datadance.procurement.metadata.v1' && payload.allocationEmailsHash);
}

async function main() {
  const orders = await prisma.purchaseOrder.findMany({
    where: { orderNumber: { startsWith: 'PO-RB-' } },
    select: {
      id: true,
      orderNumber: true,
      sellerId: true,
      attestationTxHash: true,
      attestationPayload: true,
    },
    orderBy: { orderNumber: 'asc' },
  });

  let sent = 0;
  let skipped = 0;
  let pending = 0;

  for (const order of orders) {
    const alreadyOnChain = TX_HASH.test(String(order.attestationTxHash || ''));
    if (alreadyOnChain && isCanonicalPayload(order.attestationPayload)) {
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

    const result = await procurement.attestOrder({ id: order.sellerId }, order.id);
    const txHash = String(result.attestationTxHash || '');
    if (TX_HASH.test(txHash)) {
      sent += 1;
      console.log(`ok ${order.orderNumber} ${txHash}`);
    } else {
      pending += 1;
      console.log(`pending ${order.orderNumber}`);
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
    // The process is exiting either way.
  }
  process.exit(1);
});
