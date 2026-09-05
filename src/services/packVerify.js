const { normalizeEmail, isValidEmail } = require('../utils/emailMask');
const {
  buildMembershipIndex,
  matchMembership,
  maskEmailOne,
} = require('../utils/packRecords');

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function cacheKey(dataNFT) {
  const updated = dataNFT?.updatedAt ? new Date(dataNFT.updatedAt).getTime() : 0;
  return `${dataNFT.id}:${updated}`;
}

function indexFor(dataNFT) {
  const key = cacheKey(dataNFT);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.index;

  const index = buildMembershipIndex(dataNFT.dataRecords);
  cache.set(key, { index, expires: now + CACHE_MS });
  if (cache.size > 40) {
    for (const [oldKey, value] of cache) {
      if (value.expires <= now) cache.delete(oldKey);
    }
  }
  return index;
}

function verifyPackMembership(dataNFT, { email, recordId } = {}) {
  const normalized = email ? normalizeEmail(email) : '';
  const id = recordId != null ? String(recordId).trim() : '';

  if (!normalized && !id) {
    const error = new Error('Enter an email you already have.');
    error.status = 400;
    error.code = 'verify_input_required';
    throw error;
  }
  if (normalized && !isValidEmail(normalized)) {
    const error = new Error('Enter a valid email.');
    error.status = 400;
    error.code = 'verify_email_invalid';
    throw error;
  }

  const inPack = matchMembership(indexFor(dataNFT), { email: normalized, recordId: id });
  if (!inPack) return { inPack: false };
  if (normalized) {
    return { inPack: true, emailMasked: maskEmailOne(normalized) };
  }
  return { inPack: true };
}

module.exports = {
  verifyPackMembership,
  indexFor,
};
