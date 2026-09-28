/**
 * Invite codes are SHOWN as "DDC-XXXXXX" (decision 36, Sloan 2026-09-28) but STORED bare
 * ("XXXXXX"). The backend is the one place that adds and strips the prefix: every response that
 * carries a user's code goes through formatReferralCodeForDisplay, and every code that comes in
 * goes through normalizeReferralCodeInput (to store) or referralCodeLookupValues (to find). The
 * prefix is never stored.
 *
 * Pure functions, no database: safe to require anywhere (referralUtils re-exports them).
 */

// 32 characters. Skip 0/O and 1/I/L so codes stay easy to read aloud.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

const DISPLAY_CODE_PREFIX = 'DDC-';
const DISPLAY_CODE_PREFIX_BARE = 'DDC';

/** A stored display code: exactly 6 characters of ALPHABET (upper case, no prefix). */
function isDisplayCode(code) {
  return typeof code === 'string'
    && code.length === CODE_LENGTH
    && [...code].every((character) => ALPHABET.includes(character));
}

/**
 * The bare 6-character display code `raw` stands for — with or without the "DDC" prefix, any
 * case, spaces and hyphens anywhere — or null when it is not a display code. A prefixed code is
 * 9 characters once folded and a legacy "DD" + 8 code is 10, so the two can never be confused.
 */
function bareDisplayReferralCode(raw) {
  if (raw === null || raw === undefined) return null;
  const folded = String(raw).trim().replace(/[\s-]+/g, '').toUpperCase();
  if (isDisplayCode(folded)) return folded;
  if (
    folded.length === DISPLAY_CODE_PREFIX_BARE.length + CODE_LENGTH
    && folded.startsWith(DISPLAY_CODE_PREFIX_BARE)
  ) {
    const body = folded.slice(DISPLAY_CODE_PREFIX_BARE.length);
    if (isDisplayCode(body)) return body;
  }
  return null;
}

/**
 * A code as received from a client, in the form to store on a Referral row: a display code
 * (prefixed or not) becomes the bare upper-case stored form; anything else (legacy codes, junk)
 * is only trimmed, exactly as before. Empty input → null.
 */
function normalizeReferralCodeInput(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  return bareDisplayReferralCode(text) || text;
}

/** "ABC123" → "DDC-ABC123". Legacy and any other value unchanged; null/undefined → null. */
function formatReferralCodeForDisplay(code) {
  if (code === null || code === undefined) return null;
  return isDisplayCode(code) ? `${DISPLAY_CODE_PREFIX}${code}` : code;
}

/** A shallow copy of a user row with `referralCode` in display form (other fields untouched). */
function withDisplayReferralCode(user) {
  if (!user || typeof user !== 'object' || !('referralCode' in user)) return user;
  return { ...user, referralCode: formatReferralCodeForDisplay(user.referralCode) };
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  DISPLAY_CODE_PREFIX,
  isDisplayCode,
  bareDisplayReferralCode,
  normalizeReferralCodeInput,
  formatReferralCodeForDisplay,
  withDisplayReferralCode,
};
