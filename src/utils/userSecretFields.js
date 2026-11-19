/**
 * The User columns that hold a secret: the password hash, a wallet key (a retired column: a wallet
 * address comes from Web3Auth at sign-in, the server keeps no key and POST /api/users/wallet/import
 * answers 410) and the X sign-in tokens. None of them leaves the server: not in an API answer, a log
 * line or an export, whichever route returns a User row, including a related row (creator,
 * merchant, buyer, owner) and req.user. The columns stay in the schema; code that needs one (the
 * password check at login, the X binding) reads it from its own query.
 *
 * - PUBLIC_USER_SELECT: what a route may load of a user it shows to someone else.
 * - withoutUserSecrets(row): a copy of a User row without these columns, for a row that travels on
 *   (req.user, a partner token's user, an account's own row in its answer).
 * - dropUserSecrets: the application's JSON replacer (app.set('json replacer') in src/app.js), so no
 *   res.json answer carries one of these keys at any depth, whatever a handler selected or included.
 * - The logger masks the same keys in every log line (src/utils/logger.js).
 */

const USER_SECRET_FIELDS = Object.freeze(['password', 'privateKey', 'xAccessToken', 'xRefreshToken']);

const secretFieldSet = new Set(USER_SECRET_FIELDS);

const PUBLIC_USER_SELECT = Object.freeze({
  id: true,
  name: true,
  avatar: true,
  logo: true,
  isOrganization: true,
});

function withoutUserSecrets(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  if (!USER_SECRET_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(row, field))) return row;
  const copy = { ...row };
  for (const field of USER_SECRET_FIELDS) delete copy[field];
  return copy;
}

function dropUserSecrets(key, value) {
  return secretFieldSet.has(key) ? undefined : value;
}

module.exports = { USER_SECRET_FIELDS, PUBLIC_USER_SELECT, withoutUserSecrets, dropUserSecrets };
