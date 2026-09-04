const prisma = require('../utils/prisma');
const { BUYER_LICENCE_VERSION } = require('../constants/buyerLicence');

async function stampBuyerLicence({ purchaseId, orderId, buyerId }) {
  const now = new Date();
  const data = { licenceAcceptedAt: now, licenceVersion: BUYER_LICENCE_VERSION };

  if (purchaseId) {
    const purchase = await prisma.dataNFTPurchase.findFirst({
      where: { id: purchaseId, buyerId },
    });
    if (!purchase) return null;
    await prisma.dataNFTPurchase.update({ where: { id: purchase.id }, data });
    await prisma.purchaseOrder.updateMany({
      where: { purchaseId: purchase.id, buyerId },
      data,
    });
    return { purchaseId: purchase.id, ...data };
  }

  if (orderId) {
    const order = await prisma.purchaseOrder.findFirst({
      where: { id: orderId, buyerId },
    });
    if (!order) return null;
    await prisma.purchaseOrder.update({ where: { id: order.id }, data });
    if (order.purchaseId) {
      await prisma.dataNFTPurchase.updateMany({
        where: { id: order.purchaseId, buyerId },
        data,
      });
    }
    return { orderId: order.id, purchaseId: order.purchaseId, ...data };
  }

  return null;
}

module.exports = { stampBuyerLicence };
