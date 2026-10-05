const demandService = require('../services/demandService');

exports.create = async (req, res) => {
  try {
    const data = await demandService.createDemand(req.user.id, req.body || {});
    return res.status(201).json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.list = async (req, res) => {
  try {
    const data = await demandService.listMine(req.user.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.get = async (req, res) => {
  try {
    const data = await demandService.getMine(req.user.id, req.params.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.cancel = async (req, res) => {
  try {
    const data = await demandService.cancelMine(req.user.id, req.params.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};

exports.accept = async (req, res) => {
  try {
    const data = await demandService.acceptQuote(req.user.id, req.params.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    return demandService.failToHttp(res, error);
  }
};
