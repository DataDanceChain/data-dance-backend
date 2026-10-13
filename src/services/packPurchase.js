const prisma = require('../utils/prisma');
const commerceService = require('./commerceService');
const { assertPackHasLicensableRecords } = require('./dataLicenceConsent');

const SUBJECT_CONSENT_ERROR = 'This pack can only include records from people who granted consent in the Wallet app.';

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** A transaction-scoped lock on one buyer's USD balance (released when the transaction ends). */
async function lockBuyerBalance(tx, buyerId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ddc:org-balance'), hashtext(${String(buyerId)}))`;
}

/** The buyer's USD balance: completed deposits minus completed withdrawals. */
async function usdBalance(db, buyerId) {
  const [depositSum, withdrawSum] = await Promise.all([
    db.organizationTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: buyerId, type: 'DEPOSIT', status: 'COMPLETED' },
    }),
    db.organizationTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: buyerId, type: 'WITHDRAW', status: 'COMPLETED' },
    }),
  ]);
  return (depositSum._sum.amount || 0) - (withdrawSum._sum.amount || 0);
}

/**
 * Buy a published pack from the buyer's USD balance. `inTransaction(tx, { purchase, commerce,
 * totalAmount })` runs inside the purchase transaction (a throw rolls the purchase back); its
 * result is returned as `inTransactionResult`.
 */
async function purchasePublishedPack({ buyerId, dataNFTId, quantity = 1, metadata = {}, inTransaction }) {
  const qty = Math.max(1, Number(quantity) || 1);
  const dataNFT = await prisma.dataNFT.findUnique({
    where: { id: dataNFTId },
    include: { merchant: true },
  });
  if (!dataNFT) {
    throw httpError(404, 'pack_not_found', 'DataNFT not found');
  }
  if (!dataNFT.isPublished) {
    throw httpError(400, 'pack_not_published', 'DataNFT is not published');
  }

  const licence = await assertPackHasLicensableRecords(dataNFT);
  if (!licence.ok) {
    throw httpError(403, 'subject_consent_required', SUBJECT_CONSENT_ERROR);
  }
  if (dataNFT.merchantId === buyerId) {
    throw httpError(403, 'own_pack', 'Cannot purchase your own DataNFT');
  }

  const purchaseCount = await prisma.dataNFTPurchase.count({
    where: { dataNFTId, buyerId },
  });
  const totalAmount = dataNFT.price * qty;
  const buyer = await prisma.user.findUnique({
    where: { id: buyerId },
    select: { id: true, email: true, isOrganization: true, userType: true },
  });
  const isOrgBuyer = Boolean(buyer && (buyer.isOrganization || buyer.userType === 'organization'));
  if (!isOrgBuyer) {
    throw httpError(403, 'org_buyer_required', 'Only a merchant account can buy a dataset licence.');
  }

  const result = await prisma.$transaction(async (tx) => {
    // The balance is read and spent under a per-buyer lock inside this transaction: two purchases
    // (or data-request fulfilments) for the same buyer at once run one after the other, and the
    // second sees the first one's withdrawal, so together they can never overdraw the balance.
    await lockBuyerBalance(tx, buyerId);
    if ((await usdBalance(tx, buyerId)) < totalAmount) {
      throw httpError(400, 'insufficient_balance', 'Insufficient balance to complete this purchase.');
    }

    const purchase = await tx.dataNFTPurchase.create({
      data: { dataNFTId, buyerId, quantity: qty },
      include: { dataNFT: { include: { snapshots: true, tags: true } } },
    });

    await tx.organizationTransaction.create({
      data: {
        amount: totalAmount,
        type: 'DEPOSIT',
        status: 'COMPLETED',
        description: `DataNFT sale: ${dataNFT.name} (Purchase #${purchaseCount + 1}, quantity: ${qty})`,
        userId: dataNFT.merchantId,
        metadata: {
          dataNFTId: dataNFT.id,
          buyerId,
          purchaseCount: purchaseCount + 1,
          quantity: qty,
          ...metadata,
        },
      },
    });

    const buyerTransaction = await tx.organizationTransaction.create({
      data: {
        amount: totalAmount,
        type: 'WITHDRAW',
        status: 'COMPLETED',
        description: `Purchase DataNFT: ${dataNFT.name} (Purchase #${purchaseCount + 1}, quantity: ${qty})`,
        userId: buyerId,
        metadata: {
          dataNFTId: dataNFT.id,
          merchantId: dataNFT.merchantId,
          purchaseCount: purchaseCount + 1,
          quantity: qty,
          ...metadata,
        },
      },
    });

    const commerce = await commerceService.createOrderFromPurchase(tx, {
      buyerId,
      sellerId: dataNFT.merchantId,
      dataNFT,
      purchase,
      quantity: qty,
      totalAmount,
      paidFromBalance: true,
      organizationTransactionId: buyerTransaction.id,
    });

    const inTransactionResult = inTransaction
      ? await inTransaction(tx, { purchase, commerce, totalAmount })
      : undefined;
    return { purchase, commerce, inTransactionResult };
  });

  const commerceAttest = require('./commerceAttest');
  const attestation = result.commerce?.order?.id
    ? await commerceAttest.attestPaidOrderSafe(result.commerce.order.id)
    : null;
  const publicView = commerceAttest.publicAttestation(attestation || result.commerce?.order);
  const order = result.commerce.order
    ? { ...commerceAttest.omitAttestationPayload(result.commerce.order), ...publicView }
    : result.commerce.order;

  return {
    purchase: result.purchase,
    commerce: result.commerce,
    order,
    invoice: result.commerce.invoice,
    payment: result.commerce.payment,
    attestation: publicView,
    quantity: qty,
    purchaseCount: purchaseCount + 1,
    totalAmount,
    packPrice: dataNFT.price,
    inTransactionResult: result.inTransactionResult,
  };
}

module.exports = {
  SUBJECT_CONSENT_ERROR,
  purchasePublishedPack,
};
