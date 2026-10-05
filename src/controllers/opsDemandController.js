const demandService = require('../services/demandService');

function actorId(req) {
  return req.opsAdmin?.username || req.user?.id || 'ops';
}

exports.list = async (req, res) => {
  try {
    const data = await demandService.listOps({
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.get = async (req, res) => {
  try {
    const data = await demandService.getOps(req.params.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.quote = async (req, res) => {
  try {
    const data = await demandService.quoteDemand(req.params.id, actorId(req), req.body || {});
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.decline = async (req, res) => {
  try {
    const data = await demandService.declineDemand(
      req.params.id,
      actorId(req),
      req.body?.reason || req.body?.note,
    );
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.assemble = async (req, res) => {
  try {
    const data = await demandService.markAssembling(req.params.id, actorId(req), req.body?.note);
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.fulfill = async (req, res) => {
  try {
    const data = await demandService.fulfillDemand(req.params.id, actorId(req), {
      dataNFTId: req.body?.dataNFTId,
    });
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};
