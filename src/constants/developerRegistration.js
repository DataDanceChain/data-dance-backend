/**
 * Self-serve SSO client registration switch: SSO_DEVELOPER_REGISTRATION = off | on | allowlist.
 *
 *   off        the default, also when unset or blank. POST /api/developer/sso/clients answers a
 *              caller without a token 403 registration_closed before any database access, so it
 *              writes nothing. A caller with a token goes through the login check: an account with
 *              the developer or ddc_admin role (src/services/userRoles.js) may still register; any
 *              other account gets the same 403. Clients that already exist keep working: sign-in,
 *              the token exchange and the partner API never consult this switch.
 *   on         a signed-in DataDance account may register a client: the route requires a user JWT
 *              (anonymous: 401) and is rate-limited per IP. A self-serve console must send the
 *              user's token.
 *   allowlist  as on (anonymous: 401), but only the accounts named in SSO_DEVELOPER_ALLOWED_EMAILS
 *              may register, and only from a verified login e-mail (below). An account with the
 *              developer or ddc_admin role may also register, as in off. Every other signed-in
 *              account gets the same 403 registration_closed body as off, so the answer never tells
 *              whether an address is on the list. An empty list admits nobody but those roles.
 *
 * SSO_DEVELOPER_ALLOWED_EMAILS: comma-separated DataDance account e-mails, compared trimmed and
 * case-insensitively with the e-mail of the account `protect` loaded (never with anything in the
 * request body). Read only in allowlist mode.
 *
 * Verified login e-mail. The User row has no e-mail-verified flag and Web3Auth ID tokens carry no
 * `email_verified` claim; WEB3AUTH_EMAIL_TRUSTED_VERIFIERS (the login connections that verify the
 * address themselves: Google, e-mail passwordless, which is the e-mail one-time-code login, and
 * Apple) is what the codebase uses instead (src/services/web3authIdentity.js, network re-bind). An
 * account's e-mail counts as verified only when all three hold:
 *   1. the session came from a verified Web3Auth login: the JWT carries `ver >= 2`, the test
 *      SSO_REQUIRE_VERIFIED_SESSION uses. Password sessions and legacy body-asserted sessions fail;
 *   2. the account is linked to a connection listed in WEB3AUTH_EMAIL_TRUSTED_VERIFIERS
 *      (User.web3authVerifier; external-wallet never counts, its e-mail column holds an address);
 *   3. the identity that connection proved is that address: User.web3authVerifierId equals the
 *      account e-mail, case-insensitively. A legacy row linked through the wallet its token proved
 *      keeps the e-mail a request body once carried; this rule does not count that e-mail.
 *
 * Read once, at boot (initDeveloperRegistration, called from server.js), together with the list and
 * WEB3AUTH_EMAIL_TRUSTED_VERIFIERS. Changing the environment of a running process changes nothing
 * until it restarts. In production the process refuses to start on a mode other than these three,
 * and in allowlist mode on a list entry that is not an e-mail address; elsewhere either is one
 * warning and reads as closed. An empty list, or no trusted connection, is a warning: closed.
 */

const MODES = Object.freeze(['off', 'on', 'allowlist']);

// Mirrored from src/services/web3authIdentity.js rather than imported: that module pulls jose and
// its own boot configuration into a constants file (src/constants/partnerClient.js does the same).
const EXTERNAL_WALLET_VERIFIER = 'external-wallet';

// The shape src/services/ssoDeveloperClient.js accepts for contact_email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function csv(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The list as configured: lower-cased, de-duplicated. `problem` names the positions of entries that
 * are not e-mail addresses (positions only: the boot log never prints an address).
 */
function parseAllowedEmails(raw) {
  const entries = csv(raw).map((entry) => entry.toLowerCase());
  const bad = entries
    .map((entry, index) => (entry.length <= 254 && EMAIL_PATTERN.test(entry) ? null : `#${index + 1}`))
    .filter(Boolean);
  if (bad.length) {
    return {
      emails: [],
      problem: `SSO_DEVELOPER_ALLOWED_EMAILS ${bad.length === 1 ? 'entry' : 'entries'} ${bad.join(', ')} ` +
        'must be an e-mail address (comma-separated list)',
    };
  }
  return { emails: [...new Set(entries)], problem: null };
}

const CLOSED_STATE = { mode: 'off', open: false, allowedEmails: [], trustedVerifiers: [] };

/**
 * Pure: what the environment asks for, always on the closed side when something is wrong.
 *   mode              off | on | allowlist
 *   open              true only for on (any signed-in account)
 *   allowedEmails     allowlist only: the listed e-mails, lower-cased
 *   trustedVerifiers  allowlist only: WEB3AUTH_EMAIL_TRUSTED_VERIFIERS without external-wallet
 *   problem           a value production refuses to start on (an unknown mode, an unparsable list)
 *   warnings          values that start, but deserve a line in the log
 */
function readDeveloperRegistration(env = process.env) {
  const raw = String(env.SSO_DEVELOPER_REGISTRATION ?? '').trim();
  const value = raw.toLowerCase();
  const listSet = String(env.SSO_DEVELOPER_ALLOWED_EMAILS ?? '').trim() !== '';
  if (value && !MODES.includes(value)) {
    return {
      ...CLOSED_STATE,
      problem: `SSO_DEVELOPER_REGISTRATION must be "off", "on" or "allowlist" (got "${raw}")`,
      warnings: [],
    };
  }
  const mode = value || 'off';
  if (mode !== 'allowlist') {
    return {
      ...CLOSED_STATE,
      mode,
      open: mode === 'on',
      problem: null,
      warnings: listSet ? [`SSO_DEVELOPER_ALLOWED_EMAILS is ignored unless SSO_DEVELOPER_REGISTRATION=allowlist (it is "${mode}")`] : [],
    };
  }

  const { emails, problem } = parseAllowedEmails(env.SSO_DEVELOPER_ALLOWED_EMAILS);
  const trustedVerifiers = csv(env.WEB3AUTH_EMAIL_TRUSTED_VERIFIERS).filter((v) => v !== EXTERNAL_WALLET_VERIFIER);
  const warnings = [];
  if (!problem && !emails.length) {
    warnings.push('SSO_DEVELOPER_REGISTRATION=allowlist with an empty SSO_DEVELOPER_ALLOWED_EMAILS: registration stays closed');
  }
  if (!problem && emails.length && !trustedVerifiers.length) {
    warnings.push(
      'SSO_DEVELOPER_REGISTRATION=allowlist but WEB3AUTH_EMAIL_TRUSTED_VERIFIERS names no login connection: ' +
        'no account has a verified login e-mail, so registration stays closed',
    );
  }
  return { mode, open: false, allowedEmails: emails, trustedVerifiers, problem, warnings };
}

/** For the boot line: closed | open | allowlist:<number of listed e-mails>. Never an address. */
function describeDeveloperRegistration(state) {
  if (state.mode === 'on') return 'open';
  if (state.mode === 'allowlist') return `allowlist:${state.allowedEmails.length}`;
  return 'closed';
}

function defaultLog() {
  // Required here, not at the top: building a logger opens the log files, and this module is
  // otherwise free of side effects.
  return require('../utils/logger').createLogger('developerRegistration');
}

function freeze(state) {
  return Object.freeze({
    mode: state.mode,
    open: state.open,
    allowedEmails: Object.freeze([...state.allowedEmails]),
    trustedVerifiers: Object.freeze([...state.trustedVerifiers]),
  });
}

let snapshot = null;

/**
 * Boot: read the switch once and keep it until the process restarts. Throws in production on an
 * unknown mode, or in allowlist mode on a list entry that is not an e-mail address, so the process
 * refuses to start; elsewhere warns and reads it as closed. Other findings are warnings.
 */
function initDeveloperRegistration({ env = process.env, log } = {}) {
  const state = readDeveloperRegistration(env);
  let resolved = log || null;
  const logger = () => resolved || (resolved = defaultLog());
  if (state.problem) {
    if (env.NODE_ENV === 'production') throw new Error(`${state.problem}; refusing to start`);
    const fallback = state.mode === 'allowlist' ? 'reading the list as empty (closed)' : 'reading it as "off"';
    logger().warn('developer_registration.invalid_value', `${state.problem}; ${fallback}`);
  }
  for (const warning of state.warnings) logger().warn('developer_registration.config', warning);
  snapshot = freeze(state);
  return snapshot;
}

function current() {
  if (!snapshot) snapshot = freeze(readDeveloperRegistration());
  return snapshot;
}

/** off | on | allowlist. Read from process.env on first use if boot did not get to it. */
function developerRegistrationMode() {
  return current().mode;
}

/** Whether any signed-in account may register (mode on). */
function developerRegistrationOpen() {
  return current().open;
}

/**
 * Whether the account `protect` loaded may register now, and why not. Called after `protect`, so
 * `user` is the account row and `claims` the verified JWT. Never reads the request body.
 *   { allowed: true } | { allowed: false, reason: closed | not_listed | session_not_verified |
 *                                                   connection_not_trusted | email_not_login_identity }
 * The route adds one allowlist rule on top (src/routes/developerSsoRoutes.js modeDecision): a
 * session issued before the account's last disable / enable does not count (session_revoked).
 */
function registrationDecision(user, claims, state = current()) {
  if (state.mode === 'on') return { allowed: true };
  if (state.mode !== 'allowlist') return { allowed: false, reason: 'closed' };
  const email = normalizeEmail(user && user.email);
  if (!email || !state.allowedEmails.includes(email)) return { allowed: false, reason: 'not_listed' };
  if (!(Number(claims && claims.ver) >= 2)) return { allowed: false, reason: 'session_not_verified' };
  const verifier = user.web3authVerifier;
  if (typeof verifier !== 'string' || verifier === EXTERNAL_WALLET_VERIFIER || !state.trustedVerifiers.includes(verifier)) {
    return { allowed: false, reason: 'connection_not_trusted' };
  }
  if (normalizeEmail(user.web3authVerifierId) !== email) return { allowed: false, reason: 'email_not_login_identity' };
  return { allowed: true };
}

module.exports = {
  readDeveloperRegistration,
  describeDeveloperRegistration,
  initDeveloperRegistration,
  developerRegistrationMode,
  developerRegistrationOpen,
  registrationDecision,
};
