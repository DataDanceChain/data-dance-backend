const service = require('../services/trackedLink');

function sendError(res, error) {
  const status = error.statusCode || 500;
  return res.status(status).json({
    status: status >= 500 ? 'error' : 'fail',
    code: error.code,
    message: error.message || 'Server error',
  });
}

async function list(req, res) {
  try {
    const data = await service.listLinks();
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const data = await service.createLink(req.body || {});
    res.status(201).json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const data = await service.updateLink(req.params.id, req.body || {});
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
}

async function detail(req, res) {
  try {
    const data = await service.linkStats(req.params.id);
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
}

async function showPublic(req, res) {
  try {
    const data = await service.publicLink(req.params.slug);
    if (!data) {
      return res.status(404).json({ status: 'fail', code: 'link_not_found', message: 'Link not found' });
    }
    return res.json({ status: 'success', data });
  } catch (error) {
    return sendError(res, error);
  }
}

async function recordPublic(req, res) {
  try {
    const data = await service.recordHit(req.params.slug, {
      visitorId: req.body?.visitorId,
      event: req.body?.event,
      dest: req.body?.dest,
      referrer: req.get('referer'),
    });
    res.json({ status: 'success', data });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  create,
  update,
  detail,
  showPublic,
  recordPublic,
};
