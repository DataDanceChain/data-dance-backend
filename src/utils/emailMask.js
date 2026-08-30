function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function maskEmail(email) {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at < 1 || !value.slice(at + 1)) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const keep = Math.min(2, local.length);
  return `${local.slice(0, keep)}***@${domain}`;
}

function stripEmail(row) {
  if (!row) return row;
  const { email, ...rest } = row;
  return {
    ...rest,
    emailMasked: maskEmail(email),
  };
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  maskEmail,
  stripEmail,
};
