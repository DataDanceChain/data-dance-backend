const path = require('path');
const commerceService = require('../services/commerceService');
const { getOrCreateInvoicePdf } = require('../services/invoicePdfService');
const prisma = require('../utils/prisma');

function sendError(res, error) {
  const status = error.statusCode || 500;
  return res.status(status).json({
    status: status >= 500 ? 'error' : 'fail',
    message: error.message || 'Server error',
  });
}

function publicFilePath(file, folder) {
  if (!file) return null;
  return `/assets/commerce/${folder}/${file.filename}`;
}

exports.getLegalEntity = async (req, res) => {
  try {
    const entity = await commerceService.getOrCreateLegalEntity(prisma, req.user);
    res.json({ status: 'success', data: entity });
  } catch (error) {
    sendError(res, error);
  }
};

exports.updateLegalEntity = async (req, res) => {
  try {
    const {
      companyName,
      taxId,
      address,
      country,
      email,
      bankName,
      bankAccount,
      currency,
    } = req.body;
    await commerceService.getOrCreateLegalEntity(prisma, req.user);
    const entity = await prisma.legalEntity.update({
      where: { userId: req.user.id },
      data: {
        ...(companyName !== undefined ? { companyName } : {}),
        ...(taxId !== undefined ? { taxId } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(country !== undefined ? { country } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(bankName !== undefined ? { bankName } : {}),
        ...(bankAccount !== undefined ? { bankAccount } : {}),
        ...(currency !== undefined ? { currency } : {}),
      },
    });
    res.json({ status: 'success', data: entity });
  } catch (error) {
    sendError(res, error);
  }
};

exports.listCounterparties = async (req, res) => {
  try {
    const data = await commerceService.listCounterparties(req.user.id);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.listOrders = async (req, res) => {
  try {
    const data = await commerceService.listOrders(req.user.id, req.query);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.getOrder = async (req, res) => {
  try {
    const data = await commerceService.getOrderById(req.params.id, req.user);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.createOrder = async (req, res) => {
  try {
    const {
      sellerId,
      currency,
      paymentTerms,
      taxRate,
      notes,
      dataNFTId,
      lineItems,
    } = req.body;

    let items = Array.isArray(lineItems) ? lineItems : [];
    let resolvedSellerId = sellerId;

    if (dataNFTId) {
      const dataNFT = await prisma.dataNFT.findUnique({ where: { id: dataNFTId } });
      if (!dataNFT || !dataNFT.isPublished) {
        return res.status(404).json({ status: 'fail', message: 'Published dataset not found' });
      }
      resolvedSellerId = resolvedSellerId || dataNFT.merchantId;
      if (!items.length) {
        items = [{
          description: `Dataset license: ${dataNFT.name}`,
          category: 'dataset_license',
          quantity: 1,
          unit: 'license',
          unitPrice: dataNFT.price,
        }];
      }
    }

    if (!resolvedSellerId) {
      resolvedSellerId = await commerceService.findDefaultSellerId(prisma, null);
    }
    if (!resolvedSellerId) {
      return res.status(400).json({ status: 'fail', message: 'Seller is required' });
    }

    const bundle = await commerceService.createOrderBundle(prisma, {
      buyerId: req.user.id,
      sellerId: resolvedSellerId,
      currency,
      paymentTerms,
      taxRate,
      notes,
      dataNFTId,
      lineItems: items,
    });

    res.status(201).json({ status: 'success', data: bundle });
  } catch (error) {
    sendError(res, error);
  }
};

exports.uploadContract = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'fail', message: 'Contract file is required' });
    }
    const data = await commerceService.attachContract(
      req.user,
      req.params.id,
      publicFilePath(req.file, 'contracts'),
    );
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.listInvoices = async (req, res) => {
  try {
    const data = await commerceService.listInvoices(req.user.id, req.query);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.getInvoice = async (req, res) => {
  try {
    const data = await commerceService.getInvoiceById(req.params.id, req.user);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.downloadInvoicePdf = async (req, res) => {
  try {
    const invoice = await commerceService.getInvoiceById(req.params.id, req.user);
    const { absolutePath } = await getOrCreateInvoicePdf(invoice);
    res.download(absolutePath, path.basename(absolutePath));
  } catch (error) {
    sendError(res, error);
  }
};

exports.listPayments = async (req, res) => {
  try {
    const data = await commerceService.listPayments(req.user.id, req.query);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.getPayment = async (req, res) => {
  try {
    const data = await commerceService.getPaymentById(req.params.id, req.user);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.createPayment = async (req, res) => {
  try {
    const data = await commerceService.recordPayment(req.user, {
      invoiceId: req.body.invoiceId,
      orderId: req.body.orderId,
      amount: req.body.amount,
      currency: req.body.currency,
      method: req.body.method,
      reference: req.body.reference,
      notes: req.body.notes,
      paidAt: req.body.paidAt,
      slipPath: publicFilePath(req.file, 'slips'),
    });
    res.status(201).json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.confirmPayment = async (req, res) => {
  try {
    const data = await commerceService.confirmPayment(req.user, req.params.id);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};

exports.rejectPayment = async (req, res) => {
  try {
    const data = await commerceService.rejectPayment(req.user, req.params.id, req.body.notes);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
};
