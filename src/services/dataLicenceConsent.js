const prisma = require('../utils/prisma');
const { DATA_LICENCE_POLICY_VERSION, serializeConsent } = require('../constants/dataLicence');

const C_END_SOURCES = new Set(['connect', 'settings', 'acquired']);

function isCEndSubject(user) {
  if (!user) return false;
  if (user.isOrganization) return false;
  if (user.userType === 'organization') return false;
  return true;
}

function normalizeCEndSource(source) {
  return C_END_SOURCES.has(source) ? source : 'connect';
}

async function getConsent(userId) {
  const row = await prisma.dataLicenceConsent.findUnique({ where: { userId } });
  return serializeConsent(row);
}

async function hasActiveConsent(userId) {
  const status = await getConsent(userId);
  return status.granted;
}

async function grantConsent(userId, source = 'connect') {
  const row = await prisma.dataLicenceConsent.upsert({
    where: { userId },
    create: {
      userId,
      policyVersion: DATA_LICENCE_POLICY_VERSION,
      source: normalizeCEndSource(source),
      grantedAt: new Date(),
      withdrawnAt: null,
    },
    update: {
      policyVersion: DATA_LICENCE_POLICY_VERSION,
      source: normalizeCEndSource(source),
      grantedAt: new Date(),
      withdrawnAt: null,
    },
  });
  return serializeConsent(row);
}

async function withdrawConsent(userId) {
  const existing = await prisma.dataLicenceConsent.findUnique({ where: { userId } });
  if (!existing || existing.withdrawnAt) {
    return serializeConsent(existing);
  }
  const row = await prisma.dataLicenceConsent.update({
    where: { userId },
    data: { withdrawnAt: new Date() },
  });
  return serializeConsent(row);
}

async function consentedUserIdSet(userIds = []) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const rows = await prisma.dataLicenceConsent.findMany({
    where: {
      userId: { in: ids },
      withdrawnAt: null,
      policyVersion: DATA_LICENCE_POLICY_VERSION,
    },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}

function recordEmail(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.email) return String(record.email).trim().toLowerCase();
  if (record.user?.email) return String(record.user.email).trim().toLowerCase();
  const key = Object.keys(record).find((name) => /email|邮箱|mail/i.test(name));
  return key ? String(record[key] || '').trim().toLowerCase() : '';
}

async function consentedEmailSet(emails = []) {
  const normalized = [...new Set(emails.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) return new Set();
  const users = await prisma.user.findMany({
    where: {
      OR: normalized.map((email) => ({ email: { equals: email, mode: 'insensitive' } })),
    },
    select: { id: true, email: true },
  });
  const allowedIds = await consentedUserIdSet(users.map((user) => user.id));
  return new Set(
    users
      .filter((user) => allowedIds.has(user.id) && user.email)
      .map((user) => String(user.email).trim().toLowerCase()),
  );
}

function recordsFromPack(dataNFT) {
  const raw = dataNFT?.dataRecords;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.records)) return raw.records;
  return [];
}

async function assertPackHasLicensableRecords(dataNFT) {
  const rows = recordsFromPack(dataNFT);
  if (dataNFT?.dataSource === 'upload' || rows.length) {
    const licensable = await filterLicensableRecords(rows);
    return { ok: licensable.length > 0, licensable };
  }
  return { ok: true, licensable: [] };
}

async function filterLicensableRecords(records = []) {
  const rows = Array.isArray(records) ? records : [];
  const userIds = rows.map((row) => row?.userId || row?.user?.id).filter(Boolean);
  const emails = rows.map(recordEmail);
  const [allowedIds, allowedEmails] = await Promise.all([
    consentedUserIdSet(userIds),
    consentedEmailSet(emails),
  ]);
  return rows.filter((row) => {
    const id = row?.userId || row?.user?.id;
    if (id && allowedIds.has(id)) return true;
    const email = recordEmail(row);
    return Boolean(email && allowedEmails.has(email));
  });
}

module.exports = {
  isCEndSubject,
  normalizeCEndSource,
  getConsent,
  hasActiveConsent,
  grantConsent,
  withdrawConsent,
  consentedUserIdSet,
  consentedEmailSet,
  filterLicensableRecords,
  recordsFromPack,
  assertPackHasLicensableRecords,
  recordEmail,
};
