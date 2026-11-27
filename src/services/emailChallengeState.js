const crypto = require('node:crypto');
const { sharedAuthStateEnabled, withState } = require('../utils/authWindowStore');

const HOUR_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

function createEmailChallengeState(purpose) {
  const windows = new Map();
  const challenges = new Map();

  function update(kind, key, ttl, now, callback) {
    if (sharedAuthStateEnabled()) {
      return withState('email-' + purpose + '-' + kind, key, ttl, callback);
    }
    const map = kind === 'send' ? windows : challenges;
    const old = map.get(key);
    const { state, value } = callback(old && old.expiry > now ? old.state : null);
    if (state === null) map.delete(key);
    else map.set(key, { state, expiry: now + ttl });
    if (map.size > 5000) {
      for (const [k, entry] of map) {
        if (entry.expiry <= now) map.delete(k);
        if (map.size <= 4000) break;
      }
    }
    return value;
  }

  function digest(key, code) {
    let hash;
    if (sharedAuthStateEnabled()) {
      const secret = process.env.JWT_SECRET;
      if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Shared email state needs a strong signing secret');
      hash = crypto.createHmac('sha256', secret);
    } else {
      hash = crypto.createHash('sha256');
    }
    return hash.update(JSON.stringify(['ddc-email-challenge-v1', purpose, key, code])).digest('hex');
  }

  function reserveSend(email, now) {
    return update('send', email, HOUR_MS, now, old => {
      const timestamps = (old?.timestamps || []).filter(time => now - time < HOUR_MS);
      const last = timestamps[timestamps.length - 1];
      const next = Math.max(last === undefined ? now : last + RESEND_INTERVAL_MS,
        timestamps.length >= MAX_SENDS_PER_HOUR ? timestamps[0] + HOUR_MS : now);
      if (next > now) return { state: { timestamps }, value: Math.ceil((next - now) / 1000) };
      timestamps.push(now);
      return { state: { timestamps }, value: 0 };
    });
  }

  function saveDelivered(key, codeHash, metadata, issuedAt, now) {
    if (now >= issuedAt + CODE_TTL_MS) return false;
    return update('challenge', key, CODE_TTL_MS, now, old => {
      // A slower SMTP completion cannot replace a newer delivered or consumed code.
      if (old && old.issuedAt >= issuedAt) return { state: old, value: false };
      return { state: { issuedAt, codeHash, metadata, attempts: 0 }, value: true };
    });
  }

  function check(key, code, now, consume) {
    const presented = Buffer.from(digest(key, code), 'hex');
    return update('challenge', key, CODE_TTL_MS, now, old => {
      if (!old || !old.codeHash || now >= old.issuedAt + CODE_TTL_MS) return { state: old, value: null };
      const attempts = old.attempts + 1;
      const matched = attempts <= MAX_ATTEMPTS && crypto.timingSafeEqual(Buffer.from(old.codeHash, 'hex'), presented);
      const retire = (matched && consume) || (!matched && attempts >= MAX_ATTEMPTS);
      return {
        state: retire ? { issuedAt: old.issuedAt } : { ...old, attempts },
        value: matched ? { ...old.metadata, issuedAt: old.issuedAt } : null,
      };
    });
  }

  function consumeChecked(key, issuedAt, now) {
    return update('challenge', key, CODE_TTL_MS, now, old => {
      if (!old?.codeHash || old.issuedAt !== issuedAt || now >= issuedAt + CODE_TTL_MS) {
        return { state: old, value: false };
      }
      return { state: { issuedAt }, value: true };
    });
  }

  return { reserveSend, digest, saveDelivered, check, consumeChecked, reset() { windows.clear(); challenges.clear(); } };
}

module.exports = { createEmailChallengeState, CODE_TTL_MS, RESEND_INTERVAL_MS, MAX_SENDS_PER_HOUR, MAX_ATTEMPTS };
