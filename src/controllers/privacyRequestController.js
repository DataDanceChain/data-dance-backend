const prisma = require('../utils/prisma');
const { isCEndSubject } = require('../services/dataLicenceConsent');

const KINDS = new Set(['access', 'correct', 'erase']);

function requireSubject(req, res) {
  if (!isCEndSubject(req.user)) {
    res.status(403).json({
      status: 'fail',
      code: 'subject_consent_required',
      message: 'Only the data subject can send this request in the Wallet app.',
    });
    return false;
  }
  return true;
}

exports.listPrivacyRequests = async (req, res) => {
  try {
    if (!requireSubject(req, res)) return;
    const items = await prisma.privacyRequest.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json({ status: 'success', data: items });
  } catch (error) {
    console.error('List privacy requests error:', error);
    return res.status(500).json({ status: 'error', message: 'Could not load requests' });
  }
};

exports.createPrivacyRequest = async (req, res) => {
  try {
    if (!requireSubject(req, res)) return;
    const kind = String(req.body?.kind || '');
    if (!KINDS.has(kind)) {
      return res.status(400).json({ status: 'fail', message: 'Choose access, correct, or erase.' });
    }
    const detail = String(req.body?.detail || '').trim().slice(0, 2000);
    if ((kind === 'correct' || kind === 'erase') && !detail) {
      return res.status(400).json({ status: 'fail', message: 'Please add a short note for this request.' });
    }
    const item = await prisma.privacyRequest.create({
      data: {
        userId: req.user.id,
        kind,
        detail: detail || null,
        status: 'open',
      },
    });
    return res.json({ status: 'success', data: item });
  } catch (error) {
    console.error('Create privacy request error:', error);
    return res.status(500).json({ status: 'error', message: 'Could not send this request' });
  }
};
