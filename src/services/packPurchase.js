const prisma = require('../utils/prisma');
const commerceService = require('./commerceService');
const { assertPackHasLicensableRecords } = require('./dataLicenceConsent');

const SUBJECT_CONSENT_ERROR = 'This pack can only include records from people who granted consent in the Wallet app.';

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

async function purchasePublishedPack({ buyerId, dataNFTId, quantity = 1, metadata = {} }) {
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

  const [depositSum, withdrawSum] = await Promise.all([
    prisma.organizationTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: buyerId, type: 'DEPOSIT', status: 'COMPLETED' },
    }),
    prisma.organizationTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: buyerId, type: 'WITHDRAW', status: 'COMPLETED' },
    }),
  ]);
  const balance = (depositSum._sum.amount || 0) - (withdrawSum._sum.amount || 0);
  if (balance < totalAmount) {
    throw httpError(400, 'insufficient_balance', 'Insufficient balance to complete this purchase.');
  }

  const result = await prisma.$transaction(async (tx) => {
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

    return { purchase, commerce };
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
  };
}

module.exports = {
  SUBJECT_CONSENT_ERROR,
  purchasePublishedPack,
};
