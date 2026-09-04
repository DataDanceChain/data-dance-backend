const prisma = require('../utils/prisma');
const { DATA_LICENCE_POLICY_VERSION } = require('../constants/dataLicence');

const DAY_MS = 24 * 60 * 60 * 1000;
const REPLY_DAYS = 40;

function serialize(row) {
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  const ageDays = Math.floor((Date.now() - createdAt.getTime()) / DAY_MS);
  return {
    id: row.id,
    kind: row.kind,
    detail: row.detail,
    status: row.status,
    opsNote: row.opsNote,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ageDays,
    overdue: row.status === 'open' && ageDays >= REPLY_DAYS,
    user: row.user
      ? {
          id: row.user.id,
          email: row.user.email,
          name: row.user.name,
          createdAt: row.user.createdAt,
        }
      : null,
    consent: row.user?.dataLicenceConsent
      ? {
          granted: !row.user.dataLicenceConsent.withdrawnAt
            && row.user.dataLicenceConsent.policyVersion === DATA_LICENCE_POLICY_VERSION,
          grantedAt: row.user.dataLicenceConsent.grantedAt,
          withdrawnAt: row.user.dataLicenceConsent.withdrawnAt,
        }
      : { granted: false, grantedAt: null, withdrawnAt: null },
  };
}

const INCLUDE = {
  user: {
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      dataLicenceConsent: {
        select: { policyVersion: true, grantedAt: true, withdrawnAt: true },
      },
    },
  },
};

exports.listPrivacyRequests = async (req, res) => {
  try {
    const status = String(req.query.status || 'open');
    const where = status === 'all' ? {} : { status };
    const items = await prisma.privacyRequest.findMany({
      where,
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 80,
    });
    return res.json({ status: 'success', data: items.map(serialize) });
  } catch (error) {
    console.error('Ops list privacy requests error:', error);
    return res.status(500).json({ status: 'error', message: 'Could not load privacy requests' });
  }
};

exports.resolvePrivacyRequest = async (req, res) => {
  try {
    const next = String(req.body?.status || '');
    if (next !== 'done' && next !== 'rejected') {
      return res.status(400).json({ status: 'fail', message: 'Mark the request done or rejected.' });
    }
    const note = String(req.body?.note || '').trim().slice(0, 2000);
    if (next === 'rejected' && !note) {
      return res.status(400).json({ status: 'fail', message: 'Add a short note when rejecting.' });
    }
    const existing = await prisma.privacyRequest.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!existing) {
      return res.status(404).json({ status: 'fail', message: 'Request not found' });
    }
    const row = await prisma.privacyRequest.update({
      where: { id: existing.id },
      data: {
        status: next,
        opsNote: note || existing.opsNote,
        resolvedAt: new Date(),
        resolvedBy: req.opsAdmin?.username || 'ops',
      },
      include: INCLUDE,
    });
    return res.json({ status: 'success', data: serialize(row) });
  } catch (error) {
    console.error('Ops resolve privacy request error:', error);
    return res.status(500).json({ status: 'error', message: 'Could not update this request' });
  }
};
