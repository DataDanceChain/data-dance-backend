const crypto = require('crypto');
const { normalizeEmail, isValidEmail } = require('./emailMask');

const ID_KEYS = [
  'order-id',
  'orderId',
  'Order ID',
  'order_id',
  'amazon-order-id',
  'amazonOrderId',
  'externalId',
  'recordId',
];

function asRecords(dataRecords) {
  if (Array.isArray(dataRecords)) return dataRecords;
  if (dataRecords && typeof dataRecords === 'object' && Array.isArray(dataRecords.records)) {
    return dataRecords.records;
  }
  return [];
}

function emailFieldName(dataRecords) {
  if (dataRecords && typeof dataRecords === 'object' && dataRecords.emailField) {
    return dataRecords.emailField;
  }
  return 'email';
}

function rowEmail(row, field) {
  if (!row || typeof row !== 'object') return '';
  return normalizeEmail(row.email || row[field] || row['buyer-email']);
}

function rowStableId(row) {
  if (!row || typeof row !== 'object') return '';
  for (const key of ID_KEYS) {
    const value = row[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function emailsFromRecords(dataRecords) {
  const field = emailFieldName(dataRecords);
  const emails = [];
  const seen = new Set();
  for (const row of asRecords(dataRecords)) {
    const email = rowEmail(row, field);
    if (!email || !isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

function sha256buf(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function constantIncludes(hashes, queryHash) {
  let found = false;
  for (const hash of hashes) {
    if (hash.length === queryHash.length && crypto.timingSafeEqual(hash, queryHash)) {
      found = true;
    }
  }
  if (!hashes.length) {
    crypto.timingSafeEqual(queryHash, queryHash);
  }
  return found;
}

function maskEmailOne(email) {
  const value = normalizeEmail(email);
  const at = value.indexOf('@');
  if (at < 1 || !value.slice(at + 1)) return '***';
  return `${value.slice(0, 1)}***@${value.slice(at + 1)}`;
}

function buildMembershipIndex(dataRecords) {
  const field = emailFieldName(dataRecords);
  const emailHashes = [];
  const idHashes = [];
  const pairHashes = [];
  const seenEmail = new Set();
  const seenId = new Set();
  const seenPair = new Set();

  for (const row of asRecords(dataRecords)) {
    const email = rowEmail(row, field);
    const id = rowStableId(row);
    if (email && isValidEmail(email) && !seenEmail.has(email)) {
      seenEmail.add(email);
      emailHashes.push(sha256buf(email));
    }
    if (id && !seenId.has(id)) {
      seenId.add(id);
      idHashes.push(sha256buf(id));
    }
    if (email && isValidEmail(email) && id) {
      const pair = `${email}|${id}`;
      if (!seenPair.has(pair)) {
        seenPair.add(pair);
        pairHashes.push(sha256buf(pair));
      }
    }
  }

  return { emailHashes, idHashes, pairHashes };
}

function matchMembership(index, { email, recordId }) {
  const normalized = email ? normalizeEmail(email) : '';
  const id = recordId != null ? String(recordId).trim() : '';
  if (normalized && id) {
    return constantIncludes(index.pairHashes, sha256buf(`${normalized}|${id}`));
  }
  if (normalized) {
    return constantIncludes(index.emailHashes, sha256buf(normalized));
  }
  if (id) {
    return constantIncludes(index.idHashes, sha256buf(id));
  }
  return false;
}

function rowFingerprint(row, field) {
  const email = rowEmail(row, field);
  const id = rowStableId(row);
  if (email && id) return `${email}|${id}`;
  const copy = { ...(row || {}) };
  delete copy.recordId;
  return sha256buf(JSON.stringify(copy)).toString('hex');
}

module.exports = {
  asRecords,
  emailFieldName,
  rowEmail,
  rowStableId,
  emailsFromRecords,
  sha256buf,
  constantIncludes,
  maskEmailOne,
  buildMembershipIndex,
  matchMembership,
  rowFingerprint,
};
