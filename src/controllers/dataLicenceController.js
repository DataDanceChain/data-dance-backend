const {
  getConsent,
  grantConsent,
  withdrawConsent,
  isCEndSubject,
} = require('../services/dataLicenceConsent');

function requireSubject(req, res) {
  if (!isCEndSubject(req.user)) {
    res.status(403).json({
      status: 'fail',
      code: 'subject_consent_required',
      message: 'Only the data subject can manage this consent in the Wallet app.',
    });
    return false;
  }
  return true;
}

exports.getDataLicence = async (req, res) => {
  try {
    if (!requireSubject(req, res)) return;
    return res.json({ status: 'success', data: await getConsent(req.user.id) });
  } catch (error) {
    console.error('Get data licence consent error:', error);
    return res.status(500).json({ status: 'error', message: 'Could not load consent' });
  }
};

exports.grantDataLicence = async (req, res) => {
  try {
    if (!requireSubject(req, res)) return;
    if (req.body?.accepted === false) {
      return res.json({ status: 'success', data: await withdrawConsent(req.user.id) });
    }
    if (req.body?.accepted !== true) {
      return res.status(400).json({
        status: 'fail',
        message: 'You need to accept the data licence to continue',
      });
    }
    const source = req.body?.source === 'settings' ? 'settings' : 'connect';
    return res.json({ status: 'success', data: await grantConsent(req.user.id, source) });
  } catch (error) {
    console.error('Grant data licence consent error:', error);
    return res.status(500).json({ status: 'error', message: 'Could not save consent' });
  }
};

exports.withdrawDataLicence = async (req, res) => {
  try {
    if (!requireSubject(req, res)) return;
    return res.json({ status: 'success', data: await withdrawConsent(req.user.id) });
  } catch (error) {
    console.error('Withdraw data licence consent error:', error);
    return res.status(500).json({ status: 'error', message: 'Could not withdraw consent' });
  }
};
