const {
  acceptPartnerBatch,
  getPartnerItem,
  processItem,
  disburseRedemption,
  listItems,
  publicItem,
  publicBatch,
} = require('../services/disbursement/service');
const { partnerKeyMatches, partnerKeyFor } = require('../services/disbursement/policy');

function sendError(res, error) {
  const status = error.statusCode || 500;
  return res.status(status).json({
    status: status >= 500 ? 'error' : 'fail',
    code: error.code,
    message: error.message || 'Server error',
  });
}

function requirePartnerKey(req, res, next) {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!partnerKeyFor(slug)) {
    return res.status(503).json({
      status: 'error',
      code: 'partner_key_unconfigured',
      message: 'Partner disbursement key is not configured',
    });
  }
  const presented = req.get('x-partner-key') || '';
  if (!partnerKeyMatches(slug, presented)) {
    return res.status(401).json({
      status: 'fail',
      code: 'invalid_partner_key',
      message: 'Partner key is invalid',
    });
  }
  return next();
}

async function submitBatch(req, res) {
  try {
    const result = await acceptPartnerBatch(req.params.slug, {
      batchId: req.body?.batchId,
      items: req.body?.items,
    });
    res.status(result.replayed ? 200 : 201).json({
      status: 'success',
      data: {
        replayed: result.replayed,
        recordClass: 'partner_volume',
        countsAsDataUpload: false,
        batch: publicBatch(result.batch),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function showItem(req, res) {
  try {
    const item = await getPartnerItem(req.params.slug, req.params.payoutId);
    res.json({ status: 'success', data: publicItem(item) });
  } catch (error) {
    sendError(res, error);
  }
}

async function retryItem(req, res) {
  try {
    const item = await getPartnerItem(req.params.slug, req.params.payoutId);
    const processed = await processItem(item.id);
    res.json({ status: 'success', data: publicItem(processed) });
  } catch (error) {
    sendError(res, error);
  }
}

async function opsList(req, res) {
  try {
    const data = await listItems({
      origin: req.query.origin,
      partnerSlug: req.query.partner,
      limit: req.query.limit,
    });
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
}

async function opsRetry(req, res) {
  try {
    const processed = await processItem(req.params.id);
    res.json({ status: 'success', data: publicItem(processed) });
  } catch (error) {
    sendError(res, error);
  }
}

async function disburse(req, res) {
  try {
    const result = await disburseRedemption(req.user, req.params.id, {
      walletAddress: req.body?.walletAddress,
    });
    res.status(201).json({
      status: 'success',
      data: {
        redemptionId: result.redemption.id,
        disbursement: publicItem(result.item),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function opsDisburse(req, res) {
  try {
    const result = await disburseRedemption(null, req.params.id, {
      walletAddress: req.body?.walletAddress,
    });
    res.status(201).json({
      status: 'success',
      data: {
        redemptionId: result.redemption.id,
        disbursement: publicItem(result.item),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  requirePartnerKey,
  submitBatch,
  showItem,
  retryItem,
  opsList,
  opsRetry,
  disburse,
  opsDisburse,
};
