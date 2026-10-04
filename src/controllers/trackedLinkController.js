const service = require('../services/trackedLink');
const { createLogger } = require('../utils/logger');

const logger = createLogger('trackedLinkController');

/**
 * A 4xx is one of the service's own errors: its code and message are written for the caller.
 * Anything else is unexpected, usually a Prisma error, whose message carries the query, the
 * server's file paths and source lines, or the database host. Two of these routes are public, so
 * that text goes to the server log only and the caller gets a plain 500.
 */
function sendError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) {
    logger.error('Tracked link request failed', error);
    return res.status(status).json({ status: 'error', message: 'Server error' });
  }
  return res.status(status).json({ status: 'fail', code: error.code, message: error.message });
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
